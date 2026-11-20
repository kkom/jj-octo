import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  squashMergeOnGitHub,
} from "../../testing/branch-changes";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { syncIn } from "../../testing/sync";
import { addWorkspace } from "../../testing/workspace";

afterAll(removeScratchRepositories);

// The commits of the changes `a` and `b`, and of their branches as last fetched.
const commitsOfAB = (repository: ScratchRepository): string =>
  repository.jj(
    "log",
    "--no-graph",
    "-r",
    "a | b | a@origin | b@origin",
    "-T",
    String.raw`commit_id ++ "\n"`,
  );

describe("sync with other workspaces", () => {
  let repository = pushedStack("a", "b");

  beforeEach(() => {
    repository = pushedStack("a", "b");
  });

  describe("where another workspace's working copy is on a stack", () => {
    beforeEach(() => {
      addWorkspace(repository, "b");
      repository.jj("new", "main", "-m", "c");
      repository.jj("bookmark", "create", "c", "-r", "@");
    });

    it("leaves the stack and its branches as they were, and syncs the rest", async () => {
      const before = commitsOfAB(repository);
      addCommitOnGitHub(repository, "b");
      squashMergeOnGitHub(repository, "a", { deleted: false });
      await syncIn(repository);
      expect({ c: repository.files("c"), commits: commitsOfAB(repository) }).toStrictEqual({
        c: ["a.txt", "base.txt"],
        commits: before,
      });
    });

    it("doesn't fetch a branch of the stack whose local bookmark was deleted", async () => {
      repository.jj("bookmark", "delete", "b");
      const before = repository.jj("log", "--no-graph", "-r", "b@origin", "-T", "commit_id");
      addCommitOnGitHub(repository, "b");
      await syncIn(repository);
      expect(repository.jj("log", "--no-graph", "-r", "b@origin", "-T", "commit_id")).toBe(before);
    });

    it("syncs the stack too with `allWorkspaces`", async () => {
      squashMergeOnGitHub(repository, "a", { deleted: false });
      await syncIn(repository, { allWorkspaces: true });
      expect({ c: repository.files("c"), log: repository.log() }).toStrictEqual({
        c: ["a.txt", "base.txt"],
        log: ["c [c]", "b [b]"],
      });
    });

    it("syncs the stack where this workspace's working copy is on it too", async () => {
      repository.jj("new", "b");
      squashMergeOnGitHub(repository, "a", { deleted: false });
      await syncIn(repository);
      expect({ b: repository.files("b"), log: repository.log() }).toStrictEqual({
        b: ["a.txt", "b.txt", "base.txt"],
        log: ["c [c]", "b [b]"],
      });
    });
  });

  it("leaves another workspace's new working copy on the trunk it started from", async () => {
    addWorkspace(repository, "main");
    moveTrunkOnGitHub(repository);
    await syncIn(repository);
    expect({
      b: repository.files("b"),
      other: repository.jj("log", "--no-graph", "-r", "other@-", "-T", "description"),
    }).toStrictEqual({ b: ["a.txt", "b.txt", "base.txt", "trunk.txt"], other: "base\n" });
  });
});
