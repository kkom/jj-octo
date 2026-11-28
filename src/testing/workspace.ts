import { Effect, type FileSystem, type Path, type Scope } from "effect";

import { scratchDirectory } from "./scratch-process";
import { ScratchRepository } from "./scratch-repository";

/**
 * Adds a workspace named `other`, whose working copy is a new change on the revision. Returns its
 * directory, which is removed when the test's scope closes.
 */
export const addWorkspace = (
  revision: string,
): Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | ScratchRepository | Scope.Scope
> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    const workspace = yield* scratchDirectory("workspace-");
    yield* repository.jj(
      "workspace",
      "add",
      "--quiet",
      "--name",
      "other",
      "--revision",
      revision,
      workspace,
    );
    return workspace;
  });
