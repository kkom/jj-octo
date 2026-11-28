import { describe, expect } from "bun:test";

import { Effect } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { mergeIn, mergingIn, openPullRequestsAB } from "../../testing/merge";
import { openPullRequest, stackOf } from "../../testing/pull-requests";
import { pushedStack } from "../../testing/scratch-repository";
import { addWorkspace } from "../../testing/workspace";
import { merge } from "./merge";

// `c`, on the trunk `a` and `b` started from, with the other workspace's working copy on it.
const withOtherStack = Effect.gen(function* () {
  const repository = yield* pushedStack("a", "b");
  yield* repository.jj("new", "main", "-m", "c");
  yield* repository.jj("bookmark", "create", "c", "-r", "@");
  yield* repository.jj("git", "push", "--bookmark", "c");
  yield* addWorkspace(repository, "c");
  yield* repository.jj("new", "b");
  // `b` as GitHub rebased it in the merge.
  const rebased = { b: "" };
  const github = fakeGitHub(
    openPullRequestsAB,
    stackOf(1, 2),
    mergingIn(
      repository,
      Effect.gen(function* () {
        yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
        const branches = yield* repository.branches;
        rebased.b = branches["b"] ?? "";
      }),
    ),
  );
  return { github, rebased, repository };
});

describe("merge", () => {
  itEffect(
    "merges a stacked pull request through its stack, then syncs and republishes the rest",
    () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        const github = fakeGitHub(
          openPullRequestsAB,
          stackOf(1, 2),
          mergingIn(repository, squashMergeOnGitHub(repository, "a", { above: ["b"] })),
        );
        yield* mergeIn(repository, github, "a");
        expect(github.calls[0]).toBe("merge the stack up to #1");
        const log = yield* repository.log;
        const branches = yield* repository.branches;
        const commitB = yield* repository.commitOf("b");
        expect(log).toEqual(["b [b]"]);
        expect(branches["b"]).toBe(commitB);
      }),
  );

  itEffect("syncs the stack it merged, where another workspace's working copy is on it", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* addWorkspace(repository, "b");
      yield* repository.jj("new", "main", "-m", "c");
      const github = fakeGitHub(
        openPullRequestsAB,
        stackOf(1, 2),
        mergingIn(repository, squashMergeOnGitHub(repository, "a", { above: ["b"] })),
      );
      yield* mergeIn(repository, github, "a");
      expect({
        b: yield* repository.files("b"),
        log: yield* repository.log,
        workingCopy: yield* repository.files("@"),
      }).toStrictEqual({
        b: ["a.txt", "b.txt", "base.txt"],
        log: ["b [b]", "c []"],
        workingCopy: ["a.txt", "base.txt"],
      });
    }),
  );

  itEffect("rebases another workspace's change on the stack it merged whole", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* addWorkspace(repository, "b");
      yield* repository.jj("describe", "-r", "other@", "-m", "wip");
      yield* repository.jj("new", "main", "-m", "c");
      const github = fakeGitHub(
        openPullRequestsAB,
        stackOf(1, 2),
        mergingIn(
          repository,
          Effect.gen(function* () {
            yield* squashMergeOnGitHub(repository, "a", { deleted: false });
            yield* squashMergeOnGitHub(repository, "b", { deleted: false });
          }),
        ),
      );
      yield* mergeIn(repository, github, "b");
      expect({
        log: yield* repository.log,
        wip: yield* repository.files("other@"),
      }).toStrictEqual({
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
          const { github, rebased, repository } = yield* withOtherStack;
          yield* mergeIn(repository, github, "a");
          expect({
            b: yield* repository.commitOf("b"),
            c: yield* repository.files("c"),
          }).toStrictEqual({ b: rebased.b, c: ["base.txt"] });
        }),
    );

    itEffect("syncs that stack too with `allWorkspaces`", () =>
      Effect.gen(function* () {
        const { github, repository } = yield* withOtherStack;
        yield* merge("a", { allWorkspaces: true, cancelPrRuns: false }).pipe(
          inRepository(repository, github),
        );
        const files = yield* repository.files("c");
        expect(files).toEqual(["a.txt", "base.txt"]);
      }),
    );
  });

  // Rebased onto the trunk, the first merged change would conflict with the second's edit of the
  // same file, rather than coming out empty. GitHub may delete the merged branches only after the
  // fetch, so the fetch can't be relied on to drop them either.
  itEffect("drops every merged change, where a later one edited what an earlier one wrote", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b", "c");
      yield* repository.jj("edit", "b");
      yield* repository.write("a.txt", "a, edited by b\n");
      yield* repository.jj("new", "c");
      yield* repository.jj("git", "push", "--bookmark", "b", "--bookmark", "c");
      const github = fakeGitHub(
        { ...openPullRequestsAB, c: openPullRequest("b", 3, "c") },
        stackOf(1, 2, 3),
        mergingIn(
          repository,
          Effect.gen(function* () {
            yield* squashMergeOnGitHub(repository, "a", { above: ["b", "c"], deleted: false });
            yield* squashMergeOnGitHub(repository, "b", { above: ["c"], deleted: false });
          }),
        ),
      );
      yield* mergeIn(repository, github, "b");
      const log = yield* repository.log;
      const conflicted = yield* repository.jj(
        "log",
        "--no-graph",
        "-r",
        "conflicts()",
        "-T",
        "description",
      );
      expect(log).toEqual(["c [c]"]);
      expect(conflicted).toBe("");
    }),
  );

  // The stack merges as one commit, on a trunk that moved since the stack was pushed, and with an
  // unpushed change above it. Rebased onto the trunk, `a` would conflict with `b`'s edit.
  itEffect(
    "drops the merged changes of a stack merged as one commit, and rebases the change above",
    () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        yield* repository.jj("edit", "b");
        yield* repository.write("a.txt", "a, edited by b\n");
        yield* repository.jj("new", "b", "-m", "c");
        yield* repository.write("c.txt", "c\n");
        yield* repository.jj("git", "push", "--bookmark", "b");
        const github = fakeGitHub(
          openPullRequestsAB,
          stackOf(1, 2),
          mergingIn(
            repository,
            Effect.gen(function* () {
              yield* moveTrunkOnGitHub(repository);
              yield* squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
            }),
          ),
        );
        yield* mergeIn(repository, github, "b");
        const log = yield* repository.log;
        const conflicted = yield* repository.jj(
          "log",
          "--no-graph",
          "-r",
          "conflicts()",
          "-T",
          "description",
        );
        const merged = yield* repository.jj("log", "--no-graph", "-r", "@-", "-T", "description");
        const bookmarks = yield* repository.jj("bookmark", "list", "--all-remotes", "a", "b");
        expect(log).toEqual(["c []"]);
        expect(conflicted).toBe("");
        expect(merged).toBe("b (#1)\n");
        expect(bookmarks).toBe("");
      }),
  );

  itEffect("merges a pull request outside a stack alone", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      const github = fakeGitHub(
        openPullRequestsAB,
        [],
        mergingIn(repository, squashMergeOnGitHub(repository, "a")),
      );
      yield* mergeIn(repository, github, "a");
      expect(github.calls[0]).toBe("merge #1");
      const log = yield* repository.log;
      expect(log).toEqual(["b [b]"]);
    }),
  );

  itEffect("merges from the change below an empty working copy by default", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      const github = fakeGitHub(
        openPullRequestsAB,
        stackOf(1, 2),
        mergingIn(
          repository,
          Effect.gen(function* () {
            yield* squashMergeOnGitHub(repository, "a", { deleted: false });
            yield* squashMergeOnGitHub(repository, "b", { deleted: false });
          }),
        ),
      );
      yield* mergeIn(repository, github, "@");
      expect(github.calls).toEqual(["merge the stack up to #2"]);
      const log = yield* repository.log;
      expect(log).toEqual([]);
    }),
  );

  itEffect("merges nothing outside a GitHub stack when the base isn't the trunk", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      const github = fakeGitHub(openPullRequestsAB, []);
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      expect(failure.message).toContain("#2 isn't in a GitHub stack, and its base is a");
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("merges nothing while a change has edits that aren't pushed", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("describe", "-r", "a", "-m", "a, reworded");
      const github = fakeGitHub(openPullRequestsAB, stackOf(1, 2));
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      expect(failure.message).toContain("these changes aren't pushed: a, b");
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("merges nothing for a change with no bookmark", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("describe", "-m", "c");
      const github = fakeGitHub(openPullRequestsAB, []);
      const failure = yield* Effect.flip(mergeIn(repository, github, "@"));
      expect(failure.message).toContain("needs a bookmark");
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("merges nothing for a bookmark with no open pull request", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      const github = fakeGitHub({}, []);
      const failure = yield* Effect.flip(mergeIn(repository, github, "b"));
      expect(failure.message).toContain("no open pull request for b");
      expect(github.calls).toEqual([]);
    }),
  );
});
