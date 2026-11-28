import { describe, expect } from "bun:test";

import { Effect } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { itEffect } from "../../testing/it-effect";
import { pushedStack } from "../../testing/scratch-repository";
import { editLocally, syncing } from "../../testing/sync";

describe("sync", () => {
  itEffect("rebases every stack onto the moved trunk, and pushes nothing", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("new", "main", "-m", "c");
      yield* repository.jj("bookmark", "create", "c", "-r", "@");
      const pushed = yield* repository.branches;
      yield* moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      const filesOfB = yield* repository.files("b");
      const filesOfC = yield* repository.files("c");
      const branches = yield* repository.branches;
      expect(filesOfB).toContain("trunk.txt");
      expect(filesOfC).toContain("trunk.txt");
      expect(branches).toEqual({
        ...pushed,
        main: branches["main"] ?? "",
      });
    }),
  );

  itEffect("leaves a stack that conflicts with the moved trunk where it was", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("new", "main", "-m", "c");
      yield* repository.jj("bookmark", "create", "c", "-r", "@");
      yield* repository.write("trunk.txt", "c's own\n");
      yield* repository.jj("new", "b");
      yield* moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      const conflicts = yield* repository.jj(
        "log",
        "--no-graph",
        "-r",
        "conflicts()",
        "-T",
        "change_id",
      );
      const parent = yield* repository.jj("log", "--no-graph", "-r", "c-", "-T", "description");
      const files = yield* repository.files("b");
      expect(conflicts).toBe("");
      expect(parent).toBe("base\n");
      expect(files).toContain("trunk.txt");
    }),
  );

  // GitHub can delete a merged branch after the fetch, which leaves its bookmark on the trunk.
  itEffect(
    "abandons a merged change and forgets its bookmark, with the branch still on GitHub",
    () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        yield* squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository);
        const log = yield* repository.log;
        const bookmarks = yield* repository.jj("bookmark", "list", "--all-remotes", "a");
        expect(log).toEqual(["b [b]"]);
        expect(bookmarks).toBe("");
      }),
  );

  // The fetch deletes the bookmark of a branch deleted on GitHub, so there's nothing left to forget.
  itEffect("abandons a merged change whose branch GitHub deleted, without a warning", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* squashMergeOnGitHub(repository, "a");
      yield* syncing(repository);
      const log = yield* repository.log;
      const bookmarks = yield* repository.jj("bookmark", "list", "--all-remotes", "a");
      expect(log).toEqual(["b [b]"]);
      expect(bookmarks).toBe("");
      expect(repository.printed()).not.toContain("Warning");
    }),
  );

  // GitHub merges a stack as one commit, on a trunk that moved since the stack was pushed. Rebased
  // onto the trunk, `a` would conflict with `b`'s edit of the same file, rather than come out
  // empty. The branches are still on GitHub, so the fetch doesn't drop the changes either.
  itEffect(
    "abandons every change whose pull request merged, and rebases the rest onto the trunk",
    () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        yield* repository.jj("edit", "b");
        yield* repository.write("a.txt", "a, edited by b\n");
        yield* repository.jj("new", "b", "-m", "c");
        yield* repository.write("c.txt", "c\n");
        yield* repository.jj("git", "push", "--bookmark", "b");
        yield* moveTrunkOnGitHub(repository);
        yield* squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
        yield* syncing(repository);
        const log = yield* repository.log;
        const conflicts = yield* repository.jj(
          "log",
          "--no-graph",
          "-r",
          "conflicts()",
          "-T",
          "description",
        );
        const files = yield* repository.files("@");
        const bookmarks = yield* repository.jj("bookmark", "list", "--all-remotes", "a", "b");
        expect(log).toEqual(["c []"]);
        expect(conflicts).toBe("");
        expect(files).toEqual(["a.txt", "b.txt", "base.txt", "c.txt", "trunk.txt"]);
        expect(bookmarks).toBe("");
      }),
  );

  // As above, with the stack rebased locally by a sync between the push and the merge.
  itEffect("abandons merged changes that a sync rebased since their push", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("edit", "b");
      yield* repository.write("a.txt", "a, edited by b\n");
      yield* repository.jj("new", "b", "-m", "c");
      yield* repository.write("c.txt", "c\n");
      yield* repository.jj("git", "push", "--bookmark", "b");
      yield* moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      yield* moveTrunkOnGitHub(repository, "later.txt");
      yield* squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
      yield* syncing(repository);
      const log = yield* repository.log;
      const files = yield* repository.files("@");
      expect(log).toEqual(["c []"]);
      expect(files).toEqual(["a.txt", "b.txt", "base.txt", "c.txt", "later.txt", "trunk.txt"]);
    }),
  );

  itEffect("keeps a change edited after its pull request merged", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* squashMergeOnGitHub(repository, "a", { deleted: false });
      yield* editLocally(repository);
      yield* syncing(repository);
      const log = yield* repository.log;
      const files = yield* repository.files("a");
      expect(log).toEqual(["a [a]", "b [b]"]);
      expect(files).toEqual(["a.txt", "base.txt", "local.txt"]);
    }),
  );

  itEffect("takes the rest of a stack as GitHub rebased it after a merge", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
      yield* syncing(repository);
      const log = yield* repository.log;
      const files = yield* repository.files("b");
      expect(log).toEqual(["b [b]"]);
      expect(files).toEqual(["a.txt", "b.txt", "base.txt"]);
    }),
  );

  // The fetch drops the old commits of a branch GitHub rewrote, which takes whatever was on them
  // off the stack.
  describe("after GitHub rebased the rest of a stack", () => {
    itEffect("keeps the working copy on top of the stack", () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
        yield* syncing(repository);
        const bookmarks = yield* repository.jj("log", "--no-graph", "-r", "@-", "-T", "bookmarks");
        expect(bookmarks).toBe("b");
      }),
    );

    itEffect("keeps editing the change the working copy was", () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        yield* repository.jj("edit", "b");
        yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
        yield* syncing(repository);
        const bookmarks = yield* repository.jj("log", "--no-graph", "-r", "@", "-T", "bookmarks");
        expect(bookmarks).toBe("b");
      }),
    );

    itEffect("keeps a change that isn't pushed on top of the stack", () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        yield* repository.write("c.txt", "c\n");
        yield* repository.jj("describe", "-m", "c");
        yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
        yield* syncing(repository);
        const log = yield* repository.log;
        expect(log).toEqual(["b [b]", "c []"]);
      }),
    );
  });
});
