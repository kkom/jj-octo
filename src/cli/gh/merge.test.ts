import { afterAll, describe, expect } from "bun:test";

import { Effect } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { mergeIn, mergingIn, openPullRequestsAB } from "../../testing/merge";
import { openPullRequest, stackOf } from "../../testing/pull-requests";
import { pushedStack, removeScratchRepositories } from "../../testing/scratch-repository";
import { addWorkspace } from "../../testing/workspace";
import { merge } from "./merge";

afterAll(removeScratchRepositories);

// `c`, on the trunk `a` and `b` started from, with the other workspace's working copy on it.
const withOtherStack = () => {
  const repository = pushedStack("a", "b");
  repository.jj("new", "main", "-m", "c");
  repository.jj("bookmark", "create", "c", "-r", "@");
  repository.jj("git", "push", "--bookmark", "c");
  addWorkspace(repository, "c");
  repository.jj("new", "b");
  // `b` as GitHub rebased it in the merge.
  const rebased = { b: "" };
  const github = fakeGitHub(
    openPullRequestsAB,
    stackOf(1, 2),
    mergingIn(repository, () => {
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      rebased.b = repository.branches()["b"] ?? "";
    }),
  );
  return { github, rebased, repository };
};

describe("merge", () => {
  itEffect(
    "merges a stacked pull request through its stack, then syncs and republishes the rest",
    () =>
      Effect.gen(function* () {
        const repository = pushedStack("a", "b");
        const github = fakeGitHub(
          openPullRequestsAB,
          stackOf(1, 2),
          mergingIn(repository, () => {
            squashMergeOnGitHub(repository, "a", { above: ["b"] });
          }),
        );
        yield* mergeIn(repository, github, "a");
        expect(github.calls[0]).toBe("merge the stack up to #1");
        expect(repository.log()).toEqual(["b [b]"]);
        expect(repository.branches()["b"]).toBe(repository.commitOf("b"));
      }),
  );

  itEffect("syncs the stack it merged, where another workspace's working copy is on it", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      addWorkspace(repository, "b");
      repository.jj("new", "main", "-m", "c");
      const github = fakeGitHub(
        openPullRequestsAB,
        stackOf(1, 2),
        mergingIn(repository, () => {
          squashMergeOnGitHub(repository, "a", { above: ["b"] });
        }),
      );
      yield* mergeIn(repository, github, "a");
      expect({
        b: repository.files("b"),
        log: repository.log(),
        workingCopy: repository.files("@"),
      }).toStrictEqual({
        b: ["a.txt", "b.txt", "base.txt"],
        log: ["b [b]", "c []"],
        workingCopy: ["a.txt", "base.txt"],
      });
    }),
  );

  itEffect("rebases another workspace's change on the stack it merged whole", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      addWorkspace(repository, "b");
      repository.jj("describe", "-r", "other@", "-m", "wip");
      repository.jj("new", "main", "-m", "c");
      const github = fakeGitHub(
        openPullRequestsAB,
        stackOf(1, 2),
        mergingIn(repository, () => {
          squashMergeOnGitHub(repository, "a", { deleted: false });
          squashMergeOnGitHub(repository, "b", { deleted: false });
        }),
      );
      yield* mergeIn(repository, github, "b");
      expect({ log: repository.log(), wip: repository.files("other@") }).toStrictEqual({
        log: ["c []", "wip []"],
        wip: ["a.txt", "b.txt", "base.txt"],
      });
    }),
  );

  describe("where another workspace's working copy is on a separate stack", () => {
    itEffect(
      "leaves that stack where it was, and takes the rest of the merged stack from GitHub",
      () =>
        Effect.gen(function* () {
          const { github, rebased, repository } = withOtherStack();
          yield* mergeIn(repository, github, "a");
          expect({
            b: repository.commitOf("b"),
            c: repository.files("c"),
          }).toStrictEqual({ b: rebased.b, c: ["base.txt"] });
        }),
    );

    itEffect("syncs that stack too with `allWorkspaces`", () =>
      Effect.gen(function* () {
        const { github, repository } = withOtherStack();
        yield* merge("a", { allWorkspaces: true, cancelPrRuns: false }).pipe(
          inRepository(repository, github),
        );
        expect(repository.files("c")).toEqual(["a.txt", "base.txt"]);
      }),
    );
  });

  // Rebased onto the trunk, the first merged change would conflict with the second's edit of the
  // same file, rather than coming out empty. GitHub may delete the merged branches only after the
  // fetch, so the fetch can't be relied on to drop them either.
  itEffect("drops every merged change, where a later one edited what an earlier one wrote", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      repository.jj("edit", "b");
      repository.write("a.txt", "a, edited by b\n");
      repository.jj("new", "c");
      repository.jj("git", "push", "--bookmark", "b", "--bookmark", "c");
      const github = fakeGitHub(
        { ...openPullRequestsAB, c: openPullRequest("b", 3, "c") },
        stackOf(1, 2, 3),
        mergingIn(repository, () => {
          squashMergeOnGitHub(repository, "a", { above: ["b", "c"], deleted: false });
          squashMergeOnGitHub(repository, "b", { above: ["c"], deleted: false });
        }),
      );
      yield* mergeIn(repository, github, "b");
      expect(repository.log()).toEqual(["c [c]"]);
      expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description")).toBe("");
    }),
  );

  // The stack merges as one commit, on a trunk that moved since the stack was pushed, and with an
  // unpushed change above it. Rebased onto the trunk, `a` would conflict with `b`'s edit.
  itEffect(
    "drops the merged changes of a stack merged as one commit, and rebases the change above",
    () =>
      Effect.gen(function* () {
        const repository = pushedStack("a", "b");
        repository.jj("edit", "b");
        repository.write("a.txt", "a, edited by b\n");
        repository.jj("new", "b", "-m", "c");
        repository.write("c.txt", "c\n");
        repository.jj("git", "push", "--bookmark", "b");
        const github = fakeGitHub(
          openPullRequestsAB,
          stackOf(1, 2),
          mergingIn(repository, () => {
            moveTrunkOnGitHub(repository);
            squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
          }),
        );
        yield* mergeIn(repository, github, "b");
        expect(repository.log()).toEqual(["c []"]);
        expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description")).toBe(
          "",
        );
        expect(repository.jj("log", "--no-graph", "-r", "@-", "-T", "description")).toBe(
          "b (#1)\n",
        );
        expect(repository.jj("bookmark", "list", "--all-remotes", "a", "b")).toBe("");
      }),
  );

  itEffect("merges a pull request outside a stack alone", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      const github = fakeGitHub(
        openPullRequestsAB,
        [],
        mergingIn(repository, () => {
          squashMergeOnGitHub(repository, "a");
        }),
      );
      yield* mergeIn(repository, github, "a");
      expect(github.calls[0]).toBe("merge #1");
      expect(repository.log()).toEqual(["b [b]"]);
    }),
  );

  itEffect("merges from the change below an empty working copy by default", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      const github = fakeGitHub(
        openPullRequestsAB,
        stackOf(1, 2),
        mergingIn(repository, () => {
          squashMergeOnGitHub(repository, "a", { deleted: false });
          squashMergeOnGitHub(repository, "b", { deleted: false });
        }),
      );
      yield* mergeIn(repository, github, "@");
      expect(github.calls).toEqual(["merge the stack up to #2"]);
      expect(repository.log()).toEqual([]);
    }),
  );

  itEffect("merges nothing outside a GitHub stack when the base isn't the trunk", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      const github = fakeGitHub(openPullRequestsAB, []);
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      expect(failure.message).toContain("#2 isn't in a GitHub stack, and its base is a");
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("merges nothing while a change has edits that aren't pushed", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      repository.jj("describe", "-r", "a", "-m", "a, reworded");
      const github = fakeGitHub(openPullRequestsAB, stackOf(1, 2));
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      expect(failure.message).toContain("these changes aren't pushed: a, b");
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("merges nothing for a change with no bookmark", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      repository.jj("describe", "-m", "c");
      const github = fakeGitHub(openPullRequestsAB, []);
      const failure = yield* Effect.flip(mergeIn(repository, github, "@"));
      expect(failure.message).toContain("needs a bookmark");
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("merges nothing for a bookmark with no open pull request", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      const github = fakeGitHub({}, []);
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      expect(failure.message).toContain("no open pull request for b");
      expect(github.calls).toEqual([]);
    }),
  );
});
