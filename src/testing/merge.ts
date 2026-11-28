import type { Effect } from "effect";

import { merge, type NotMergeable } from "../cli/gh/merge";
import type { PushFailed } from "../cli/gh/stack/push";
import type { NotCombined } from "../cli/gh/stack/reconcile";
import { type fakeGitHub, type FakeGitHubOptions, inRepository } from "./fake-github";
import { openPullRequest } from "./pull-requests";
import type { ScratchRepository } from "./scratch-repository";

/** The open pull requests of the stack `a`, `b`: #1 for `a` against `main`, and #2 for `b` against `a`. */
export const openPullRequestsAB = {
  a: openPullRequest("main", 1, "a"),
  b: openPullRequest("a", 2, "b"),
};

/** GitHub reports the pull requests `squashMergeOnGitHub` merged, and merges as `onMerge` says. */
export const mergingIn = (
  repository: ScratchRepository,
  onMerge: Effect.Effect<void>,
): Pick<FakeGitHubOptions, "onMerge" | "pullRequestsFrom"> => ({
  onMerge: () => onMerge,
  pullRequestsFrom: repository.pullRequestsFrom,
});

/** Merges up to the revision in the repository, against the fake GitHub. */
export const mergeIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  revision: string,
): Effect.Effect<void, NotCombined | NotMergeable | PushFailed> =>
  merge(revision, { allWorkspaces: false, cancelPrRuns: false }).pipe(
    inRepository(repository, github),
  );
