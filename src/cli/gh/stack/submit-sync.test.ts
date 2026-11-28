import { afterAll, describe, expect } from "bun:test";

import { Array as EffectArray, Effect } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  rebaseOnGitHub,
  squashMergeOnGitHub,
} from "../../../testing/branch-changes";
import { labelsOf } from "../../../testing/conflicts";
import { fakeGitHub } from "../../../testing/fake-github";
import { itEffect } from "../../../testing/it-effect";
import { openPullRequest } from "../../../testing/pull-requests";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../../testing/scratch-repository";
import { submitIn } from "../../../testing/submit";
import { addWorkspace } from "../../../testing/workspace";

afterAll(removeScratchRepositories);

// GitHub has the given open pull requests, and reports the ones `squashMergeOnGitHub` merged.
const githubWithMerged = (repository: ScratchRepository, open: Parameters<typeof fakeGitHub>[0]) =>
  fakeGitHub(open, [], { pullRequestsFrom: repository.pullRequestsFrom });

// What the submit failed with, as it would print it.
const failureIn = (
  repository: ScratchRepository,
  open: Parameters<typeof fakeGitHub>[0],
  revision = "@",
) =>
  Effect.flip(submitIn(repository, githubWithMerged(repository, open), { revision })).pipe(
    Effect.map(({ message }) => message),
  );

const deletedFailure = (...branches: readonly string[]): string =>
  EffectArray.join(
    [
      "these branches were deleted on GitHub, so nothing was changed:",
      ...branches,
      "to push a change again, run `jj bookmark forget --include-remotes <name>`, then `jj bookmark create <name> -r <change>`; to drop one, run `jj abandon <change>`",
    ],
    "\n",
  );

