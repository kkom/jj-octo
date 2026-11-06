import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import type { ListedPullRequest } from "../../clients/github/types";
import { fakeGitHub, inRepository, pullRequest, pullRequests } from "../../testing/fake-github";
import { linked } from "../../testing/links";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchRepository,
} from "../../testing/scratch-repository";
import { stackPullRequests } from "./links";

afterAll(removeScratchRepositories);

// The pull request of each change of the repository's stack, top first, against a GitHub with the
// pull requests given, whose search lists those of the numbers given that are open as approved.
const linkedWithApproved = (
  repository: ScratchRepository,
  byBranch: Readonly<Record<string, readonly ListedPullRequest[]>>,
  approved: readonly number[],
) =>
  Effect.runPromise(
    stackPullRequests("@").pipe(
      inRepository(
        repository,
        fakeGitHub({}, Option.none(), {
          approved: pullRequests(...approved),
          pullRequestsFrom: (branch) => byBranch[branch] ?? [],
        }),
      ),
    ),
  );

describe("stackPullRequests's approval", () => {
  it("marks a ready pull request approved where GitHub's search lists it as approved", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    expect(
      await linkedWithApproved(
        repository,
        { a: [pullRequest(1, "ready", "anything")], b: [pullRequest(2, "ready", "anything")] },
        [1],
      ),
    ).toStrictEqual([
      linked(pullRequest(2, "ready", "anything")),
      { ...linked(pullRequest(1, "ready", "anything")), state: "approved" },
    ]);
  });

  it("marks no draft approved", async () => {
    const repository = scratchRepository();
    repository.stack("a");
    expect(
      await linkedWithApproved(repository, { a: [pullRequest(1, "draft", "anything")] }, [1]),
    ).toStrictEqual([linked(pullRequest(1, "draft", "anything"))]);
  });
});
