import { type ScratchRepository, scratchDirectory } from "./scratch-repository";

/** Adds a workspace named `other`, whose working copy is a new change on the revision. */
export const addWorkspace = (repository: ScratchRepository, revision: string): void => {
  const workspace = scratchDirectory("workspace-");
  repository.jj(
    "workspace",
    "add",
    "--quiet",
    "--name",
    "other",
    "--revision",
    revision,
    workspace,
  );
};
