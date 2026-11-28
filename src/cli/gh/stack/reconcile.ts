import {
  Array as EffectArray,
  Console,
  Effect,
  Record as EffectRecord,
  Schema,
  String as EffectString,
} from "effect";

import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import { Jj, type JjFailed } from "../../../clients/jj";
import { PrDescriptions } from "../../../clients/pr-descriptions";
import { bookmarkTargets } from "./bookmark-targets";
import {
  anyOf,
  bookmarksAt,
  changeRevset,
  changeIdsAt,
  exactPattern,
  STACK_ROOTS,
  type StackChange,
} from "./changes";
import { type BookmarkBeforeFetch, combine, pushedOf } from "./combine";
import { rebaseOntoTrunk } from "./rebase-onto-trunk";

// A stack already on the trunk has nothing to rebase.
export const STACK_ROOTS_NOT_ON_TRUNK = `(${STACK_ROOTS}) ~ children(trunk())`;

export class NotCombined extends Schema.TaggedError<
  NotCombined,
  { readonly brand: unique symbol }
>()("NotCombined", { message: Schema.String }) {}

export const fetchBranches = (branches: readonly string[]): string[] =>
  EffectArray.flatMap([...new Set(branches)], (name) => ["--branch", exactPattern(name)]);

export type MergedChange = Pick<StackChange, "bookmark" | "changeId">;

export const notMerged =
  (merged: readonly MergedChange[]) =>
  (name: string): boolean =>
    EffectArray.every(merged, ({ bookmark }) => bookmark !== name);

