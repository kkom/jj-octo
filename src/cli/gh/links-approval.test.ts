import { expect } from "bun:test";

import { Effect, Layer } from "effect";

import type { ListedPullRequest } from "../../clients/github/types";
import { fakeGitHub, setUpGitHub } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { linked } from "../../testing/links";
import { pullRequest, pullRequests } from "../../testing/pull-requests";
import { ScratchRepository, scratchRepository } from "../../testing/scratch-repository";
import { stackPullRequests } from "./links";

// The pull request of each change of the repository's stack, top first, against a GitHub with the
// pull requests given, whose search lists those of the numbers given that it's asked about.
const linkedWithApproved = (
  byBranch: Readonly<Record<string, readonly ListedPullRequest[]>>,
  approved: readonly number[],
) =>
  setUpGitHub({
    approved: pullRequests(...approved),
    pullRequestsFrom: (branch) => byBranch[branch] ?? [],
  }).pipe(Effect.andThen(stackPullRequests("@")));

layer(Layer.merge(scratchRepository, fakeGitHub))("stackPullRequests's approval", (it) => {
  it("marks a ready pull request approved where GitHub's search lists it as approved", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      const found = yield* linkedWithApproved(
        { a: [pullRequest(1, "ready", "anything")], b: [pullRequest(2, "ready", "anything")] },
        [1],
      );
      expect(found).toStrictEqual([
        linked(pullRequest(2, "ready", "anything")),
        { ...linked(pullRequest(1, "ready", "anything")), state: "approved" },
      ]);
    }));

  it("marks no pull request approved that isn't ready for review", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      // A closed or merged pull request is the change's only where its head is the change.
      const commitA = yield* repository.commitOf("a");
      const commitB = yield* repository.commitOf("b");
      const [merged, closed, draft] = [
        pullRequest(1, "merged", commitA),
        pullRequest(2, "closed", commitB),
        pullRequest(3, "draft", "anything"),
      ];
      const found = yield* linkedWithApproved({ a: [merged], b: [closed], c: [draft] }, [1, 2, 3]);
      expect(found).toStrictEqual([linked(draft), linked(closed), linked(merged)]);
    }));
});
