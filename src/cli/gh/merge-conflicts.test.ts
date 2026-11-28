import { afterAll, describe, expect } from "bun:test";

import { Effect } from "effect";
import { TestConsole } from "effect/testing";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { conflictWithTrunk, labelsOf } from "../../testing/conflicts";
import { fakeGitHub } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { mergeIn, mergingIn, openPullRequestsAB } from "../../testing/merge";
import { openPullRequest, stackOf } from "../../testing/pull-requests";
import { pushedStack, removeScratchRepositories } from "../../testing/scratch-repository";

afterAll(removeScratchRepositories);

describe("merge, where changes have conflicts", () => {
  itEffect(
    "rebases the rest of the stack even where it conflicts with the trunk, and leaves it local",
    () =>
      Effect.gen(function* () {
        const repository = pushedStack("a", "b");
        const pushedB = repository.branches()["b"];
        const github = fakeGitHub(
          openPullRequestsAB,
          [],
          mergingIn(repository, () => {
            squashMergeOnGitHub(repository, "a");
            repository.writeOnGitHub("b.txt", "somebody else's\n");
            repository.git("add", ".");
            repository.git("commit", "--quiet", "-m", "another pull request");
            repository.git("push", "--quiet", "origin", "main");
          }),
        );
        yield* mergeIn(repository, github, "a");
        expect({
          branchB: repository.branches()["b"],
          conflicted: repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description"),
          log: repository.log(),
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
            `left these changes local, since they or a change below them have conflicts:\n${labelsOf(repository, "b")}`,
          ],
          stdout: [],
        });
      }),
  );

  itEffect("merges a change and the ones below it where a change above has conflicts", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      conflictWithTrunk(repository, "c", { pushed: ["a", "b"] });
      const github = fakeGitHub(
        { ...openPullRequestsAB, c: openPullRequest("b", 3, "c") },
        stackOf(1, 2, 3),
        mergingIn(repository, () => {
          squashMergeOnGitHub(repository, "b", { below: ["a"] });
        }),
      );
      const pushedC = repository.branches()["c"];
      yield* mergeIn(repository, github, "b");
      expect({
        branchC: repository.branches()["c"],
        calls: github.calls,
        log: repository.log(),
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
          `left these changes local, since they or a change below them have conflicts:\n${labelsOf(repository, "c")}`,
        ],
        stdout: [],
      });
    }),
  );

  itEffect(
    "republishes the changes below the lowest one with conflicts, and leaves the rest local",
    () =>
      Effect.gen(function* () {
        const repository = pushedStack("a", "b", "c", "d");
        const pushed = repository.branches();
        const github = fakeGitHub(
          {
            ...openPullRequestsAB,
            c: openPullRequest("b", 3, "c"),
            d: openPullRequest("c", 4, "d"),
          },
          [],
          mergingIn(repository, () => {
            squashMergeOnGitHub(repository, "a");
            moveTrunkOnGitHub(repository, "c.txt");
          }),
        );
        yield* mergeIn(repository, github, "a");
        expect({
          branches: [
            repository.branches()["b"],
            repository.branches()["c"],
            repository.branches()["d"],
          ],
          calls: github.calls,
          log: repository.log(),
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          branches: [repository.commitOf("b"), pushed["c"], pushed["d"]],
          calls: ["merge #1", "base #2 → main"],
          log: ["b [b]", "c [c]", "d [d]"],
          stderr: [
            "merging #1",
            "merged up to #1",
            "abandoned the changes whose pull requests merged: a",
            `left these changes local, since they or a change below them have conflicts:\n${labelsOf(repository, "c", "d")}`,
          ],
          stdout: [],
        });
      }),
  );

  itEffect("fails before merging where the change named has conflicts", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      conflictWithTrunk(repository, "b", { pushed: ["a"] });
      const github = fakeGitHub(
        { ...openPullRequestsAB, c: openPullRequest("b", 3, "c") },
        stackOf(1, 2, 3),
        mergingIn(repository, () => {
          squashMergeOnGitHub(repository, "b", { below: ["a"] });
        }),
      );
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      expect({ calls: github.calls, message: failure.message }).toStrictEqual({
        calls: [],
        message: `resolve the conflicts first:\n${labelsOf(repository, "b")}`,
      });
    }),
  );
});
