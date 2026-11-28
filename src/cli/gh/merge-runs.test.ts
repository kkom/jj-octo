import { expect } from "bun:test";

import { Effect, Layer } from "effect";

import { squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub, gitHubCalls, setUpPullRequestsAB } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { merging } from "../../testing/merge";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";
import { merge } from "./merge";

// Sets up the stack of `a` and `b` to merge up to `b`, whose head commits have workflow runs: one
// running and one completed for `a`, and one queued for `b`. `b`'s commit also has a running push
// run on `main`, as the trunk has after a merge fast-forwards it to `b`. Cancelling `a`'s running
// one is forbidden where `forbidden` says.
const mergedWithRuns = (forbidden = false) =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    const commitA = yield* repository.commitOf("a");
    const commitB = yield* repository.commitOf("b");
    yield* setUpPullRequestsAB({
      onMerge: () =>
        Effect.gen(function* () {
          yield* squashMergeOnGitHub("a", { deleted: false });
          yield* squashMergeOnGitHub("b", { deleted: false });
        }),
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
  });

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))("merge", (it) => {
  it("with --cancel-pr-runs, cancels every merged pull request's workflow runs that haven't completed, and not the trunk's push run", () =>
    Effect.gen(function* () {
      yield* mergedWithRuns();
      yield* merge("b", { allWorkspaces: false, cancelPrRuns: true });
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["merge the stack up to #2", "cancel run 11", "cancel run 21"]);
    }));

  it("still cancels the other runs where one cancel fails, then fails", () =>
    Effect.gen(function* () {
      yield* mergedWithRuns(true);
      const failure = yield* Effect.flip(merge("b", { allWorkspaces: false, cancelPrRuns: true }));
      expect({ calls: yield* gitHubCalls, message: failure.message }).toStrictEqual({
        calls: ["merge the stack up to #2", "cancel run 21"],
        message:
          "couldn't cancel 1 of the merged pull requests' workflow runs:\ncancel run 11 returned 403",
      });
    }));

  it("leaves the merged pull requests' workflow runs alone without --cancel-pr-runs", () =>
    Effect.gen(function* () {
      yield* mergedWithRuns();
      yield* merging("b");
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["merge the stack up to #2"]);
    }));
});
