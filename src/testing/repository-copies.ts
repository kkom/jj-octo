import { Effect, FileSystem, Path, type Scope, String as EffectString } from "effect";

import { scratchDirectory } from "./scratch-process";

/**
 * Copies the directory of a scratch repository, its `origin.git`, `repository` and `github`, to
 * `to`. The two git configurations hold the path of `origin.git`, which is rewritten to the copy's.
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
      ["repository/.git/config", "github/.git/config"],
      (config) => {
        const file = path.join(to, config);
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

/**
 * Copies the scratch repository in `template` into a new directory, and returns it. The directory
 * is removed when the scope closes.
 */
export const scratchCopyOf = (
  template: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* scratchDirectory("repository-");
    yield* copyRepository(template, root);
    return root;
  });
