import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import type { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { Jj, JjFailed } from "../../clients/jj";
import type { PrDescriptions } from "../../clients/pr-descriptions";
import { asUserError, withHelp } from "../command";
import {
  anyOf,
  changeIdsAt,
  changeRevset,
  changesIn,
  commitsAt,
  logLines,
  SCRATCH,
  type StackChange,
} from "./stack/changes";
import { bookmarksBeforeFetch, pushedOf } from "./stack/combine";
import {
  fetchBranches,
  type MergedChange,
  mergedOnGitHub,
  type NotCombined,
  notMerged,
  reconcile,
  STACK_ROOTS_NOT_ON_TRUNK,
} from "./stack/reconcile";
import { checkedTrunk } from "./stack/trunk";

/**
 * The changes of the stacks that only other workspaces' working copies are on, outside the synced
 * stacks. Unlike `stackRevset`, it keeps another workspace's empty working copy, which is the
 * whole of a stack it just started.
 */
const otherWorkspacesRevset = (synced: string): string =>
  `reachable(working_copies() ~ @, mutable()) ~ (${synced})`;

/** The stack this workspace's working copy is on, and the stacks of the revisions. */
const syncedRevset = (revisions: readonly string[]): string =>
  `reachable(${anyOf(["@", ...revisions])}, mutable())`;

const ORIGIN_BRANCHES = 'remote_bookmarks(remote=exact:"origin")';

const NONE_SKIPPED = { hasBranches: false, revset: "none()" };

/**
 * The stacks that only other workspaces' working copies are on, outside the synced stacks, as the
 * descendants of their bottom changes, which are named by change id. So it follows a change that
 * a jj command in another workspace rewrites meanwhile, and stays one id per stack. A copy of a
 * divergent bottom change on a synced stack stays out. Also says whether any of their changes has
 * a branch, counting one whose local bookmark was deleted.
 */
const skippedStacks = (revisions: readonly string[]) =>
  Effect.gen(function* () {
    const synced = syncedRevset(revisions);
    const others = otherWorkspacesRevset(synced);
    const roots = yield* changeIdsAt(`roots(${others})`);
    if (roots.length === 0) {
      return NONE_SKIPPED;
    }
    const branched = yield* commitsAt(`(${others}) & (bookmarks() | ${ORIGIN_BRANCHES})`);
    return {
      hasBranches: branched.length > 0,
      revset: `((${anyOf(roots.map((root) => changeRevset(root)))}):: & mutable()) ~ (${synced})`,
    };
  });

/**
 * The branches on GitHub that the changes outside the skipped stacks have, including ones whose
 * local bookmark was deleted, which a fetch should still update or remove.
 */
const syncedBranches = (skipped: string) =>
  logLines(
    `(mutable() & ${ORIGIN_BRANCHES}) ~ (${skipped})`,
    String.raw`remote_bookmarks.filter(|b| b.remote() == "origin").map(|b| b.name() ++ "\n").join("")`,
  );

/** The bottom changes of the skipped stacks that sync would rebase, other than empty ones. */
const notSynced = (skipped: string) =>
  changesIn(`(${STACK_ROOTS_NOT_ON_TRUNK}) & (${skipped}) ~ ${SCRATCH}`);

/** `--all-workspaces`, for the commands that sync. */
export const allWorkspacesFlag: Flag.Flag<boolean> = Flag.Boolean("all-workspaces").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Also sync the stacks that only other workspaces' working copies are on"),
);

export interface SyncOptions {
  /** Whether to also sync the stacks that only other workspaces' working copies are on. */
  readonly allWorkspaces: boolean;
  /** Changes known to have merged, which GitHub isn't asked about, with the commits that merged. */
  readonly known?: readonly (MergedChange & Pick<StackChange, "commitId">)[];
  /** The trunk's branch, from `checkedTrunk`. */
  readonly trunk: string;
}

/**
 * Rebases every stack that doesn't conflict onto the fetched trunk, and pushes nothing. Each
 * bookmark is combined with its branch on GitHub first, and each merged change abandoned.
 *
 * Unless `allWorkspaces` is set, it skips the stacks that only other workspaces' working copies
 * are on, and doesn't fetch their branches. The stacks of the known merged changes stay in.
 */
export const sync = ({
  allWorkspaces,
  known = [],
  trunk,
}: SyncOptions): Effect.Effect<
  void,
  GitHubFailed | JjFailed | NotCombined,
  GitHub | Jj | PrDescriptions
> =>
  Effect.gen(function* () {
    // By commit, since a merged change can be divergent with a copy in another workspace's stack.
    const skipped = allWorkspaces
      ? NONE_SKIPPED
      : yield* skippedStacks(known.map(({ commitId }) => commitId));
    const before = yield* bookmarksBeforeFetch(`mutable() ~ (${skipped.revset})`);
    const merged = [
      ...known,
      ...(yield* mergedOnGitHub(before.filter(({ name }) => notMerged(known)(name)))),
    ];
    // Also where the sync fails, which can be after it rebased the stacks.
    const reportNotSynced = Effect.gen(function* () {
      const stacks = yield* notSynced(skipped.revset);
      if (stacks.length > 0) {
        yield* Console.error(
          `didn't sync the stacks that only other workspaces' working copies are on: ${stacks.map((name) => `"${name}"`).join(", ")}; \`jj gh sync --all-workspaces\` syncs them`,
        );
      }
    });
    yield* reconcile({
      before,
      bookmarks: before.map(({ name }) => name),
      fetch: skipped.hasBranches
        ? fetchBranches([
            trunk,
            ...pushedOf(before).map(({ name }) => name),
            ...(yield* syncedBranches(skipped.revset)),
          ])
        : [],
      merged,
      skipped: skipped.revset,
      stacks: "all()",
    }).pipe(
      Effect.ensuring(skipped === NONE_SKIPPED ? Effect.void : Effect.ignore(reportNotSynced)),
    );
  });

export const syncCommand = Command.make(
  "sync",
  {
    allWorkspaces: allWorkspacesFlag,
  },
  ({ allWorkspaces }) =>
    asUserError(
      Effect.gen(function* () {
        const trunk = yield* checkedTrunk;
        yield* sync({ allWorkspaces, trunk });
      }).pipe(Effect.provide(GitHubFromOrigin)),
    ),
).pipe(
  withHelp(
    "Fetch, and rebase the stacks onto the trunk",
    "Fetches, then rebases the unmerged changes onto the trunk, keeping each on the changes below it. Abandons each change whose pull request merged, and forgets its bookmark, unless you edited the change after the merge.",
    "Skips the stacks that only other workspaces' working copies are on, unless you pass `--all-workspaces`. A workspace whose directory you deleted counts until you run `jj workspace forget`. Where the skipped stacks have branches, it fetches only the trunk and the branches of the stacks it syncs.",
    "Leaves a stack that would conflict with the trunk where it was, and names it. When you want to resolve the conflict, rebase it with `jj rebase`. `sync` rebases the rest of a stack whose changes merged even where the rebase conflicts, and records the conflict in the change.",
    "Squashes commits added to a branch on GitHub into the branch's local change, even where that change has local edits too. Where GitHub only rebased a branch, keeps the local change.",
    "Fails before fetching if `trunk()` isn't GitHub's default branch, which `jj-octo init` sets.",
    "Pushes nothing. To update the pull requests of a change and the ones below it, run `jj gh submit`.",
  ),
);
