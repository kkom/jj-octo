import { expect } from "bun:test";

import { Effect, Layer } from "effect";
import { TestConsole } from "effect/testing";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { conflictWithTrunk } from "../../testing/conflicts";
import {
  fakeGitHub,
  gitHubCalls,
  setUpGitHub,
  setUpPullRequestsAB,
  setUpPullRequestsABC,
} from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { merging } from "../../testing/merge";
import { openPullRequest, openPullRequestsABC } from "../../testing/pull-requests";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))(
  "merge, where changes have conflicts",
  (it) => {
    it("rebases the rest of the stack even where it conflicts with the trunk, and leaves it local", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        const pushedBranches = yield* repository.branches;
        const pushedB = pushedBranches["b"];
        yield* setUpPullRequestsAB({
          onMerge: () =>
            Effect.gen(function* () {
              yield* squashMergeOnGitHub("a");
              yield* repository.writeOnGitHub("b.txt", "somebody else's\n");
              yield* repository.git("add", ".");
              yield* repository.git("commit", "--quiet", "-m", "another pull request");
              yield* repository.git("push", "--quiet", "origin", "main");
            }),
          stacks: [],
        });
        yield* merging("a");
        const branches = yield* repository.branches;
        const labels = yield* repository.labels("b");
        expect({
          branchB: branches["b"],
          conflicted: yield* repository.conflicted,
          log: yield* repository.log,
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          branchB: pushedB,
          conflicted: yield* repository.labels("@", "b"),
          log: ["b [b]"],
          stderr: [
            "merging #1",
            "merged up to #1",
            "abandoned the changes whose pull requests merged: a",
            `left these changes local, since they or a change below them have conflicts:\n${labels}`,
          ],
          stdout: [],
        });
      }));
  },
);

layer(Layer.merge(pushedStack("a", "b", "c"), fakeGitHub))(
  "merge, where changes have conflicts, with three changes",
  (it) => {
    it("merges a change and the ones below it where a change above has conflicts", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* conflictWithTrunk("c", { pushed: ["a", "b"] });
        yield* setUpPullRequestsABC({
          onMerge: () => squashMergeOnGitHub("b", { below: ["a"] }),
        });
        const pushedBranches = yield* repository.branches;
        const pushedC = pushedBranches["c"];
        yield* merging("b");
        const branches = yield* repository.branches;
        const labels = yield* repository.labels("c");
        expect({
          branchC: branches["c"],
          calls: yield* gitHubCalls,
          log: yield* repository.log,
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          branchC: pushedC,
          calls: ["merge the stack up to #2"],
          log: ["c [c]"],
          stderr: [
            "merging #1, #2",
            "merged up to #2",
            "abandoned the changes whose pull requests merged: a, b",
            `left these changes local, since they or a change below them have conflicts:\n${labels}`,
          ],
          stdout: [],
        });
      }));

    it("fails before merging where the change named has conflicts", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* conflictWithTrunk("b", { pushed: ["a"] });
        yield* setUpPullRequestsABC({
          onMerge: () => squashMergeOnGitHub("b", { below: ["a"] }),
        });
        const failure = yield* Effect.flip(merging("b"));
        const labels = yield* repository.labels("b");
        expect({ calls: yield* gitHubCalls, message: failure.message }).toStrictEqual({
          calls: [],
          message: `resolve the conflicts first:\n${labels}`,
        });
      }));
  },
);

layer(Layer.merge(pushedStack("a", "b", "c", "d"), fakeGitHub))(
  "merge, where changes have conflicts, with four changes",
  (it) => {
    it("republishes the changes below the lowest one with conflicts, and leaves the rest local", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        const pushed = yield* repository.branches;
        yield* setUpGitHub({
          onMerge: () =>
            Effect.gen(function* () {
              yield* squashMergeOnGitHub("a");
              yield* moveTrunkOnGitHub("c.txt");
            }),
          open: { ...openPullRequestsABC, d: openPullRequest("c", 4, "d") },
        });
        yield* merging("a");
        const branches = yield* repository.branches;
        const labels = yield* repository.labels("c", "d");
        expect({
          branches: [branches["b"], branches["c"], branches["d"]],
          calls: yield* gitHubCalls,
          log: yield* repository.log,
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          branches: [yield* repository.commitOf("b"), pushed["c"], pushed["d"]],
          calls: ["merge #1"],
          log: ["b [b]", "c [c]", "d [d]"],
          stderr: [
            "merging #1",
            "merged up to #1",
            "abandoned the changes whose pull requests merged: a",
            `left these changes local, since they or a change below them have conflicts:\n${labels}`,
          ],
          stdout: [],
        });
      }));
  },
);
