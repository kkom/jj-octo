import { Effect, type FileSystem, type Path, type Scope } from "effect";

import { scratchDirectory } from "./scratch-process";
import { ScratchRepository } from "./scratch-repository";

/**
 * Adds a workspace named `other`, with a new change on the revision, and returns its scoped
 * directory.
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
