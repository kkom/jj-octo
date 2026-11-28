import { afterAll, describe, expect } from "bun:test";

import { Effect } from "effect";

import { squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { mergeIn, mergingIn, openPullRequestsAB } from "../../testing/merge";
import { stackOf } from "../../testing/pull-requests";
import { pushedStack, removeScratchRepositories } from "../../testing/scratch-repository";
import { merge } from "./merge";

afterAll(removeScratchRepositories);

// A stack of `a` and `b`, merged up to `b`, whose head commits have workflow runs: one running and
// one completed for `a`, and one queued for `b`. Cancelling `a`'s running one is forbidden where
// `forbidden` says.
const mergedWithRuns = (forbidden = false) => {
  const repository = pushedStack("a", "b");
  const github = fakeGitHub(openPullRequestsAB, stackOf(1, 2), {
    ...mergingIn(repository, () => {
      squashMergeOnGitHub(repository, "a", { deleted: false });
      squashMergeOnGitHub(repository, "b", { deleted: false });
    }),
    runs: {
      [repository.commitOf("a")]: [
        { cancelForbidden: forbidden, completed: false, id: "11" },
        { completed: true, id: "12" },
      ],
      [repository.commitOf("b")]: [{ completed: false, id: "21" }],
    },
  });
  return { github, repository };
};

describe("merge", () => {
  itEffect(
    "cancels every merged pull request's workflow runs that haven't completed, with --cancel-pr-runs",
    () =>
      Effect.gen(function* () {
        const { github, repository } = mergedWithRuns();
        yield* merge("b", { allWorkspaces: false, cancelPrRuns: true }).pipe(
          inRepository(repository, github),
        );
        expect(github.calls).toEqual([
          "merge the stack up to #2",
          "cancel run 11",
          "cancel run 21",
        ]);
      }),
  );

  itEffect("still cancels the other runs where one cancel fails, then fails", () =>
    Effect.gen(function* () {
      const { github, repository } = mergedWithRuns(true);
      const failure = yield* Effect.flip(
        merge("b", { allWorkspaces: false, cancelPrRuns: true }).pipe(
          inRepository(repository, github),
        ),
      );
      expect({ calls: github.calls, message: failure.message }).toStrictEqual({
        calls: ["merge the stack up to #2", "cancel run 21"],
        message:
          "couldn't cancel 1 of the merged pull requests' workflow runs:\ncancel run 11 returned 403",
      });
    }),
  );

  itEffect("leaves the merged pull requests' workflow runs alone without --cancel-pr-runs", () =>
    Effect.gen(function* () {
      const { github, repository } = mergedWithRuns();
      yield* mergeIn(repository, github, "b");
      expect(github.calls).toEqual(["merge the stack up to #2"]);
    }),
  );
});
