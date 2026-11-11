import { afterAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { conflictWithTrunk, labelsOf } from "../../testing/conflicts";
import { fakeConsole } from "../../testing/fake-console";
import { fakeGitHub, openPullRequest, stackOf } from "../../testing/fake-github";
import { mergeIn, mergingIn } from "../../testing/merge";
import { pushedStack, removeScratchRepositories } from "../../testing/scratch-repository";

afterAll(removeScratchRepositories);

const open = { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") };

describe("merge, where changes have conflicts", () => {
  it("rebases the rest of the stack even where it conflicts with the trunk, and leaves it local", async () => {
    const repository = pushedStack("a", "b");
    const pushedB = repository.branches()["b"];
    const github = fakeGitHub(
      open,
      [],
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "a");
        repository.writeOnGitHub("b.txt", "somebody else's\n");
        repository.git("add", ".");
        repository.git("commit", "--quiet", "-m", "another pull request");
        repository.git("push", "--quiet", "origin", "main");
      }),
    );
    const console = fakeConsole();
    await Effect.runPromise(console.provide(mergeIn(repository, github, "a")));
    expect({
      branchB: repository.branches()["b"],
      conflicted: repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description"),
      log: repository.log(),
      printed: console.printed,
    }).toStrictEqual({
      branchB: pushedB,
      conflicted: "b\n",
      log: ["b [b]"],
      printed: [
        { stream: "stderr", text: "merging #1" },
        { stream: "stderr", text: "merged up to #1" },
        { stream: "stderr", text: "abandoned the changes whose pull requests merged: a" },
        {
          stream: "stderr",
          text: `left these changes local, since they or a change below them have conflicts:\n${labelsOf(repository, "b")}`,
        },
      ],
    });
  });

  it("merges a change and the ones below it where a change above has conflicts", async () => {
    const repository = pushedStack("a", "b", "c");
    conflictWithTrunk(repository, "c", { pushed: ["a", "b"] });
    const github = fakeGitHub(
      { ...open, c: openPullRequest("b", 3, "c") },
      stackOf(1, 2, 3),
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "b", { below: ["a"] });
      }),
    );
    const pushedC = repository.branches()["c"];
    const console = fakeConsole();
    await Effect.runPromise(console.provide(mergeIn(repository, github, "b")));
    expect({
      branchC: repository.branches()["c"],
      calls: github.calls,
      log: repository.log(),
      printed: console.printed,
    }).toStrictEqual({
      branchC: pushedC,
      calls: ["merge the stack up to #2"],
      log: ["c [c]"],
      printed: [
        { stream: "stderr", text: "merging #1, #2" },
        { stream: "stderr", text: "merged up to #2" },
        { stream: "stderr", text: "abandoned the changes whose pull requests merged: a, b" },
        {
          stream: "stderr",
          text: `left these changes local, since they or a change below them have conflicts:\n${labelsOf(repository, "c")}`,
        },
      ],
    });
  });

  it("republishes the changes below the lowest one with conflicts, and leaves the rest local", async () => {
    const repository = pushedStack("a", "b", "c", "d");
    const pushed = repository.branches();
    const github = fakeGitHub(
      {
        ...open,
        c: openPullRequest("b", 3, "c"),
        d: openPullRequest("c", 4, "d"),
      },
      [],
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "a");
        moveTrunkOnGitHub(repository, "c.txt");
      }),
    );
    const console = fakeConsole();
    await Effect.runPromise(console.provide(mergeIn(repository, github, "a")));
    const commitOf = (bookmark: string) =>
      repository.jj("log", "--no-graph", "-r", bookmark, "-T", "commit_id");
    expect({
      branches: [
        repository.branches()["b"],
        repository.branches()["c"],
        repository.branches()["d"],
      ],
      calls: github.calls,
      log: repository.log(),
      printed: console.printed,
    }).toStrictEqual({
      branches: [commitOf("b"), pushed["c"], pushed["d"]],
      calls: ["merge #1", "base #2 → main"],
      log: ["b [b]", "c [c]", "d [d]"],
      printed: [
        { stream: "stderr", text: "merging #1" },
        { stream: "stderr", text: "merged up to #1" },
        { stream: "stderr", text: "abandoned the changes whose pull requests merged: a" },
        {
          stream: "stderr",
          text: `left these changes local, since they or a change below them have conflicts:\n${labelsOf(repository, "c", "d")}`,
        },
      ],
    });
  });

  it("fails before merging where the change named has conflicts", async () => {
    const repository = pushedStack("a", "b", "c");
    conflictWithTrunk(repository, "b", { pushed: ["a"] });
    const github = fakeGitHub(
      { ...open, c: openPullRequest("b", 3, "c") },
      stackOf(1, 2, 3),
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "b", { below: ["a"] });
      }),
    );
    const failure = await Effect.runPromise(Effect.flip(mergeIn(repository, github, "b")));
    expect({ calls: github.calls, message: failure.message }).toStrictEqual({
      calls: [],
      message: `resolve the conflicts first:\n${labelsOf(repository, "b")}`,
    });
  });
});