export const mergedHeadsOf = (
  bookmarks: readonly BookmarkBeforeFetch[],
): Effect.Effect<Readonly<Record<string, readonly string[]>>, GitHubFailed, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const pushed = pushedOf(bookmarks);
    const heads = yield* Effect.forEach(
      pushed,
      ({ name }) =>
        github.pullRequestsFrom(name).pipe(
          Effect.map((pullRequests) =>
            EffectArray.map(
              EffectArray.filter(pullRequests, ({ state }) => state === "merged"),
              ({ head }) => head,
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return EffectRecord.fromEntries(
      EffectArray.map(pushed, ({ name }, index): readonly [string, readonly string[]] => [
        name,
        heads[index] ?? [],
      ]),
    );
  });

/** `mergedOnGitHub`, from merged heads already read. */
export const mergedIn = (
  bookmarks: readonly BookmarkBeforeFetch[],
  heads: Readonly<Record<string, readonly string[]>>,
): Effect.Effect<readonly MergedChange[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const merged = yield* Effect.forEach(
      bookmarks,
      ({ change, local, name, remote }) =>
        Effect.gen(function* () {
          const merges = heads[name] ?? [];
          const rebasedOnly =
            remote !== undefined &&
            merges.includes(remote) &&
            (yield* jj
              .read(["interdiff", "--from", remote, "--to", local, "--summary"])
              .pipe(Effect.map(EffectString.trim))) === "";
          return merges.includes(local) || rebasedOnly
            ? [{ bookmark: name, changeId: change }]
            : [];
        }),
      // In turn, since `jj interdiff` snapshots the working copy.
      { concurrency: 1 },
    );
    return merged.flat();
  });

/**
 * A change counts where GitHub merged it as it is, or merged its pushed commit, which differs only
 * by a rebase, as after a sync. So a change edited since keeps its edits, and a pull request from
 * an earlier same-named branch doesn't count.
 */
export const mergedOnGitHub = (
  bookmarks: readonly BookmarkBeforeFetch[],
): Effect.Effect<readonly MergedChange[], GitHubFailed | JjFailed, GitHub | Jj> =>
  Effect.flatMap(mergedHeadsOf(bookmarks), (heads) => mergedIn(bookmarks, heads));

/**
 * Passes only names still listed, since a fetch already deleted the bookmark of a branch deleted on
 * GitHub where unchanged locally, and jj warns about missing names.
 */
const forget = (names: readonly string[]) =>
  Effect.gen(function* () {
    const listed = yield* bookmarkTargets;
    const present = EffectArray.filter(names, (name) => listed.has(name));
    if (present.length > 0) {
      const jj = yield* Jj;
      yield* jj.run([
        "bookmark",
        "forget",
        "--include-remotes",
        ...EffectArray.map(present, (name) => exactPattern(name)),
      ]);
    }
  });

interface Reconciliation {
  /** The bookmarks to combine with their branches, as before the fetch. */
  readonly before: readonly BookmarkBeforeFetch[];
  /** The synced stacks' bookmarks, forgotten where they end up on the trunk. */
  readonly bookmarks: readonly string[];
  /** `jj git fetch` options, such as `--branch`. With none, it fetches its default. */
  readonly fetch: readonly string[];
  readonly merged: readonly MergedChange[];
  /** The changes no step rebases, abandons or moves, as a revset read at each step. */
  readonly skipped: string;
  /**
   * A revset holding the bottom change of each stack to rebase, read after the fetch. So it names
   * changes by bookmark or change id, which follow a change replaced with GitHub's.
   */
  readonly stacks: string;
}

/**
 * Fetches, abandons the merged changes, combines each bookmark with its GitHub branch, and rebases
 * the stacks onto the trunk.
 *
 * A squash merge adds the merged work to the trunk as a new commit, leaving the original change
 * under the rest of its stack. Rebased onto the trunk, it can conflict rather than come out empty.
 * So it abandons every merged change, and rebases the rest of that stack even where that
 * conflicts, since its base is gone.
 *
 * A change reaching the trunk another way empties in the rebase, and `--skip-emptied` abandons it,
 * leaving its bookmark on the trunk. So it also forgets every stack bookmark now on the trunk.
 */
export const reconcile = ({
  before,
  bookmarks,
  fetch,
  merged,
  skipped,
  stacks,
}: Reconciliation): Effect.Effect<void, JjFailed | NotCombined, Jj | PrDescriptions> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    yield* jj.run(["git", "fetch", ...fetch]);
    // After the fetch, so it can't bring back as a bookmark a branch GitHub hasn't deleted yet.
    yield* forget(EffectArray.map(merged, ({ bookmark }) => bookmark));
    const mergedRevset = `(${anyOf(EffectArray.map(merged, ({ changeId }) => changeRevset(changeId)))}) & mutable() ~ (${skipped})`;
    const required = yield* changeIdsAt(`(${mergedRevset}):: ~ (${mergedRevset})`);
    if (merged.length > 0) {
      yield* jj.run(["abandon", mergedRevset]);
      yield* Console.error(
        `abandoned the changes whose pull requests merged: ${EffectArray.join(
          EffectArray.map(merged, ({ bookmark }) => bookmark),
          ", ",
        )}`,
      );
    }
    const fetched = yield* bookmarkTargets;
    const notCombined: string[] = [];
    for (const bookmark of EffectArray.filter(before, ({ name }) => notMerged(merged)(name))) {
      if (!(yield* combine(bookmark, fetched.get(bookmark.name)?.origin, skipped))) {
        notCombined.push(bookmark.name);
      }
    }
    yield* rebaseOntoTrunk(
      `((${STACK_ROOTS_NOT_ON_TRUNK}) & (${stacks})) ~ (${skipped})`,
      required,
    );
    const onStacks = new Set(bookmarks);
    const onTrunk = yield* bookmarksAt("::trunk()");
    yield* forget(EffectArray.filter(onTrunk, (name) => onStacks.has(name)));
    const records = yield* PrDescriptions;
    // `bookmarksAt` also lists conflicted bookmarks, which `bookmarkTargets` gives no local target.
    yield* records.prune(Effect.provideService(bookmarksAt("all()"), Jj, jj));
    if (notCombined.length > 0) {
      return yield* NotCombined.make({
        message: EffectArray.join(
          [
            "these bookmarks changed locally and were rewritten on GitHub with different content, so they weren't combined:",
            ...notCombined,
            "`jj bookmark list <name>` shows both sides, and `jj bookmark set <name> -r <revision>` keeps one",
          ],
          "\n",
        ),
      });
    }
  });
