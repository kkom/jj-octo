import { describe, expect } from "bun:test";

import { Effect, Layer, Ref } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import {
  fakeGitHub,
  gitHubCalls,
  setUpPullRequestsAB,
  setUpPullRequestsABC,
} from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { merging } from "../../testing/merge";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";
import { addWorkspace } from "../../testing/workspace";
import { merge, NotMergeable } from "./merge";
import { NotAStack } from "./stack/changes";

// `c`, on the trunk `a` and `b` started from, with the other workspace's working copy on it.
// `rebasedB` reads the commit of `b` as GitHub rebased it in the merge of `a`.
const withOtherStack = Effect.gen(function* () {
  const repository = yield* ScratchRepository;
  yield* repository.jj("new", "main", "-m", "c");
  yield* repository.jj("bookmark", "create", "c", "-r", "@");
  yield* repository.jj("git", "push", "--bookmark", "c");
  yield* addWorkspace("c");
  yield* repository.jj("new", "b");
  const rebasedB = yield* Ref.make("");
  yield* setUpPullRequestsAB({
    onMerge: () =>
      Effect.gen(function* () {
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        const branches = yield* repository.branches;
        yield* Ref.set(rebasedB, branches["b"] ?? "");
      }),
  });
  return { rebasedB: Ref.get(rebasedB) };
});

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))("merge", (it) => {
  it("merges a stacked pull request through its stack, then syncs and republishes the rest", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* setUpPullRequestsAB({
        onMerge: () => squashMergeOnGitHub("a", { above: ["b"] }),
      });
      yield* merging("a");
      const branches = yield* repository.branches;
      expect({
        b: branches["b"],
        calls: yield* gitHubCalls,
        log: yield* repository.log,
      }).toStrictEqual({
        b: yield* repository.commitOf("b"),
        calls: ["merge the stack up to #1"],
        log: ["b [b]"],
      });
    }));

  it("syncs the stack it merged, where another workspace's working copy is on it", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* addWorkspace("b");
      yield* repository.jj("new", "main", "-m", "c");
      yield* setUpPullRequestsAB({
        onMerge: () => squashMergeOnGitHub("a", { above: ["b"] }),
      });
      yield* merging("a");
      expect({
        b: yield* repository.files("b"),
        log: yield* repository.log,
        workingCopy: yield* repository.files("@"),
      }).toStrictEqual({
        b: ["a.txt", "b.txt", "base.txt"],
        log: ["b [b]", "c []"],
        workingCopy: ["a.txt", "base.txt"],
      });
    }));

  it("rebases another workspace's change on the stack it merged whole", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* addWorkspace("b");
      yield* repository.jj("describe", "-r", "other@", "-m", "wip");
      yield* repository.jj("new", "main", "-m", "c");
      yield* setUpPullRequestsAB({
        onMerge: () =>
          Effect.gen(function* () {
            yield* squashMergeOnGitHub("a", { deleted: false });
            yield* squashMergeOnGitHub("b", { deleted: false });
          }),
      });
      yield* merging("b");
      expect({
        log: yield* repository.log,
        wip: yield* repository.files("other@"),
      }).toStrictEqual({
        log: ["c []", "wip []"],
        wip: ["a.txt", "b.txt", "base.txt"],
      });
    }));

  describe("where another workspace's working copy is on a separate stack", () => {
    it("leaves that stack where it was, and takes the rest of the merged stack from GitHub", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        const { rebasedB } = yield* withOtherStack;
        yield* merging("a");
        expect({
          b: yield* repository.commitOf("b"),
          c: yield* repository.files("c"),
        }).toStrictEqual({ b: yield* rebasedB, c: ["base.txt"] });
      }));

    it("syncs that stack too with `allWorkspaces`", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* withOtherStack;
        yield* merge("a", { allWorkspaces: true, cancelPrRuns: false });
        const files = yield* repository.files("c");
        expect(files).toStrictEqual(["a.txt", "base.txt"]);
      }));
  });

  // The stack merges as one commit, on a trunk that moved since the push, with an unpushed change
  // above it. Rebased onto the trunk, `a` would conflict with `b`'s edit.
  it("drops the merged changes of a stack merged as one commit, and rebases the change above", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("edit", "b");
      yield* repository.write("a.txt", "a, edited by b\n");
      yield* repository.jj("new", "b", "-m", "c");
      yield* repository.write("c.txt", "c\n");
      yield* repository.jj("git", "push", "--bookmark", "b");
      yield* setUpPullRequestsAB({
        onMerge: () =>
          Effect.gen(function* () {
            yield* moveTrunkOnGitHub();
            yield* squashMergeOnGitHub("b", { below: ["a"], deleted: false });
          }),
      });
      yield* merging("b");
      expect({
        bookmarks: yield* repository.jj("bookmark", "list", "--all-remotes", "a", "b"),
        conflicted: yield* repository.conflicted,
        log: yield* repository.log,
        merged: yield* repository.description("@-"),
      }).toStrictEqual({
        bookmarks: "",
        conflicted: "",
        log: ["c []"],
        merged: "b (#2)",
      });
    }));

  it("merges a pull request outside a stack alone", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* setUpPullRequestsAB({ onMerge: () => squashMergeOnGitHub("a"), stacks: [] });
      yield* merging("a");
      expect({ calls: yield* gitHubCalls, log: yield* repository.log }).toStrictEqual({
        calls: ["merge #1"],
        log: ["b [b]"],
      });
    }));

  // GitHub doesn't move the pull requests based on a merged branch it keeps, so the republish does.
  it("moves the next pull request onto the trunk, where GitHub keeps the merged branch", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* setUpPullRequestsAB({
        onMerge: () => squashMergeOnGitHub("a", { deleted: false }),
        stacks: [],
      });
      yield* merging("a");
      expect({ calls: yield* gitHubCalls, log: yield* repository.log }).toStrictEqual({
        calls: ["merge #1", "base #2 → main"],
        log: ["b [b]"],
      });
    }));

  it("merges from the change below an empty working copy by default", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* setUpPullRequestsAB({
        onMerge: () =>
          Effect.gen(function* () {
            yield* squashMergeOnGitHub("a", { deleted: false });
            yield* squashMergeOnGitHub("b", { deleted: false });
          }),
      });
      yield* merging("@");
      expect({ calls: yield* gitHubCalls, log: yield* repository.log }).toStrictEqual({
        calls: ["merge the stack up to #2"],
        log: [],
      });
    }));

  it("merges nothing outside a GitHub stack when the base isn't the trunk", () =>
    Effect.gen(function* () {
      yield* setUpPullRequestsAB({ stacks: [] });
      const failure = yield* Effect.flip(merging("b"));
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NotMergeable.make({
          message:
            "#2 isn't in a GitHub stack and its base is a, not the trunk; run `jj gh submit` to register the stack, or merge the changes below it first",
        }),
      });
    }));

  it("merges nothing while a change has edits that aren't pushed", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("describe", "-r", "a", "-m", "a, reworded");
      yield* setUpPullRequestsAB();
      const failure = yield* Effect.flip(merging("b"));
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NotMergeable.make({
          message: "these changes aren't pushed: a, b; run `jj gh submit` first",
        }),
      });
    }));

  it("merges nothing for a change with no bookmark", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("describe", "-m", "c");
      yield* setUpPullRequestsAB({ stacks: [] });
      const failure = yield* Effect.flip(merging("@"));
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NotAStack.make({
          message: `these changes have no bookmark naming their branch:\n${yield* repository.labels("@")}`,
        }),
      });
    }));

  it("merges nothing for a bookmark with no open pull request", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(merging("b"));
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NotMergeable.make({
          message: "no open pull request for b; run `jj gh submit` first",
        }),
      });
    }));
});

layer(Layer.merge(pushedStack("a", "b", "c"), fakeGitHub))("merge, with three changes", (it) => {
  // Rebased onto the trunk, the first merged change would conflict with the second's edit, not come
  // out empty. GitHub may delete the merged branches after the fetch, so the fetch may not drop
  // them either.
  it("drops every merged change, where a later one edited what an earlier one wrote", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("edit", "b");
      yield* repository.write("a.txt", "a, edited by b\n");
      yield* repository.jj("new", "c");
      yield* repository.jj("git", "push", "--bookmark", "b", "--bookmark", "c");
      yield* setUpPullRequestsABC({
        onMerge: () =>
          Effect.gen(function* () {
            yield* squashMergeOnGitHub("a", { above: ["b", "c"], deleted: false });
            yield* squashMergeOnGitHub("b", { above: ["c"], deleted: false });
          }),
      });
      yield* merging("b");
      expect({
        conflicted: yield* repository.conflicted,
        log: yield* repository.log,
      }).toStrictEqual({
        conflicted: "",
        log: ["c [c]"],
      });
    }));
});
