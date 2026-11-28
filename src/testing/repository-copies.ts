import { Effect, FileSystem, Path, type Scope, String as EffectString } from "effect";

import { scratchDirectory } from "./scratch-process";

/**
 * Copies a scratch repository's directory, and rewrites the absolute paths in `repository`'s git
 * configuration and in the links between `origin.git` and its worktree `github`.
 */
export const copyRepository = (
  from: string,
  to: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.copy(from, to, { preserveTimestamps: true });
    yield* Effect.forEach(
      ["repository/.git/config", "github/.git", "origin.git/worktrees/github/gitdir"],
      (relative) => {
        const file = path.join(to, relative);
        return fs
          .readFileString(file)
          .pipe(
            Effect.flatMap((text) =>
              fs.writeFileString(file, EffectString.replaceAll(from, to)(text)),
            ),
          );
      },
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.orDie);

/** Copies the scratch repository in `template` into a new scoped directory, and returns it. */
export const scratchCopyOf = (
  template: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* scratchDirectory("repository-");
    yield* copyRepository(template, root);
    return root;
  });
