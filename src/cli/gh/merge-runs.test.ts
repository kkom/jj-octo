import { describe, expect } from "bun:test";

import { Effect } from "effect";

import { squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { mergeIn, mergingIn, openPullRequestsAB } from "../../testing/merge";
import { stackOf } from "../../testing/pull-requests";
import { pushedStack } from "../../testing/scratch-repository";
import { merge } from "./merge";

// A stack of `a` and `b`, merged up to `b`, whose head commits have workflow runs: one running and
// one completed for `a`, and one queued for `b`. `b`'s commit also has a running push run on
// `main`, as the trunk has after a merge fast-forwards it to `b`. Cancelling `a`'s running one is
// forbidden where `forbidden` says.
const mergedWithRuns = (forbidden = false) =>
  Effect.gen(function* () {
    const repository = yield* pushedStack("a", "b");
    const commitA = yield* repository.commitOf("a");
    const commitB = yield* repository.commitOf("b");
    const github = fakeGitHub(openPullRequestsAB, stackOf(1, 2), {
      ...mergingIn(
        repository,
        Effect.gen(function* () {
          yield* squashMergeOnGitHub(repository, "a", { deleted: false });
          yield* squashMergeOnGitHub(repository, "b", { deleted: false });
        }),
      ),
      runs: {
        [commitA]: [
          { branch: "a", cancelForbidden: forbidden, completed: false, id: "11" },
          { branch: "a", completed: true, id: "12" },
        ],
        [commitB]: [
          { branch: "b", completed: false, id: "21" },
          { branch: "main", completed: false, id: "22" },
        ],
      },
    });
    return { github, repository };
  });

describe("merge", () => {
  itEffect(
    "with --cancel-pr-runs, cancels every merged pull request's workflow runs that haven't completed, and not the trunk's push run",
    () =>
      Effect.gen(function* () {
        const { github, repository } = yield* mergedWithRuns();
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
      const { github, repository } = yield* mergedWithRuns(true);
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
      const { github, repository } = yield* mergedWithRuns();
      yield* mergeIn(repository, github, "b");
      expect(github.calls).toEqual(["merge the stack up to #2"]);
    }),
  );
});
