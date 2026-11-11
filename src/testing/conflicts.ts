import { moveTrunkOnGitHub } from "./branch-changes";
import type { ScratchRepository } from "./scratch-repository";

/**
 * Gives the change of the bookmark `conflicted` a conflict with the trunk. Moves `main` on GitHub
 * with a file that the change adds too, then rebases the working copy's stack onto it, which gives
 * the changes above it the conflict too. Then pushes the bookmarks of `pushed` again, which must
 * have no conflicts.
 */
export const conflictWithTrunk = (
  repository: ScratchRepository,
  conflicted: string,
  { pushed = [] }: { readonly pushed?: readonly string[] } = {},
): void => {
  moveTrunkOnGitHub(repository, `${conflicted}.txt`);
  repository.jj("git", "fetch");
  repository.jj("rebase", "-b", "@", "-d", "main");
  if (pushed.length > 0) {
    repository.jj("git", "push", ...pushed.flatMap((bookmark) => ["--bookmark", bookmark]));
  }
};

/** The change of each bookmark as a command lists it: its short id and its description's first line. */
export const labelsOf = (repository: ScratchRepository, ...bookmarks: readonly string[]): string =>
  bookmarks
    .map((bookmark) =>
      repository.jj(
        "log",
        "--no-graph",
        "-r",
        bookmark,
        "-T",
        'change_id.shortest(8) ++ " " ++ description.first_line()',
      ),
    )
    .join("\n");
