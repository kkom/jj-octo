import { Array as EffectArray, Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import type { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import type { Jj, JjFailed } from "../../clients/jj";
import type { PrDescriptions } from "../../clients/pr-descriptions";
import { asUserError, provideGitHubFromOrigin, withHelp } from "../command";
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

// Unlike `stackRevset`, keeps another workspace's empty working copy, the whole of a stack it just
// started.
const otherWorkspacesRevset = (synced: string): string =>
  `reachable(working_copies() ~ @, mutable()) ~ (${synced})`;

const syncedRevset = (revisions: readonly string[]): string =>
  `reachable(${anyOf(["@", ...revisions])}, mutable())`;

const ORIGIN_BRANCHES = 'remote_bookmarks(remote=exact:"origin")';

const NONE_SKIPPED = { hasBranches: false, revset: "none()" };

// Selects by the bottom changes' change ids, which follow a change that another workspace's jj
// command rewrites meanwhile. A copy of a divergent bottom change on a synced stack stays out.
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
      revset: `((${anyOf(EffectArray.map(roots, (root) => changeRevset(root)))}):: & mutable()) ~ (${synced})`,
    };
  });

// Includes branches whose local bookmark was deleted, which the fetch still updates or removes.
const syncedBranches = (skipped: string) =>
  logLines(
    `(mutable() & ${ORIGIN_BRANCHES}) ~ (${skipped})`,
    String.raw`remote_bookmarks.filter(|b| b.remote() == "origin").map(|b| b.name() ++ "\n").join("")`,
  );

const notSynced = (skipped: string) =>
  changesIn(`(${STACK_ROOTS_NOT_ON_TRUNK}) & (${skipped}) ~ ${SCRATCH}`);

export const allWorkspacesFlag: Flag.Flag<boolean> = Flag.Boolean("all-workspaces").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Also sync the stacks that only other workspaces' working copies are on"),
);

export interface SyncOptions {
  readonly allWorkspaces: boolean;
  /**
   * Merged changes that GitHub isn't asked about. Their stacks sync even without `allWorkspaces`.
   */
  readonly known?: readonly (MergedChange & Pick<StackChange, "commitId">)[];
  /** From `checkedTrunk`. */
  readonly trunk: string;
}

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
    // By commit, since a merged change can diverge with a copy in another workspace's stack.
    const skipped = allWorkspaces
      ? NONE_SKIPPED
      : yield* skippedStacks(EffectArray.map(known, ({ commitId }) => commitId));
    const before = yield* bookmarksBeforeFetch(`mutable() ~ (${skipped.revset})`);
    const merged = [
      ...known,
      ...(yield* mergedOnGitHub(EffectArray.filter(before, ({ name }) => notMerged(known)(name)))),
    ];
    // Also where the sync fails, possibly after rebasing the stacks.
    const reportNotSynced = Effect.gen(function* () {
      const stacks = yield* notSynced(skipped.revset);
      if (stacks.length > 0) {
        yield* Console.error(
          `didn't sync the stacks that only other workspaces' working copies are on: ${EffectArray.join(
            EffectArray.map(stacks, (name) => `"${name}"`),
            ", ",
          )}; \`jj gh sync --all-workspaces\` syncs them`,
        );
      }
    });
    yield* reconcile({
      before,
      bookmarks: EffectArray.map(before, ({ name }) => name),
      fetch: skipped.hasBranches
        ? fetchBranches([
            trunk,
            ...EffectArray.map(pushedOf(before), ({ name }) => name),
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
      }),
    ),
).pipe(
  provideGitHubFromOrigin,
  withHelp(
    "Fetch, and rebase the stacks onto the trunk",
    "Fetches, then rebases the unmerged changes onto the trunk, keeping each on the changes below it. Abandons each change whose pull request merged and forgets its bookmark, unless you edited it after the merge.",
    "Skips stacks only other workspaces' working copies are on, unless you pass `--all-workspaces`. A workspace whose directory you deleted counts until `jj workspace forget`. Where skipped stacks have branches, fetches only the trunk and the synced stacks' branches.",
    "Leaves a stack that would conflict with the trunk in place and names it; rebase it with `jj rebase` when ready. Rebases the rest of a stack whose changes merged even where that conflicts, recording the conflict in the change.",
    "Squashes commits added to a branch on GitHub into its local change, even one with local edits. Where GitHub only rebased a branch, keeps the local change.",
    "Fails before fetching if `trunk()` isn't GitHub's default branch, which `jj-octo init` sets.",
    "Pushes nothing; run `jj gh submit` to update the pull requests.",
  ),
);
