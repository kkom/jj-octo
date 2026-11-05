import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import type { ListedPullRequest, Review } from "../../clients/github/types";
import { fakeGitHub, inRepository, pullRequest } from "../../testing/fake-github";
import { linked } from "../../testing/links";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchRepository,
} from "../../testing/scratch-repository";
import { stackPullRequests } from "./links";

afterAll(removeScratchRepositories);

const approval: readonly Review[] = [{ state: "APPROVED" }];

// The pull request of each change of the repository's stack, top first, against a GitHub with the
// pull requests and reviews given.
const reviewed = (
  repository: ScratchRepository,
  byBranch: Readonly<Record<string, readonly ListedPullRequest[]>>,
  reviewsOf: Readonly<Record<number, readonly Review[]>>,
) =>
  Effect.runPromise(
    stackPullRequests("@").pipe(
      inRepository(
        repository,
        fakeGitHub({}, Option.none(), {
          pullRequestsFrom: (branch) => byBranch[branch] ?? [],
          reviews: (number) => reviewsOf[number] ?? [],
        }),
      ),
    ),
  );

describe("stackPullRequests's approval", () => {
  it("marks a ready pull request approved where its reviews approve it", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    expect(
      await reviewed(
        repository,
        {
          a: [pullRequest(1, "ready", "anything")],
          b: [pullRequest(2, "ready", "anything")],
          c: [pullRequest(3, "ready", "anything")],
        },
        { 1: approval, 2: [...approval, { state: "CHANGES_REQUESTED" }] },
      ),
    ).toStrictEqual([
      linked(pullRequest(3, "ready", "anything")),
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
      await reviewed(
        repository,
        { a: [merged], b: [closed], c: [draft] },
        { 1: approval, 2: approval, 3: approval },
      ),
    ).toStrictEqual([linked(draft), linked(closed), linked(merged)]);
  });
});
