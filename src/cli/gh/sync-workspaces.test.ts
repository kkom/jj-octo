import { afterAll, beforeEach, describe, expect } from "bun:test";

import { Effect } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  squashMergeOnGitHub,
} from "../../testing/branch-changes";
import { itEffect } from "../../testing/it-effect";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { syncing } from "../../testing/sync";
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
  let repository: ScratchRepository;

  beforeEach(() => {
    repository = pushedStack("a", "b");
  });

  describe("where another workspace's working copy is on a stack", () => {
    beforeEach(() => {
      addWorkspace(repository, "b");
      repository.jj("new", "main", "-m", "c");
      repository.jj("bookmark", "create", "c", "-r", "@");
    });

    itEffect("leaves the stack and its branches as they were, and syncs the rest", () =>
      Effect.gen(function* () {
        const before = commitsOfAB(repository);
        addCommitOnGitHub(repository, "b");
        squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository);
        expect({ c: repository.files("c"), commits: commitsOfAB(repository) }).toStrictEqual({
          c: ["a.txt", "base.txt"],
          commits: before,
        });
      }),
    );

    itEffect("doesn't fetch a branch of the stack whose local bookmark was deleted", () =>
      Effect.gen(function* () {
        repository.jj("bookmark", "delete", "b");
        const before = repository.commitOf("b@origin");
        addCommitOnGitHub(repository, "b");
        yield* syncing(repository);
        expect(repository.commitOf("b@origin")).toBe(before);
      }),
    );

    itEffect("syncs the stack too with `allWorkspaces`", () =>
      Effect.gen(function* () {
        squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository, { allWorkspaces: true });
        expect({ c: repository.files("c"), log: repository.log() }).toStrictEqual({
          c: ["a.txt", "base.txt"],
          log: ["c [c]", "b [b]"],
        });
      }),
    );

    itEffect("syncs the stack where this workspace's working copy is on it too", () =>
      Effect.gen(function* () {
        repository.jj("new", "b");
        squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository);
        expect({ b: repository.files("b"), log: repository.log() }).toStrictEqual({
          b: ["a.txt", "b.txt", "base.txt"],
          log: ["c [c]", "b [b]"],
        });
      }),
    );
  });

  itEffect("leaves another workspace's new working copy on the trunk it started from", () =>
    Effect.gen(function* () {
      addWorkspace(repository, "main");
      moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      expect({
        b: repository.files("b"),
        other: repository.jj("log", "--no-graph", "-r", "other@-", "-T", "description"),
      }).toStrictEqual({ b: ["a.txt", "b.txt", "base.txt", "trunk.txt"], other: "base\n" });
    }),
  );
});
