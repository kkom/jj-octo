import { describe, expect } from "bun:test";

import { Effect, Layer, String as EffectString } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHubHolding, setUpPullRequestsAB } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";
import { editLocally, syncing } from "../../testing/sync";

const fakeGitHubAB = fakeGitHubHolding(setUpPullRequestsAB());

layer(Layer.merge(pushedStack("a", "b"), fakeGitHubAB))("sync", (it) => {
  it("rebases every stack onto the moved trunk, and pushes nothing", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("new", "main", "-m", "c");
      yield* repository.jj("bookmark", "create", "c", "-r", "@");
      const pushed = yield* repository.branches;
      yield* moveTrunkOnGitHub();
      yield* syncing();
      expect({
        branches: yield* repository.branches,
        filesOfB: yield* repository.files("b"),
        filesOfC: yield* repository.files("c"),
      }).toStrictEqual({
        branches: { ...pushed, main: yield* repository.commitOf("main@origin") },
        filesOfB: ["a.txt", "b.txt", "base.txt", "trunk.txt"],
        filesOfC: ["base.txt", "trunk.txt"],
      });
    }));

  it("leaves a stack that conflicts with the moved trunk where it was", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("new", "main", "-m", "c");
      yield* repository.jj("bookmark", "create", "c", "-r", "@");
      yield* repository.write("trunk.txt", "c's own\n");
      yield* repository.jj("new", "b");
      yield* moveTrunkOnGitHub();
      yield* syncing();
      expect({
        conflicted: yield* repository.conflicted,
        files: yield* repository.files("b"),
        parent: yield* repository.description("c-"),
      }).toStrictEqual({
        conflicted: "",
        files: ["a.txt", "b.txt", "base.txt", "trunk.txt"],
        parent: "base",
      });
    }));

  // GitHub can delete a merged branch after the fetch, which leaves its bookmark on the trunk.
  it("abandons a merged change and forgets its bookmark, with the branch still on GitHub", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* squashMergeOnGitHub("a", { deleted: false });
      yield* syncing();
      expect({
        bookmarks: yield* repository.jj("bookmark", "list", "--all-remotes", "a"),
        log: yield* repository.log,
      }).toStrictEqual({ bookmarks: "", log: ["b [b]"] });
    }));

  // The fetch deletes the bookmark of a branch GitHub deleted, so nothing is left to forget.
  it("abandons a merged change whose branch GitHub deleted, without a warning", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* squashMergeOnGitHub("a");
      yield* syncing();
      const printed = yield* repository.printed;
      expect({
        bookmarks: yield* repository.jj("bookmark", "list", "--all-remotes", "a"),
        log: yield* repository.log,
        warned: EffectString.includes("Warning")(printed),
      }).toStrictEqual({ bookmarks: "", log: ["b [b]"], warned: false });
    }));

  // GitHub merges the stack as one commit, on a trunk that moved since the push. Rebased onto the
  // trunk, `a` would conflict with `b`'s edit, not come out empty. The branches are still on
  // GitHub, so the fetch doesn't drop the changes either.
  it("abandons every change whose pull request merged, and rebases the rest onto the trunk", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("edit", "b");
      yield* repository.write("a.txt", "a, edited by b\n");
      yield* repository.jj("new", "b", "-m", "c");
      yield* repository.write("c.txt", "c\n");
      yield* repository.jj("git", "push", "--bookmark", "b");
      yield* moveTrunkOnGitHub();
      yield* squashMergeOnGitHub("b", { below: ["a"], deleted: false });
      yield* syncing();
      expect({
        bookmarks: yield* repository.jj("bookmark", "list", "--all-remotes", "a", "b"),
        conflicted: yield* repository.conflicted,
        files: yield* repository.files("@"),
        log: yield* repository.log,
      }).toStrictEqual({
        bookmarks: "",
        conflicted: "",
        files: ["a.txt", "b.txt", "base.txt", "c.txt", "trunk.txt"],
        log: ["c []"],
      });
    }));

  // As above, with the stack rebased locally by a sync between the push and the merge.
  it("abandons merged changes that a sync rebased since their push", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("edit", "b");
      yield* repository.write("a.txt", "a, edited by b\n");
      yield* repository.jj("new", "b", "-m", "c");
      yield* repository.write("c.txt", "c\n");
      yield* repository.jj("git", "push", "--bookmark", "b");
      yield* moveTrunkOnGitHub();
      yield* syncing();
      yield* moveTrunkOnGitHub("later.txt");
      yield* squashMergeOnGitHub("b", { below: ["a"], deleted: false });
      yield* syncing();
      expect({ files: yield* repository.files("@"), log: yield* repository.log }).toStrictEqual({
        files: ["a.txt", "b.txt", "base.txt", "c.txt", "later.txt", "trunk.txt"],
        log: ["c []"],
      });
    }));

  it("keeps a change edited after its pull request merged", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* squashMergeOnGitHub("a", { deleted: false });
      yield* editLocally;
      yield* syncing();
      expect({ files: yield* repository.files("a"), log: yield* repository.log }).toStrictEqual({
        files: ["a.txt", "base.txt", "local.txt"],
        log: ["a [a]", "b [b]"],
      });
    }));

  it("takes the rest of a stack as GitHub rebased it after a merge", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* squashMergeOnGitHub("a", { above: ["b"] });
      yield* syncing();
      expect({ files: yield* repository.files("b"), log: yield* repository.log }).toStrictEqual({
        files: ["a.txt", "b.txt", "base.txt"],
        log: ["b [b]"],
      });
    }));

  // The fetch drops the old commits of a branch GitHub rewrote, which takes whatever was on them
  // off the stack.
  describe("after GitHub rebased the rest of a stack", () => {
    it("keeps the working copy on top of the stack", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        yield* syncing();
        const bookmarks = yield* repository.jj("log", "--no-graph", "-r", "@-", "-T", "bookmarks");
        expect(bookmarks).toBe("b");
      }));

    it("keeps editing the change the working copy was", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("edit", "b");
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        yield* syncing();
        const bookmarks = yield* repository.jj("log", "--no-graph", "-r", "@", "-T", "bookmarks");
        expect(bookmarks).toBe("b");
      }));

    it("keeps a change that isn't pushed on top of the stack", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.write("c.txt", "c\n");
        yield* repository.jj("describe", "-m", "c");
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        yield* syncing();
        const log = yield* repository.log;
        expect(log).toStrictEqual(["b [b]", "c []"]);
      }));
  });
});
