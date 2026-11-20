import { Effect } from "effect";

import type { NotCombined } from "../cli/gh/stack/reconcile";
import { sync } from "../cli/gh/sync";
import type { GitHubFailed } from "../clients/github/failure";
import type { JjFailed } from "../clients/jj";
import { fakeGitHub, inRepository } from "./fake-github";
import type { ScratchRepository } from "./scratch-repository";

/**
 * Syncs the repository, with GitHub reporting the pull requests `squashMergeOnGitHub` merged.
 * `allWorkspaces` also syncs the stacks that only other workspaces' working copies are on.
 */
export const syncing = (
  repository: ScratchRepository,
  { allWorkspaces = false } = {},
): Effect.Effect<void, GitHubFailed | JjFailed | NotCombined> =>
  sync({ allWorkspaces, trunk: "main" }).pipe(
    inRepository(repository, fakeGitHub({}, [], { pullRequestsFrom: repository.pullRequestsFrom })),
  );

export const syncIn = (
  repository: ScratchRepository,
  options: { readonly allWorkspaces?: boolean } = {},
): Promise<void> => Effect.runPromise(syncing(repository, options));
