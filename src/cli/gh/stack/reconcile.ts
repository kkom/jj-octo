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
  changeRevset,
  changeIdsAt,
  exactPattern,
  lines,
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
 * Each local bookmark that points at a commit, conflicted ones included, and whether it points at
 * one on the trunk. A conflicted bookmark is on the trunk where any of its commits is, as for
 * `jj bookmark list -r`.
 */
const localBookmarks = Effect.gen(function* () {
  const jj = yield* Jj;
  const listed = yield* jj.read([
    "bookmark",
    "list",
    "-T",
    String.raw`if(!remote && present, name ++ "\t" ++ added_targets.any(|c| c.contained_in("::trunk()")) ++ "\n")`,
  ]);
  return EffectArray.map(lines(listed), (line) => {
    const [name, onTrunk] = EffectString.split(line, "\t");
    return { name, onTrunk: onTrunk === "true" };
  });
});

/**
 * Forgets the bookmarks and their branches on GitHub, in one jj operation. The caller passes only
 * names still listed, since a fetch already deleted the bookmark of a branch deleted on GitHub
 * where unchanged locally, and jj warns about missing names.
 */
const forget = (present: readonly string[]) =>
  Effect.gen(function* () {
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

/** Abandons the merged changes, and returns the ids of the changes on them, which the rebase keeps. */
const abandonMerged = (merged: readonly MergedChange[], skipped: string) =>
  Effect.gen(function* () {
    if (merged.length === 0) {
      return [];
    }
    const jj = yield* Jj;
    const mergedRevset = `(${anyOf(EffectArray.map(merged, ({ changeId }) => changeRevset(changeId)))}) & mutable() ~ (${skipped})`;
    const required = yield* changeIdsAt(`(${mergedRevset}):: ~ (${mergedRevset})`);
    yield* jj.run(["abandon", mergedRevset]);
    yield* Console.error(
      `abandoned the changes whose pull requests merged: ${EffectArray.join(
        EffectArray.map(merged, ({ bookmark }) => bookmark),
        ", ",
      )}`,
    );
    return required;
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
    // Forgetting the merged bookmarks and abandoning their changes leaves the other bookmarks'
    // `origin` targets as the fetch left them, so `forget` and `combine` share this read.
    const fetched = yield* bookmarkTargets;
    // After the fetch, so it can't bring back as a bookmark a branch GitHub hasn't deleted yet.
    yield* forget(
      EffectArray.filter(
        EffectArray.map(merged, ({ bookmark }) => bookmark),
        (name) => fetched.has(name),
      ),
    );
    const required = yield* abandonMerged(merged, skipped);
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
    // Read on first use, and once for `forget` and `prune`.
    const listed = yield* Effect.cached(Effect.provideService(localBookmarks, Jj, jj));
    const forgotten = EffectArray.map(
      EffectArray.filter(
        onStacks.size > 0 ? yield* listed : [],
        ({ name, onTrunk }) => onTrunk && onStacks.has(name),
      ),
      ({ name }) => name,
    );
    yield* forget(forgotten);
    const records = yield* PrDescriptions;
    yield* records.prune(
      Effect.map(listed, (all) =>
        EffectArray.flatMap(all, ({ name }) => (forgotten.includes(name) ? [] : [name])),
      ),
    );
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
