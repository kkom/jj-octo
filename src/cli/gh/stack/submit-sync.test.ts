import { expect } from "bun:test";

import { Array as EffectArray, Effect, Layer } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  rebaseOnGitHub,
  squashMergeOnGitHub,
} from "../../../testing/branch-changes";
import {
  fakeGitHubHolding,
  gitHubCalls,
  setUpGitHub,
  setUpPullRequestsAB,
  setUpPullRequestsABC,
} from "../../../testing/fake-github";
import { layer } from "../../../testing/it-effect";
import { openPullRequestsAB } from "../../../testing/pull-requests";
import { pushedStack, ScratchRepository } from "../../../testing/scratch-repository";
import { submitting } from "../../../testing/submit";
import { addWorkspace } from "../../../testing/workspace";
import { NotAStack } from "./changes";
import { BranchesDeleted } from "./sync-stack";

// What the submit of the revision failed with.
const failureOf = (revision = "@") => Effect.flip(submitting({ revision }));

const deletedFailure = (...branches: readonly string[]): BranchesDeleted =>
  BranchesDeleted.make({
    message: EffectArray.join(
      [
        "these branches were deleted on GitHub, so nothing was changed:",
        ...branches,
        "to push a change again, run `jj bookmark forget --include-remotes <name>`, then `jj bookmark create <name> -r <change>`; to drop one, run `jj abandon <change>`",
      ],
      "\n",
    ),
  });

