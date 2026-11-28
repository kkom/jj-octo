import { describe, expect } from "bun:test";

import { Effect } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  squashMergeOnGitHub,
} from "../../testing/branch-changes";
import { itEffect } from "../../testing/it-effect";
import { pushedStack, type ScratchRepository } from "../../testing/scratch-repository";
import { syncing } from "../../testing/sync";
import { addWorkspace } from "../../testing/workspace";

// The commits of the changes `a` and `b`, and of their branches as last fetched.
const commitsOfAB = (repository: ScratchRepository): Effect.Effect<string> =>
  repository.jj(
    "log",
    "--no-graph",
    "-r",
    "a | b | a@origin | b@origin",
    "-T",
    String.raw`commit_id ++ "\n"`,
  );

// A stack of `a` and `b` with another workspace's working copy on `b`, and a second stack, `c`.
const withWorkspaceOnStack = Effect.gen(function* () {
  const repository = yield* pushedStack("a", "b");
  yield* addWorkspace(repository, "b");
  yield* repository.jj("new", "main", "-m", "c");
  yield* repository.jj("bookmark", "create", "c", "-r", "@");
  return repository;
});

describe("sync with other workspaces", () => {
  describe("where another workspace's working copy is on a stack", () => {
    itEffect("leaves the stack and its branches as they were, and syncs the rest", () =>
      Effect.gen(function* () {
        const repository = yield* withWorkspaceOnStack;
        const before = yield* commitsOfAB(repository);
        yield* addCommitOnGitHub(repository, "b");
        yield* squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository);
        const filesOfC = yield* repository.files("c");
        const commits = yield* commitsOfAB(repository);
        expect({ c: filesOfC, commits }).toStrictEqual({
          c: ["a.txt", "base.txt"],
          commits: before,
        });
      }),
    );

    itEffect("doesn't fetch a branch of the stack whose local bookmark was deleted", () =>
      Effect.gen(function* () {
        const repository = yield* withWorkspaceOnStack;
        yield* repository.jj("bookmark", "delete", "b");
        const before = yield* repository.commitOf("b@origin");
        yield* addCommitOnGitHub(repository, "b");
        yield* syncing(repository);
        const after = yield* repository.commitOf("b@origin");
        expect(after).toBe(before);
      }),
    );

    itEffect("syncs the stack too with `allWorkspaces`", () =>
      Effect.gen(function* () {
        const repository = yield* withWorkspaceOnStack;
        yield* squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository, { allWorkspaces: true });
        const filesOfC = yield* repository.files("c");
        const log = yield* repository.log;
        expect({ c: filesOfC, log }).toStrictEqual({
          c: ["a.txt", "base.txt"],
          log: ["c [c]", "b [b]"],
        });
      }),
    );

    itEffect("syncs the stack where this workspace's working copy is on it too", () =>
      Effect.gen(function* () {
        const repository = yield* withWorkspaceOnStack;
        yield* repository.jj("new", "b");
        yield* squashMergeOnGitHub(repository, "a", { deleted: false });
        yield* syncing(repository);
        const filesOfB = yield* repository.files("b");
        const log = yield* repository.log;
        expect({ b: filesOfB, log }).toStrictEqual({
          b: ["a.txt", "b.txt", "base.txt"],
          log: ["c [c]", "b [b]"],
        });
      }),
    );
  });

  itEffect("leaves another workspace's new working copy on the trunk it started from", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* addWorkspace(repository, "main");
      yield* moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      const filesOfB = yield* repository.files("b");
      const other = yield* repository.jj("log", "--no-graph", "-r", "other@-", "-T", "description");
      expect({ b: filesOfB, other }).toStrictEqual({
        b: ["a.txt", "b.txt", "base.txt", "trunk.txt"],
        other: "base\n",
      });
    }),
  );
});
