import { describe, expect } from "bun:test";

import { Effect, Layer } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  squashMergeOnGitHub,
} from "../../testing/branch-changes";
import { fakeGitHubHolding, setUpPullRequestsAB } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";
import { syncing } from "../../testing/sync";
import { addWorkspace } from "../../testing/workspace";

// The commits of the changes `a` and `b`, and of their branches as last fetched.
const commitsOfAB = ScratchRepository.use((repository) =>
  repository.jj(
    "log",
    "--no-graph",
    "-r",
    "a | b | a@origin | b@origin",
    "-T",
    String.raw`commit_id ++ "\n"`,
  ),
);

// Another workspace's working copy on `b`, and a second stack, `c`.
const addWorkspaceOnStack = Effect.gen(function* () {
  const repository = yield* ScratchRepository;
  yield* addWorkspace("b");
  yield* repository.jj("new", "main", "-m", "c");
  yield* repository.jj("bookmark", "create", "c", "-r", "@");
});

const fakeGitHubAB = fakeGitHubHolding(setUpPullRequestsAB());

layer(Layer.merge(pushedStack("a", "b"), fakeGitHubAB))("sync with other workspaces", (it) => {
  describe("where another workspace's working copy is on a stack", () => {
    it("leaves the stack and its branches as they were, and syncs the rest", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addWorkspaceOnStack;
        const before = yield* commitsOfAB;
        yield* addCommitOnGitHub("b");
        yield* squashMergeOnGitHub("a", { deleted: false });
        yield* syncing();
        const filesOfC = yield* repository.files("c");
        const commits = yield* commitsOfAB;
        expect({ c: filesOfC, commits }).toStrictEqual({
          c: ["a.txt", "base.txt"],
          commits: before,
        });
      }));

    it("doesn't fetch a branch of the stack whose local bookmark was deleted", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addWorkspaceOnStack;
        yield* repository.jj("bookmark", "delete", "b");
        const before = yield* repository.commitOf("b@origin");
        yield* addCommitOnGitHub("b");
        yield* syncing();
        const after = yield* repository.commitOf("b@origin");
        expect(after).toBe(before);
      }));

    it("syncs the stack too with `allWorkspaces`", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addWorkspaceOnStack;
        yield* squashMergeOnGitHub("a", { deleted: false });
        yield* syncing({ allWorkspaces: true });
        const filesOfC = yield* repository.files("c");
        const log = yield* repository.log;
        expect({ c: filesOfC, log }).toStrictEqual({
          c: ["a.txt", "base.txt"],
          log: ["c [c]", "b [b]"],
        });
      }));

    it("syncs the stack where this workspace's working copy is on it too", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addWorkspaceOnStack;
        yield* repository.jj("new", "b");
        yield* squashMergeOnGitHub("a", { deleted: false });
        yield* syncing();
        const filesOfB = yield* repository.files("b");
        const log = yield* repository.log;
        expect({ b: filesOfB, log }).toStrictEqual({
          b: ["a.txt", "b.txt", "base.txt"],
          log: ["c [c]", "b [b]"],
        });
      }));
  });

  it("leaves another workspace's new working copy on the trunk it started from", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* addWorkspace("main");
      yield* moveTrunkOnGitHub();
      yield* syncing();
      const filesOfB = yield* repository.files("b");
      const other = yield* repository.description("other@-");
      expect({ b: filesOfB, other }).toStrictEqual({
        b: ["a.txt", "b.txt", "base.txt", "trunk.txt"],
        other: "base",
      });
    }));
});
