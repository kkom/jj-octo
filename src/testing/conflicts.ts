import { Array as EffectArray, Effect } from "effect";

import { moveTrunkOnGitHub } from "./branch-changes";
import { ScratchRepository } from "./scratch-repository";

/**
 * Gives bookmark `conflicted`'s change a conflict with the trunk: moves `main` on GitHub with a
 * file that change adds too, then rebases the working copy's stack onto it. The changes above get
 * the conflict too. Then pushes the bookmarks of `pushed` again, which must have no conflicts.
 */
export const conflictWithTrunk = (
  conflicted: string,
  { pushed = [] }: { readonly pushed?: readonly string[] } = {},
): Effect.Effect<void, never, ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* moveTrunkOnGitHub(`${conflicted}.txt`);
    yield* repository.jj("git", "fetch");
    yield* repository.jj("rebase", "-b", "@", "-d", "main");
    if (pushed.length > 0) {
      yield* repository.jj(
        "git",
        "push",
        ...EffectArray.flatMap(pushed, (bookmark) => ["--bookmark", bookmark]),
      );
    }
  });
