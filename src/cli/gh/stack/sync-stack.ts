import { Array as EffectArray, Console, Data, Effect, String as EffectString } from "effect";

import { Git, type GitFailed } from "../../../clients/git";
import type { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import { Jj, type JjFailed } from "../../../clients/jj";
import type { PrDescriptions } from "../../../clients/pr-descriptions";
import {
  anyOf,
  bookmarkRevset,
  bookmarksAt,
  changeIdsAt,
  changeRevset,
  downstackRevset,
  lines,
  stackRevset,
} from "./changes";
import { type BookmarkBeforeFetch, bookmarksBeforeFetch, pushedOf } from "./combine";
import {
  fetchBranches,
  mergedHeadsOf,
  mergedIn,
  type NotCombined,
  notMerged,
  reconcile,
} from "./reconcile";

// Syncs one stack, for `submit`, where GitHub merged or changed any of it.

export class BranchesDeleted extends Data.TaggedError("BranchesDeleted")<{
  readonly message: string;
}> {}

/** Why a deleted branch's change doesn't count as merged, from its merged pull requests' heads. */
const whyDeleted = (heads: readonly string[], { remote }: BookmarkBeforeFetch): string => {
  if (remote !== undefined && heads.includes(remote)) {
    return "its pushed commit merged, and the change was edited since";
  }
  return heads.length > 0
    ? "a pull request from it merged, but not the commit pushed for this change"
    : "no pull request from it merged";
};

/**
 * The pushed bookmarks whose branch on GitHub isn't the commit jj last fetched, as after GitHub
 * rebases the rest of a stack whose bottom merged. Read from the remote itself, without a fetch.
 * Also the ones whose branch GitHub deleted.
 */
const changedOnGitHub = (bookmarks: readonly BookmarkBeforeFetch[]) =>
  Effect.gen(function* () {
    const pushed = pushedOf(bookmarks);
    // With no refs named, ls-remote lists every branch.
    if (pushed.length === 0) {
      return { changed: [], deleted: [] };
    }
    const git = yield* Git;
    // Jj's own git repository, which a jj workspace without a `.git` of its own also has.
    const jj = yield* Jj;
    const gitDirectory = yield* jj.read(["git", "root"]).pipe(Effect.map(EffectString.trim));
    const output = yield* git.read([
      "--git-dir",
      gitDirectory,
      "ls-remote",
      "origin",
      ...EffectArray.map(pushed, ({ name }) => `refs/heads/${name}`),
    ]);
    const onGitHub = new Map(
      EffectArray.map(lines(output), (line) => {
        const [commit, ref = ""] = EffectString.split(line, "\t");
        return [EffectString.replace(/^refs\/heads\//u, "")(ref), commit];
      }),
    );
    return {
      changed: EffectArray.map(
        EffectArray.filter(
          pushed,
          ({ name, remote }) => onGitHub.has(name) && onGitHub.get(name) !== remote,
        ),
        ({ name }) => name,
      ),
      deleted: EffectArray.filter(pushed, ({ name }) => !onGitHub.has(name)),
    };
  });

/**
 * Syncs the revision's stack alone, as `sync` does, where any pull request of the
 * revision or the changes below it merged, or any of their branches changed on GitHub. Fetches
 * only those branches and the trunk, so other stacks stay as they are. The changes above are
 * rebased with the stack, and their branches are left for their own submit. Returns whether it
 * synced.
 */
export const syncStack = (
  revision: string,
  trunk: string,
): Effect.Effect<
  boolean,
  BranchesDeleted | GitFailed | GitHubFailed | JjFailed | NotCombined,
  Git | GitHub | Jj | PrDescriptions
> =>
  Effect.gen(function* () {
    // The changes above the revision aren't submitted, so they're synced only by following these.
    const downstack = downstackRevset(revision);
    const before = yield* bookmarksBeforeFetch(downstack);
    const [heads, onGitHub] = yield* Effect.all([mergedHeadsOf(before), changedOnGitHub(before)], {
      concurrency: "unbounded",
    });
    const merged = yield* mergedIn(before, heads);
    const changed = EffectArray.filter(onGitHub.changed, notMerged(merged));
    // A fetch would delete the local bookmark, and the commit with it where nothing else keeps it.
    // That is right only for work that merged, which a merged pull request with another head
    // doesn't prove: GitHub may have added commits before merging, or the name may be reused.
    const deleted = EffectArray.filter(onGitHub.deleted, ({ name }) => notMerged(merged)(name));
    if (deleted.length > 0) {
      return yield* new BranchesDeleted({
        message: EffectArray.join(
          [
            "these branches were deleted on GitHub, so nothing was changed:",
            ...EffectArray.map(
              deleted,
              (bookmark) => `${bookmark.name}: ${whyDeleted(heads[bookmark.name] ?? [], bookmark)}`,
            ),
            "to push a change again, run `jj bookmark forget --include-remotes <name>`, then `jj bookmark create <name> -r <change>`; to drop one, run `jj abandon <change>`",
          ],
          "\n",
        ),
      });
    }
    const found = [
      ...EffectArray.map(merged, ({ bookmark }) => `${bookmark} merged`),
      ...EffectArray.map(changed, (name) => `${name} changed`),
    ];
    if (found.length === 0) {
      return false;
    }
    yield* Console.error(`on GitHub, ${EffectArray.join(found, ", ")}; syncing the stack first`);
    // The whole stack is rebased, so the changes above the revision keep their place on it.
    const whole = stackRevset(revision);
    const bookmarks = yield* bookmarksAt(whole);
    // With the working copy on top, which follows the stack even where all of it merged.
    const unnamed = yield* changeIdsAt(`((${whole}) | (@ & children(${whole}))) ~ bookmarks()`);
    yield* reconcile({
      before,
      bookmarks,
      fetch: fetchBranches([trunk, ...EffectArray.map(pushedOf(before), ({ name }) => name)]),
      merged,
      skipped: "none()",
      stacks: `::(${anyOf([
        ...EffectArray.map(bookmarks, (name) => bookmarkRevset(name)),
        ...EffectArray.map(unnamed, (change) => changeRevset(change)),
      ])})`,
    });
    return true;
  });
