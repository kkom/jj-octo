import { afterAll, beforeEach, describe, expect } from "bun:test";

import { Effect } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { itEffect } from "../../testing/it-effect";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { editLocally, syncing } from "../../testing/sync";

afterAll(removeScratchRepositories);

describe("sync", () => {
  let repository: ScratchRepository;

  beforeEach(() => {
    repository = pushedStack("a", "b");
  });

  itEffect("rebases every stack onto the moved trunk, and pushes nothing", () =>
    Effect.gen(function* () {
      repository.jj("new", "main", "-m", "c");
      repository.jj("bookmark", "create", "c", "-r", "@");
      const pushed = repository.branches();
      moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      expect(repository.files("b")).toContain("trunk.txt");
      expect(repository.files("c")).toContain("trunk.txt");
      expect(repository.branches()).toEqual({
        ...pushed,
        main: repository.branches()["main"] ?? "",
      });
    }),
  );

  itEffect("leaves a stack that conflicts with the moved trunk where it was", () =>
    Effect.gen(function* () {
      repository.jj("new", "main", "-m", "c");
      repository.jj("bookmark", "create", "c", "-r", "@");
      repository.write("trunk.txt", "c's own\n");
      repository.jj("new", "b");
      moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "change_id")).toBe("");
      expect(repository.jj("log", "--no-graph", "-r", "c-", "-T", "description")).toBe("base\n");
      expect(repository.files("b")).toContain("trunk.txt");
    }),
  );

  // GitHub can delete a merged branch after the fetch, which leaves its bookmark on the trunk.
  itEffect(
    "abandons a merged change and forgets its bookmark, with the branch still on GitHub",
    () =>
      Effect.gen(function* () {
        squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository);
        expect(repository.log()).toEqual(["b [b]"]);
        expect(repository.jj("bookmark", "list", "--all-remotes", "a")).toBe("");
      }),
  );

  // The fetch deletes the bookmark of a branch deleted on GitHub, so there's nothing left to forget.
  itEffect("abandons a merged change whose branch GitHub deleted, without a warning", () =>
    Effect.gen(function* () {
      squashMergeOnGitHub(repository, "a");
      yield* syncing(repository);
      expect(repository.log()).toEqual(["b [b]"]);
      expect(repository.jj("bookmark", "list", "--all-remotes", "a")).toBe("");
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
        repository.jj("edit", "b");
        repository.write("a.txt", "a, edited by b\n");
        repository.jj("new", "b", "-m", "c");
        repository.write("c.txt", "c\n");
        repository.jj("git", "push", "--bookmark", "b");
        moveTrunkOnGitHub(repository);
        squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
        yield* syncing(repository);
        expect(repository.log()).toEqual(["c []"]);
        expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description")).toBe(
          "",
        );
        expect(repository.files("@")).toEqual(["a.txt", "b.txt", "base.txt", "c.txt", "trunk.txt"]);
        expect(repository.jj("bookmark", "list", "--all-remotes", "a", "b")).toBe("");
      }),
  );

  // As above, with the stack rebased locally by a sync between the push and the merge.
  itEffect("abandons merged changes that a sync rebased since their push", () =>
    Effect.gen(function* () {
      repository.jj("edit", "b");
      repository.write("a.txt", "a, edited by b\n");
      repository.jj("new", "b", "-m", "c");
      repository.write("c.txt", "c\n");
      repository.jj("git", "push", "--bookmark", "b");
      moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      moveTrunkOnGitHub(repository, "later.txt");
      squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
      yield* syncing(repository);
      expect(repository.log()).toEqual(["c []"]);
      expect(repository.files("@")).toEqual([
        "a.txt",
        "b.txt",
        "base.txt",
        "c.txt",
        "later.txt",
        "trunk.txt",
      ]);
    }),
  );

  itEffect("keeps a change edited after its pull request merged", () =>
    Effect.gen(function* () {
      squashMergeOnGitHub(repository, "a", { deleted: false });
      editLocally(repository);
      yield* syncing(repository);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("a")).toEqual(["a.txt", "base.txt", "local.txt"]);
    }),
  );

  itEffect("takes the rest of a stack as GitHub rebased it after a merge", () =>
    Effect.gen(function* () {
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      yield* syncing(repository);
      expect(repository.log()).toEqual(["b [b]"]);
      expect(repository.files("b")).toEqual(["a.txt", "b.txt", "base.txt"]);
    }),
  );

  // The fetch drops the old commits of a branch GitHub rewrote, which takes whatever was on them
  // off the stack.
  describe("after GitHub rebased the rest of a stack", () => {
    itEffect("keeps the working copy on top of the stack", () =>
      Effect.gen(function* () {
        squashMergeOnGitHub(repository, "a", { above: ["b"] });
        yield* syncing(repository);
        expect(repository.jj("log", "--no-graph", "-r", "@-", "-T", "bookmarks")).toBe("b");
      }),
    );

    itEffect("keeps editing the change the working copy was", () =>
      Effect.gen(function* () {
        repository.jj("edit", "b");
        squashMergeOnGitHub(repository, "a", { above: ["b"] });
        yield* syncing(repository);
        expect(repository.jj("log", "--no-graph", "-r", "@", "-T", "bookmarks")).toBe("b");
      }),
    );

    itEffect("keeps a change that isn't pushed on top of the stack", () =>
      Effect.gen(function* () {
        repository.write("c.txt", "c\n");
        repository.jj("describe", "-m", "c");
        squashMergeOnGitHub(repository, "a", { above: ["b"] });
        yield* syncing(repository);
        expect(repository.log()).toEqual(["b [b]", "c []"]);
      }),
    );
  });
});
