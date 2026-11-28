import { Array as EffectArray, Console, Effect, String as EffectString } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { bookmarkTargets } from "./bookmark-targets";
import { anyOf, bookmarkRevset, changeRevset, commitsAt, logLines } from "./changes";

// Combines a local change with its GitHub branch after a fetch, for `sync` and `submit`.

/** Where a stack bookmark pointed before the fetch. */
export interface BookmarkBeforeFetch {
  /** The ids of the changes on top of it, which the fetch can move off the stack. */
  readonly above: readonly string[];
  /** The change id, which survives rewrites. */
  readonly change: string;
  /** Whether it's the working copy, which the fetch can replace with a new one off the stack. */
  readonly editing: boolean;
  readonly local: string;
  readonly name: string;
  /** Its branch's commit, for a pushed bookmark. */
  readonly remote: string | undefined;
}

export const pushedOf = (
  bookmarks: readonly BookmarkBeforeFetch[],
): readonly BookmarkBeforeFetch[] =>
  EffectArray.filter(bookmarks, ({ remote }) => remote !== undefined);

// Top first, since folding GitHub's commits into a change rewrites everything above it. Bottom
// first, a commit GitHub added higher up would be rewritten too, and left as a change of its own.
export const bookmarksBeforeFetch = (
  revset: string,
): Effect.Effect<readonly BookmarkBeforeFetch[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const targets = [...(yield* bookmarkTargets)];
    const bookmarked = `(${revset}) & bookmarks()`;
    const bottomFirst = yield* logLines(
      bookmarked,
      String.raw`commit_id ++ "\t" ++ change_id ++ "\t" ++ current_working_copy ++ "\n"`,
    );
    const childLines = yield* logLines(
      `children(${bookmarked})`,
      String.raw`parents.map(|p| p.commit_id()).join(",") ++ "\t" ++ change_id ++ "\n"`,
    );
    const children = EffectArray.map(childLines, (line) => EffectString.split(line, "\t"));
    return EffectArray.flatMap(
      EffectArray.reverse(bottomFirst),
      (line): readonly BookmarkBeforeFetch[] => {
        const [commit, change = "", workingCopy] = EffectString.split(line, "\t");
        const above = EffectArray.flatMap(children, ([parents, child = ""]) =>
          EffectString.split(parents, ",").includes(commit) ? [child] : [],
        );
        return EffectArray.map(
          EffectArray.filter(targets, ([, { local }]) => local === commit),
          ([name, { origin }]) => ({
            above,
            change,
            editing: workingCopy === "true",
            local: commit,
            name,
            remote: origin,
          }),
        );
      },
    );
  });

/**
 * Returns the change's local commits. Leaves out the pushed commit, which the fetch can bring back,
 * and GitHub's copies, which can share the change id. With nothing else, returns the pushed commit
 * where the change still has it. With nothing at all, the fetch abandoned the change, as it does
 * where no GitHub branch contains it.
 */
const localCommit = (change: string, remote: string, fetched: string) =>
  Effect.gen(function* () {
    const commits = yield* commitsAt(changeRevset(change));
    const local = EffectArray.filter(commits, (commit) => commit !== remote && commit !== fetched);
    if (local.length === 0) {
      return commits.includes(remote) ? [remote] : [];
    }
    return local;
  });

/**
 * Makes the local change and its GitHub branch one change again after a fetch, and returns whether
 * it could. The local change stays its pull request's one change, and nothing GitHub has is
 * dropped. The fetch moves the bookmark to GitHub's commit where the local change was untouched,
 * and conflicts it where both sides changed.
 */
export const combine = (
  { above, change, editing, local: localBefore, name, remote }: BookmarkBeforeFetch,
  fetched: string | undefined,
  // The changes to leave in place, as `Reconciliation.skipped` says.
  skipped: string,
): Effect.Effect<boolean, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    // Never pushed, unchanged on GitHub, or deleted there, as a merged branch is.
    if (remote === undefined || fetched === undefined || fetched === remote) {
      return true;
    }
    const [local, ...others] = yield* localCommit(change, remote, fetched);
    if (local === undefined) {
      // Only the working copy kept the pushed commit, so the fetch abandoned it, moved the changes
      // on it to its parent, off the stack, and started a new working copy there if it was one.
      // GitHub's commit replaces it for both.
      if (editing) {
        yield* jj.run(["edit", fetched]);
      }
      // GitHub's own copies can carry the ids too, and are already on its commit.
      const moved = `(${anyOf(EffectArray.map(above, (child) => changeRevset(child)))}) ~ (${skipped}) ~ children(${fetched})`;
      if ((yield* commitsAt(moved)).length > 0) {
        yield* jj.run(["rebase", "--source", moved, "--destination", fetched]);
        yield* Console.error(`took GitHub's rewritten ${name}, and moved what was on it there`);
      }
      return true;
    }
    if (others.length > 0) {
      return false;
    }
    const keepLocal = jj.run(["bookmark", "set", name, "-r", local, "--allow-backwards"]);
    // GitHub's commits the local change now replaces, which would otherwise show as a second copy.
    // What another bookmark holds above the pushed commit stays, such as GitHub's rewrite of the
    // branch below, where the fetch moved that bookmark.
    const held = `::(bookmarks() ~ ${bookmarkRevset(name)}) ~ ::${remote}`;
    const dropCopies = jj.run([
      "abandon",
      `((::${fetched} | ::${remote}) & mutable()) ~ ::${bookmarkRevset(name)} ~ (${held}) ~ (${skipped})`,
    ]);

    if ((yield* commitsAt(`${remote} & ::${fetched}`)).length > 0) {
      yield* keepLocal;
      yield* jj.run([
        "squash",
        "--from",
        `(${remote}..${fetched}) & mutable()`,
        "--into",
        local,
        "--use-destination-message",
      ]);
      yield* dropCopies;
      yield* Console.error(`folded what GitHub added to ${name} into its change`);
      return true;
    }

    // From here GitHub rewrote the branch: its commit doesn't contain the pushed one.
    if (localBefore === remote) {
      yield* jj.run(["rebase", "--source", `children(${local})`, "--destination", fetched]);
      // Abandoning the working copy would start a new one on the parent, off the stack.
      if (editing) {
        yield* jj.run(["edit", fetched]);
      }
      yield* jj.run(["abandon", local]);
      yield* Console.error(`took GitHub's rewritten ${name}, which wasn't changed locally`);
      return true;
    }
    const added = yield* jj.read(["interdiff", "--from", remote, "--to", fetched, "--summary"]);
    if (EffectString.trim(added) === "") {
      yield* keepLocal;
      yield* dropCopies;
      yield* Console.error(`kept the local ${name}, which GitHub had only rebased`);
      return true;
    }
    return false;
  });
