import { Effect, type FileSystem, type Path, type Scope } from "effect";

import { scratchDirectory } from "./scratch-process";
import type { ScratchRepository } from "./scratch-repository";

/**
 * Adds a workspace named `other`, whose working copy is a new change on the revision. Its directory
 * is removed when the test's scope closes.
 */
export const addWorkspace = (
  repository: ScratchRepository,
  revision: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
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
  });