describe("submit, where the stack changed on GitHub", () => {
  itEffect("keeps another workspace's empty working copy on the stack GitHub rebased", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      addWorkspace(repository, "b");
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      yield* submitIn(
        repository,
        githubWithMerged(repository, { b: openPullRequest("main", 2, "b") }),
      );
      expect(repository.jj("log", "--no-graph", "-r", "other@-", "-T", "description")).toBe("b\n");
    }),
  );

  itEffect("abandons a stack that merged whole, with the working copy on another stack", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      repository.jj("new", "main", "-m", "elsewhere");
      squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
      yield* submitIn(repository, githubWithMerged(repository, {}), { revision: "b" });
      expect(repository.log()).toEqual(["elsewhere []"]);
    }),
  );

  itEffect("fails before pushing anything where the sync gives a submitted change conflicts", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      const pushed = repository.branches()["b"];
      squashMergeOnGitHub(repository, "a");
      moveTrunkOnGitHub(repository, "b.txt");
      const failure = yield* failureIn(repository, { b: openPullRequest("a", 2, "b") }, "b");
      expect({ branch: repository.branches()["b"], failure }).toStrictEqual({
        branch: pushed,
        failure: `resolve the conflicts first:\n${labelsOf(repository, "b")}`,
      });
    }),
  );

  itEffect("drops a merged change and takes the rest of the stack as GitHub rebased it", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const onGitHub = repository.branches();
      const github = githubWithMerged(repository, { b: openPullRequest("main", 2, "b") });
      yield* submitIn(repository, github);
      expect(repository.log()).toEqual(["b [b]"]);
      expect(repository.branches()).toEqual(onGitHub);
      expect(github.calls).toEqual([]);
    }),
  );

  // A sync between the push and the merge rebased the stack locally.
  itEffect("drops a merged change that was rebased locally since its push", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      moveTrunkOnGitHub(repository);
      repository.jj("git", "fetch");
      repository.jj("rebase", "--source", "a", "--destination", "main@origin");
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const github = githubWithMerged(repository, { b: openPullRequest("main", 2, "b") });
      yield* submitIn(repository, github);
      expect(repository.log()).toEqual(["b [b]"]);
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("folds a commit GitHub added into its change before pushing over it", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      addCommitOnGitHub(repository, "a");
      repository.jj("edit", "b");
      repository.write("b.txt", "b, edited\n");
      const github = githubWithMerged(repository, {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
      });
      yield* submitIn(repository, github);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("a")).toEqual(["a.txt", "base.txt", "suggestion.txt"]);
      repository.git("fetch", "--quiet");
      expect(repository.git("show", "origin/b:b.txt")).toBe("b, edited\n");
    }),
  );

  itEffect("leaves the other stacks where they were", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      repository.jj("new", "main", "-m", "c");
      repository.jj("bookmark", "create", "c", "-r", "@");
      moveTrunkOnGitHub(repository);
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const github = githubWithMerged(repository, { b: openPullRequest("main", 2, "b") });
      yield* submitIn(repository, github, { revision: "b" });
      expect(repository.jj("log", "--no-graph", "-r", "c-", "-T", "description")).toBe("base\n");
      expect(repository.files("b")).toEqual(["a.txt", "b.txt", "base.txt", "trunk.txt"]);
    }),
  );

  // GitHub rewrote `a` onto a trunk that has moved on since, so the sync rebases the stack again.
  itEffect("rebases onto the trunk a stack whose bottom GitHub rewrote", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      rebaseOnGitHub(repository, "a");
      moveTrunkOnGitHub(repository, "later.txt");
      const github = githubWithMerged(repository, {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
      });
      yield* submitIn(repository, github);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("b")).toEqual([
        "a.txt",
        "b.txt",
        "base.txt",
        "later.txt",
        "trunk.txt",
      ]);
    }),
  );

  // A pull request merged into the branch below it, not the trunk, leaves that branch to submit.
  itEffect("submits what is left below a change whose pull request merged into its base", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      squashMergeOnGitHub(repository, "b", { deleted: false, into: "a" });
      const onGitHub = repository.branches();
      const github = githubWithMerged(repository, { a: openPullRequest("main", 1, "a") });
      yield* submitIn(repository, github, { revision: "b" });
      expect(repository.log()).toEqual(["a [a]"]);
      expect(repository.files("a")).toEqual(["a.txt", "b.txt", "base.txt"]);
      expect(repository.branches()).toEqual({
        ...onGitHub,
        a: repository.commitOf("a"),
      });
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect(
    "stops before changing anything where a branch was deleted on GitHub without a merge",
    () =>
      Effect.gen(function* () {
        const repository = pushedStack("a", "b");
        repository.git("push", "--quiet", "origin", "--delete", "a");
        const branches = repository.branches();
        const failure = yield* failureIn(repository, { b: openPullRequest("a", 2, "b") });
        expect(failure).toBe(deletedFailure("a: no pull request from it merged"));
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        expect(repository.branches()).toEqual(branches);
      }),
  );

  itEffect("stops where a branch merged, and its change was edited since", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      repository.jj("edit", "a");
      repository.write("a.txt", "a, edited\n");
      const failure = yield* failureIn(repository, { b: openPullRequest("main", 2, "b") });
      expect(failure).toBe(
        deletedFailure("a: its pushed commit merged, and the change was edited since"),
      );
    }),
  );

  itEffect("stops where a branch merged with a commit added on GitHub", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      addCommitOnGitHub(repository, "a");
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const failure = yield* failureIn(repository, { b: openPullRequest("main", 2, "b") });
      expect(failure).toBe(
        deletedFailure(
          "a: a pull request from it merged, but not the commit pushed for this change",
        ),
      );
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
    }),
  );

  itEffect("leaves alone the changes above the one named", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      repository.git("push", "--quiet", "origin", "--delete", "b");
      repository.jj("edit", "a");
      repository.write("a.txt", "a, edited\n");
      const github = githubWithMerged(repository, { a: openPullRequest("main", 1, "a") });
      yield* submitIn(repository, github, { revision: "a" });
      repository.git("fetch", "--quiet");
      expect(repository.git("show", "origin/a:a.txt")).toBe("a, edited\n");
    }),
  );

  itEffect("rebases onto the trunk the changes left without a bookmark once the stack merged", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      repository.write("c.txt", "c\n");
      repository.jj("describe", "-m", "c");
      squashMergeOnGitHub(repository, "b", { below: ["a"] });
      const github = githubWithMerged(repository, {});
      yield* submitIn(repository, github, { revision: "b" });
      expect(repository.log()).toEqual(["c []"]);
      const below = repository.jj(
        "log",
        "--no-graph",
        "-r",
        'description(exact:"c\n")-',
        "-T",
        "description",
      );
      expect(below).toBe("b (#1)\n");
    }),
  );

  itEffect("forgets the bookmarks above the one named that merged too", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      squashMergeOnGitHub(repository, "c", { below: ["a", "b"] });
      const github = githubWithMerged(repository, {});
      yield* submitIn(repository, github, { revision: "b" });
      expect(repository.log()).toEqual([]);
      expect(repository.jj("bookmark", "list", "--all-remotes", "c")).toBe("");
    }),
  );

  itEffect("submits nothing where the change named merged", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b");
      squashMergeOnGitHub(repository, "b", { below: ["a"] });
      const github = githubWithMerged(repository, {});
      yield* submitIn(repository, github, { revision: "b" });
      expect(repository.log()).toEqual([]);
      expect(github.calls).toEqual([]);
      expect(repository.jj("log", "--no-graph", "-r", "@- & trunk()", "-T", "description")).toBe(
        "b (#1)\n",
      );
    }),
  );
});
