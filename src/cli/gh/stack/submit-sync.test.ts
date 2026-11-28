import { describe, expect } from "bun:test";

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
import { pushedStack, type ScratchRepository } from "../../../testing/scratch-repository";
import { submitIn } from "../../../testing/submit";
import { addWorkspace } from "../../../testing/workspace";

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

const inOrder = <const Effects extends readonly Effect.Effect<unknown>[]>(...effects: Effects) =>
  Effect.all(effects, { concurrency: 1 });
const printedDescription = (repository: ScratchRepository, revision: string) =>
  repository.jj("log", "--no-graph", "-r", revision, "-T", "description");

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
      const repository = yield* pushedStack("a", "b");
      yield* addWorkspace(repository, "b");
      yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
      yield* submitIn(
        repository,
        githubWithMerged(repository, { b: openPullRequest("main", 2, "b") }),
      );
      const printed = yield* printedDescription(repository, "other@-");
      expect(printed).toBe("b\n");
    }),
  );

  itEffect("abandons a stack that merged whole, with the working copy on another stack", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("new", "main", "-m", "elsewhere");
      yield* squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
      yield* submitIn(repository, githubWithMerged(repository, {}), { revision: "b" });
      const log = yield* repository.log;
      expect(log).toEqual(["elsewhere []"]);
    }),
  );

  itEffect("fails before pushing anything where the sync gives a submitted change conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      const branchesBefore = yield* repository.branches;
      const pushed = branchesBefore["b"];
      yield* squashMergeOnGitHub(repository, "a");
      yield* moveTrunkOnGitHub(repository, "b.txt");
      const failure = yield* failureIn(repository, { b: openPullRequest("a", 2, "b") }, "b");
      const [branches, labels] = yield* inOrder(repository.branches, labelsOf(repository, "b"));
      expect({ branch: branches["b"], failure }).toStrictEqual({
        branch: pushed,
        failure: `resolve the conflicts first:\n${labels}`,
      });
    }),
  );

  itEffect("drops a merged change and takes the rest of the stack as GitHub rebased it", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const onGitHub = yield* repository.branches;
      const github = githubWithMerged(repository, { b: openPullRequest("main", 2, "b") });
      yield* submitIn(repository, github);
      const [log, branches] = yield* inOrder(repository.log, repository.branches);
      expect(log).toEqual(["b [b]"]);
      expect(branches).toEqual(onGitHub);
      expect(github.calls).toEqual([]);
    }),
  );

  // A sync between the push and the merge rebased the stack locally.
  itEffect("drops a merged change that was rebased locally since its push", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* moveTrunkOnGitHub(repository);
      yield* repository.jj("git", "fetch");
      yield* repository.jj("rebase", "--source", "a", "--destination", "main@origin");
      yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const github = githubWithMerged(repository, { b: openPullRequest("main", 2, "b") });
      yield* submitIn(repository, github);
      const log = yield* repository.log;
      expect(log).toEqual(["b [b]"]);
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("folds a commit GitHub added into its change before pushing over it", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* addCommitOnGitHub(repository, "a");
      yield* repository.jj("edit", "b");
      yield* repository.write("b.txt", "b, edited\n");
      const github = githubWithMerged(repository, {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
      });
      yield* submitIn(repository, github);
      const [log, files] = yield* inOrder(repository.log, repository.files("a"));
      expect(log).toEqual(["a [a]", "b [b]"]);
      expect(files).toEqual(["a.txt", "base.txt", "suggestion.txt"]);
      yield* repository.git("fetch", "--quiet");
      const shown = yield* repository.git("show", "origin/b:b.txt");
      expect(shown).toBe("b, edited\n");
    }),
  );

  itEffect("leaves the other stacks where they were", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("new", "main", "-m", "c");
      yield* repository.jj("bookmark", "create", "c", "-r", "@");
      yield* moveTrunkOnGitHub(repository);
      yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const github = githubWithMerged(repository, { b: openPullRequest("main", 2, "b") });
      yield* submitIn(repository, github, { revision: "b" });
      const [below, files] = yield* inOrder(
        printedDescription(repository, "c-"),
        repository.files("b"),
      );
      expect(below).toBe("base\n");
      expect(files).toEqual(["a.txt", "b.txt", "base.txt", "trunk.txt"]);
    }),
  );

  // GitHub rewrote `a` onto a trunk that has moved on since, so the sync rebases the stack again.
  itEffect("rebases onto the trunk a stack whose bottom GitHub rewrote", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* rebaseOnGitHub(repository, "a");
      yield* moveTrunkOnGitHub(repository, "later.txt");
      const github = githubWithMerged(repository, {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
      });
      yield* submitIn(repository, github);
      const [log, files] = yield* inOrder(repository.log, repository.files("b"));
      expect(log).toEqual(["a [a]", "b [b]"]);
      expect(files).toEqual(["a.txt", "b.txt", "base.txt", "later.txt", "trunk.txt"]);
    }),
  );

  // A pull request merged into the branch below it, not the trunk, leaves that branch to submit.
  itEffect("submits what is left below a change whose pull request merged into its base", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* squashMergeOnGitHub(repository, "b", { deleted: false, into: "a" });
      const onGitHub = yield* repository.branches;
      const github = githubWithMerged(repository, { a: openPullRequest("main", 1, "a") });
      yield* submitIn(repository, github, { revision: "b" });
      const [log, files, branches, commit] = yield* inOrder(
        repository.log,
        repository.files("a"),
        repository.branches,
        repository.commitOf("a"),
      );
      expect(log).toEqual(["a [a]"]);
      expect(files).toEqual(["a.txt", "b.txt", "base.txt"]);
      expect(branches).toEqual({
        ...onGitHub,
        a: commit,
      });
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect(
    "stops before changing anything where a branch was deleted on GitHub without a merge",
    () =>
      Effect.gen(function* () {
        const repository = yield* pushedStack("a", "b");
        yield* repository.git("push", "--quiet", "origin", "--delete", "a");
        const branches = yield* repository.branches;
        const failure = yield* failureIn(repository, { b: openPullRequest("a", 2, "b") });
        const [log, branchesAfter] = yield* inOrder(repository.log, repository.branches);
        expect(failure).toBe(deletedFailure("a: no pull request from it merged"));
        expect(log).toEqual(["a [a]", "b [b]"]);
        expect(branchesAfter).toEqual(branches);
      }),
  );

  itEffect("stops where a branch merged, and its change was edited since", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
      yield* repository.jj("edit", "a");
      yield* repository.write("a.txt", "a, edited\n");
      const failure = yield* failureIn(repository, { b: openPullRequest("main", 2, "b") });
      expect(failure).toBe(
        deletedFailure("a: its pushed commit merged, and the change was edited since"),
      );
    }),
  );

  itEffect("stops where a branch merged with a commit added on GitHub", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* addCommitOnGitHub(repository, "a");
      yield* squashMergeOnGitHub(repository, "a", { above: ["b"] });
      const failure = yield* failureIn(repository, { b: openPullRequest("main", 2, "b") });
      const log = yield* repository.log;
      expect(failure).toBe(
        deletedFailure(
          "a: a pull request from it merged, but not the commit pushed for this change",
        ),
      );
      expect(log).toEqual(["a [a]", "b [b]"]);
    }),
  );

  itEffect("leaves alone the changes above the one named", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.git("push", "--quiet", "origin", "--delete", "b");
      yield* repository.jj("edit", "a");
      yield* repository.write("a.txt", "a, edited\n");
      const github = githubWithMerged(repository, { a: openPullRequest("main", 1, "a") });
      yield* submitIn(repository, github, { revision: "a" });
      yield* repository.git("fetch", "--quiet");
      const shown = yield* repository.git("show", "origin/a:a.txt");
      expect(shown).toBe("a, edited\n");
    }),
  );

  itEffect("rebases onto the trunk the changes left without a bookmark once the stack merged", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.write("c.txt", "c\n");
      yield* repository.jj("describe", "-m", "c");
      yield* squashMergeOnGitHub(repository, "b", { below: ["a"] });
      const github = githubWithMerged(repository, {});
      yield* submitIn(repository, github, { revision: "b" });
      const log = yield* repository.log;
      expect(log).toEqual(["c []"]);
      const below = yield* printedDescription(repository, 'description(exact:"c\n")-');
      expect(below).toBe("b (#1)\n");
    }),
  );

  itEffect("forgets the bookmarks above the one named that merged too", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b", "c");
      yield* squashMergeOnGitHub(repository, "c", { below: ["a", "b"] });
      const github = githubWithMerged(repository, {});
      yield* submitIn(repository, github, { revision: "b" });
      const [log, listed] = yield* inOrder(
        repository.log,
        repository.jj("bookmark", "list", "--all-remotes", "c"),
      );
      expect(log).toEqual([]);
      expect(listed).toBe("");
    }),
  );

  itEffect("submits nothing where the change named merged", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* squashMergeOnGitHub(repository, "b", { below: ["a"] });
      const github = githubWithMerged(repository, {});
      yield* submitIn(repository, github, { revision: "b" });
      const log = yield* repository.log;
      const below = yield* printedDescription(repository, "@- & trunk()");
      expect(log).toEqual([]);
      expect(github.calls).toEqual([]);
      expect(below).toBe("b (#1)\n");
    }),
  );
});
