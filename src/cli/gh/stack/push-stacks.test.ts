import { expect } from "bun:test";

import { Effect, Layer } from "effect";

import {
  fakeGitHub,
  gitHubCalls,
  setUpGitHub,
  setUpPullRequestsABC,
} from "../../../testing/fake-github";
import { layer } from "../../../testing/it-effect";
import { openPullRequestsAB, stackNumbered, stackOf } from "../../../testing/pull-requests";
import { ScratchRepository, scratchRepository } from "../../../testing/scratch-repository";
import { submitting } from "../../../testing/submit";
import { SeveralStacks } from "./stacks";

layer(Layer.merge(scratchRepository, fakeGitHub))("submit's stacks", (it) => {
  // The top pull request was closed, its change dropped, and another pushed in its place. GitHub
  // adds only above the closed one, whose head no new pull request is on.
  it("registers the stack again where its top pull request was closed without merging", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      yield* setUpGitHub({ open: { a: openPullRequestsAB.a }, stacks: stackOf(1, 2) });
      yield* submitting();
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["unstack #7", "open b on a as a draft", "create stack 1,99"]);
    }));

  // GitHub rejects a base change on a pull request in a stack, and closes a pull request whose
  // head becomes reachable from its base. So submit dissolves the stack, bases the moved pull
  // requests on the trunk, pushes, then sets their new bases and a new stack.
  it("reorders by dissolving, parking on the trunk, pushing, then rebasing and registering", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "c", "b");
      yield* setUpPullRequestsABC();
      yield* submitting();
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual([
        "unstack #7",
        "base #3 → main",
        "base #2 → main",
        "base #3 → a",
        "base #2 → c",
        "create stack 1,3,2",
      ]);
    }));

  // Taking a pull request out of another stack would dissolve that stack, so submit leaves that to
  // `jj gh dissolve`.
  it("fails without changing GitHub where the pull requests belong to several stacks", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* setUpPullRequestsABC({ stacks: [stackNumbered(9, 1, 2), stackNumbered(7, 3)] });
      const failure = yield* Effect.flip(submitting());
      expect(failure).toStrictEqual(
        SeveralStacks.make({
          message:
            "the pull requests are in GitHub stacks #9 (#1, #2), #7 (#3), and submit won't take a pull request out of another stack; to keep #9, which holds the bottom one, run `jj gh dissolve 7`, then submit again",
        }),
      );
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual([]);
    }));

  it("appends to the stack that's left once the other is dissolved", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* setUpPullRequestsABC({ stacks: [stackNumbered(9, 1, 2)] });
      yield* submitting();
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["add 3 to #9"]);
    }));
});
