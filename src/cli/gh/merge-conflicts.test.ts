import { describe, expect } from "bun:test";

import { Effect } from "effect";
import { TestConsole } from "effect/testing";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { conflictWithTrunk, labelsOf } from "../../testing/conflicts";
import { fakeGitHub } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { mergeIn, mergingIn, openPullRequestsAB } from "../../testing/merge";
import { openPullRequest, stackOf } from "../../testing/pull-requests";
import { pushedStack } from "../../testing/scratch-repository";

describe("merge, where changes have conflicts", () => {
  itEffect(
    "rebases the rest of the stack even where it conflicts with the trunk, and leaves it local",
    () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        const pushedBranches = yield* repository.branches;
        const pushedB = pushedBranches["b"];
        const github = fakeGitHub(
          openPullRequestsAB,
          [],
          mergingIn(
            repository,
            Effect.gen(function* () {
              yield* squashMergeOnGitHub(repository, "a");
              yield* repository.writeOnGitHub("b.txt", "somebody else's\n");
              yield* repository.git("add", ".");
              yield* repository.git("commit", "--quiet", "-m", "another pull request");
              yield* repository.git("push", "--quiet", "origin", "main");
            }),
          ),
        );
        yield* mergeIn(repository, github, "a");
        const branches = yield* repository.branches;
        const labels = yield* labelsOf(repository, "b");
        expect({
          branchB: branches["b"],
          conflicted: yield* repository.jj(
            "log",
            "--no-graph",
            "-r",
            "conflicts()",
            "-T",
            "description",
          ),
          log: yield* repository.log,
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          branchB: pushedB,
          conflicted: "b\n",
          log: ["b [b]"],
          stderr: [
            "merging #1",
            "merged up to #1",
            "abandoned the changes whose pull requests merged: a",
            `left these changes local, since they or a change below them have conflicts:\n${labels}`,
          ],
          stdout: [],
        });
      }),
  );

  itEffect("merges a change and the ones below it where a change above has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b", "c");
      yield* conflictWithTrunk(repository, "c", { pushed: ["a", "b"] });
      const github = fakeGitHub(
        { ...openPullRequestsAB, c: openPullRequest("b", 3, "c") },
        stackOf(1, 2, 3),
        mergingIn(repository, squashMergeOnGitHub(repository, "b", { below: ["a"] })),
      );
      const pushedBranches = yield* repository.branches;
      const pushedC = pushedBranches["c"];
      yield* mergeIn(repository, github, "b");
      const branches = yield* repository.branches;
      const labels = yield* labelsOf(repository, "c");
      expect({
        branchC: branches["c"],
        calls: github.calls,
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
    }),
  );

  itEffect(
    "republishes the changes below the lowest one with conflicts, and leaves the rest local",
    () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b", "c", "d");
        const pushed = yield* repository.branches;
        const github = fakeGitHub(
          {
            ...openPullRequestsAB,
            c: openPullRequest("b", 3, "c"),
            d: openPullRequest("c", 4, "d"),
          },
          [],
          mergingIn(
            repository,
            Effect.gen(function* () {
              yield* squashMergeOnGitHub(repository, "a");
              yield* moveTrunkOnGitHub(repository, "c.txt");
            }),
          ),
        );
        yield* mergeIn(repository, github, "a");
        const branches = yield* repository.branches;
        const labels = yield* labelsOf(repository, "c", "d");
        expect({
          branches: [branches["b"], branches["c"], branches["d"]],
          calls: github.calls,
          log: yield* repository.log,
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          branches: [yield* repository.commitOf("b"), pushed["c"], pushed["d"]],
          calls: ["merge #1", "base #2 → main"],
          log: ["b [b]", "c [c]", "d [d]"],
          stderr: [
            "merging #1",
            "merged up to #1",
            "abandoned the changes whose pull requests merged: a",
            `left these changes local, since they or a change below them have conflicts:\n${labels}`,
          ],
          stdout: [],
        });
      }),
  );

  itEffect("fails before merging where the change named has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b", "c");
      yield* conflictWithTrunk(repository, "b", { pushed: ["a"] });
      const github = fakeGitHub(
        { ...openPullRequestsAB, c: openPullRequest("b", 3, "c") },
        stackOf(1, 2, 3),
        mergingIn(repository, squashMergeOnGitHub(repository, "b", { below: ["a"] })),
      );
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      const labels = yield* labelsOf(repository, "b");
      expect({ calls: github.calls, message: failure.message }).toStrictEqual({
        calls: [],
        message: `resolve the conflicts first:\n${labels}`,
      });
    }),
  );
});
