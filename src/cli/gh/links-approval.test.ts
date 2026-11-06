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
// pull requests given, whose search lists those of the numbers given that it's asked about.
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

  it("marks no pull request approved that isn't ready for review", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    // A closed or merged pull request is the change's only where its head is the change.
    const commitOf = (bookmark: string) =>
      repository.jj("log", "--no-graph", "-r", bookmark, "-T", "commit_id");
    const [merged, closed, draft] = [
      pullRequest(1, "merged", commitOf("a")),
      pullRequest(2, "closed", commitOf("b")),
      pullRequest(3, "draft", "anything"),
    ];
    expect(
      await linkedWithApproved(repository, { a: [merged], b: [closed], c: [draft] }, [1, 2, 3]),
    ).toStrictEqual([linked(draft), linked(closed), linked(merged)]);
  });
});
