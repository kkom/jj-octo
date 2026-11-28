import { Effect } from "effect";

import type { NotCombined } from "../cli/gh/stack/reconcile";
import { sync } from "../cli/gh/sync";
import type { GitHub } from "../clients/github/client";
import type { GitHubFailed } from "../clients/github/failure";
import type { JjFailed } from "../clients/jj";
import type { RepositoryClients } from "./scratch-process";
import { ScratchRepository } from "./scratch-repository";

/** Changes a file of the change `a`, which the working copy sits two changes above. */
export const editLocally: Effect.Effect<void, never, ScratchRepository> = ScratchRepository.use(
  (repository) =>
    Effect.gen(function* () {
      yield* repository.jj("edit", "a");
      yield* repository.write("local.txt", "local\n");
      yield* repository.jj("new", "b");
    }),
);

/**
 * Syncs onto `main`. `allWorkspaces` also syncs the stacks that only other workspaces' working
 * copies are on.
 */
export const syncing = ({ allWorkspaces = false } = {}): Effect.Effect<
  void,
  GitHubFailed | JjFailed | NotCombined,
  GitHub | RepositoryClients
> => sync({ allWorkspaces, trunk: "main" });