layer(Layer.merge(pushedStack("a", "b"), fakeGitHubHolding(setUpPullRequestsAB())))(
  "submit, where the stack changed on GitHub",
  (it) => {
    it("keeps another workspace's empty working copy on the stack GitHub rebased", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addWorkspace("b");
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        yield* submitting();
        const described = yield* repository.description("other@-");
        expect(described).toBe("b");
      }));

    it("abandons a stack that merged whole, with the working copy on another stack", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("new", "main", "-m", "elsewhere");
        yield* squashMergeOnGitHub("b", { below: ["a"], deleted: false });
        yield* submitting({ revision: "b" });
        const log = yield* repository.log;
        expect(log).toStrictEqual(["elsewhere []"]);
      }));

    it("fails before pushing anything where the sync gives a submitted change conflicts", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        const branchesBefore = yield* repository.branches;
        const pushed = branchesBefore["b"];
        yield* squashMergeOnGitHub("a");
        yield* moveTrunkOnGitHub("b.txt");
        const failure = yield* failureOf("b");
        const branches = yield* repository.branches;
        expect({ branch: branches["b"], failure }).toStrictEqual({
          branch: pushed,
          failure: NotAStack.make({
            message: `resolve the conflicts first:\n${yield* repository.labels("b")}`,
          }),
        });
      }));

    it("drops a merged change and takes the rest of the stack as GitHub rebased it", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        const onGitHub = yield* repository.branches;
        yield* submitting();
        expect({
          branches: yield* repository.branches,
          calls: yield* gitHubCalls,
          log: yield* repository.log,
        }).toStrictEqual({
          branches: onGitHub,
          calls: [],
          log: ["b [b]"],
        });
      }));

    // A sync between the push and the merge rebased the stack locally.
    it("drops a merged change that was rebased locally since its push", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* moveTrunkOnGitHub();
        yield* repository.jj("git", "fetch");
        yield* repository.jj("rebase", "--source", "a", "--destination", "main@origin");
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        yield* submitting();
        expect({ calls: yield* gitHubCalls, log: yield* repository.log }).toStrictEqual({
          calls: [],
          log: ["b [b]"],
        });
      }));

    it("folds a commit GitHub added into its change before pushing over it", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addCommitOnGitHub("a");
        yield* repository.jj("edit", "b");
        yield* repository.write("b.txt", "b, edited\n");
        yield* setUpPullRequestsAB({ stacks: [] });
        yield* submitting();
        expect({
          files: yield* repository.files("a"),
          log: yield* repository.log,
          pushedB: yield* repository.git("show", "b:b.txt"),
        }).toStrictEqual({
          files: ["a.txt", "base.txt", "suggestion.txt"],
          log: ["a [a]", "b [b]"],
          pushedB: "b, edited\n",
        });
      }));

    it("leaves the other stacks where they were", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("new", "main", "-m", "c");
        yield* repository.jj("bookmark", "create", "c", "-r", "@");
        yield* moveTrunkOnGitHub();
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        yield* submitting({ revision: "b" });
        expect({
          below: yield* repository.description("c-"),
          files: yield* repository.files("b"),
        }).toStrictEqual({ below: "base", files: ["a.txt", "b.txt", "base.txt", "trunk.txt"] });
      }));

    // GitHub rewrote `a` onto a trunk that has moved on since, so the sync rebases the stack again.
    it("rebases onto the trunk a stack whose bottom GitHub rewrote", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* rebaseOnGitHub("a");
        yield* moveTrunkOnGitHub("later.txt");
        yield* setUpPullRequestsAB({ stacks: [] });
        yield* submitting();
        expect({ files: yield* repository.files("b"), log: yield* repository.log }).toStrictEqual({
          files: ["a.txt", "b.txt", "base.txt", "later.txt", "trunk.txt"],
          log: ["a [a]", "b [b]"],
        });
      }));

    // A pull request merged into the branch below it, not the trunk, leaves that branch to submit.
    it("submits what is left below a change whose pull request merged into its base", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* squashMergeOnGitHub("b", { deleted: false, into: "a" });
        const onGitHub = yield* repository.branches;
        yield* submitting({ revision: "b" });
        expect({
          branches: yield* repository.branches,
          calls: yield* gitHubCalls,
          files: yield* repository.files("a"),
          log: yield* repository.log,
        }).toStrictEqual({
          branches: { ...onGitHub, a: yield* repository.commitOf("a") },
          calls: [],
          files: ["a.txt", "b.txt", "base.txt"],
          log: ["a [a]"],
        });
      }));

    it("stops before changing anything where a branch was deleted on GitHub without a merge", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.git("branch", "--quiet", "--delete", "--force", "a");
        const branches = yield* repository.branches;
        yield* setUpGitHub({ open: { b: openPullRequestsAB.b } });
        const failure = yield* failureOf();
        expect({
          branches: yield* repository.branches,
          failure,
          log: yield* repository.log,
        }).toStrictEqual({
          branches,
          failure: deletedFailure("a: no pull request from it merged"),
          log: ["a [a]", "b [b]"],
        });
      }));

    it("stops where a branch merged, and its change was edited since", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        yield* repository.jj("edit", "a");
        yield* repository.write("a.txt", "a, edited\n");
        const failure = yield* failureOf();
        expect(failure).toStrictEqual(
          deletedFailure("a: its pushed commit merged, and the change was edited since"),
        );
      }));

    it("stops where a branch merged with a commit added on GitHub", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addCommitOnGitHub("a");
        yield* squashMergeOnGitHub("a", { above: ["b"] });
        const failure = yield* failureOf();
        expect({ failure, log: yield* repository.log }).toStrictEqual({
          failure: deletedFailure(
            "a: a pull request from it merged, but not the commit pushed for this change",
          ),
          log: ["a [a]", "b [b]"],
        });
      }));

    it("leaves alone the changes above the one named", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.git("branch", "--quiet", "--delete", "--force", "b");
        yield* repository.jj("edit", "a");
        yield* repository.write("a.txt", "a, edited\n");
        yield* setUpGitHub({ open: { a: openPullRequestsAB.a } });
        yield* submitting({ revision: "a" });
        const shown = yield* repository.git("show", "a:a.txt");
        expect(shown).toBe("a, edited\n");
      }));

    it("rebases onto the trunk the changes left without a bookmark once the stack merged", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.write("c.txt", "c\n");
        yield* repository.jj("describe", "-m", "c");
        yield* squashMergeOnGitHub("b", { below: ["a"] });
        yield* submitting({ revision: "b" });
        const log = yield* repository.log;
        expect(log).toStrictEqual(["c []"]);
        const below = yield* repository.description('description(exact:"c\n")-');
        expect(below).toBe("b (#2)");
      }));

    it("submits nothing where the change named merged", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* squashMergeOnGitHub("b", { below: ["a"] });
        yield* submitting({ revision: "b" });
        expect({
          below: yield* repository.description("@- & trunk()"),
          calls: yield* gitHubCalls,
          log: yield* repository.log,
        }).toStrictEqual({ below: "b (#2)", calls: [], log: [] });
      }));
  },
);

layer(Layer.merge(pushedStack("a", "b", "c"), fakeGitHubHolding(setUpPullRequestsABC())))(
  "submit, where the stack changed on GitHub, with three changes",
  (it) => {
    it("forgets the bookmarks above the one named that merged too", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* squashMergeOnGitHub("c", { below: ["a", "b"] });
        yield* submitting({ revision: "b" });
        expect({
          listed: yield* repository.jj("bookmark", "list", "--all-remotes", "c"),
          log: yield* repository.log,
        }).toStrictEqual({ listed: "", log: [] });
      }));
  },
);
