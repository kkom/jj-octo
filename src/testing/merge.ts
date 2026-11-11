import type { Effect } from "effect";

import { merge, type NotMergeable } from "../cli/gh/merge";
import type { PushFailed } from "../cli/gh/stack/push";
import type { NotCombined } from "../cli/gh/stack/reconcile";
import { type fakeGitHub, type FakeGitHubOptions, inRepository } from "./fake-github";
import type { ScratchRepository } from "./scratch-repository";

/** GitHub reports the pull requests `squashMergeOnGitHub` merged, and merges as `onMerge` says. */
export const mergingIn = (
  repository: ScratchRepository,
  onMerge: () => void,
): Pick<FakeGitHubOptions, "onMerge" | "pullRequestsFrom"> => ({
  onMerge,
  pullRequestsFrom: repository.pullRequestsFrom,
});

/** Merges up to the revision in the repository, against the fake GitHub. */
export const mergeIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  revision: string,
): Effect.Effect<void, NotCombined | NotMergeable | PushFailed> =>
  merge(revision, { cancelPrRuns: false }).pipe(inRepository(repository, github));
