import { afterAll, describe, expect } from "bun:test";

import { Effect } from "effect";

import type { ListedPullRequest } from "../../clients/github/types";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { linked } from "../../testing/links";
import { pullRequest, pullRequests } from "../../testing/pull-requests";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchRepository,
} from "../../testing/scratch-repository";
import { stackPullRequests } from "./links";

afterAll(removeScratchRepositories);

// The pull request of each change of the repository's stack, top first, against a GitHub with the
// pull requests given, whose search lists those of the numbers given that it's asked about.
const linkedWithApproved = (
  repository: ScratchRepository,
  byBranch: Readonly<Record<string, readonly ListedPullRequest[]>>,
  approved: readonly number[],
) =>
  stackPullRequests("@").pipe(
    inRepository(
      repository,
      fakeGitHub({}, [], {
        approved: pullRequests(...approved),
        pullRequestsFrom: (branch) => byBranch[branch] ?? [],
      }),
    ),
  );

describe("stackPullRequests's approval", () => {
  itEffect("marks a ready pull request approved where GitHub's search lists it as approved", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a", "b");
      const found = yield* linkedWithApproved(
        repository,
        { a: [pullRequest(1, "ready", "anything")], b: [pullRequest(2, "ready", "anything")] },
        [1],
      );
      expect(found).toStrictEqual([
        linked(pullRequest(2, "ready", "anything")),
        { ...linked(pullRequest(1, "ready", "anything")), state: "approved" },
      ]);
    }),
  );

  itEffect("marks no pull request approved that isn't ready for review", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a", "b", "c");
      // A closed or merged pull request is the change's only where its head is the change.
      const [merged, closed, draft] = [
        pullRequest(1, "merged", repository.commitOf("a")),
        pullRequest(2, "closed", repository.commitOf("b")),
        pullRequest(3, "draft", "anything"),
      ];
      const found = yield* linkedWithApproved(
        repository,
        { a: [merged], b: [closed], c: [draft] },
        [1, 2, 3],
      );
      expect(found).toStrictEqual([linked(draft), linked(closed), linked(merged)]);
    }),
  );
});
