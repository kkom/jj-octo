import { afterAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";

import type { ListedPullRequest, RequiredChecks } from "../../clients/github/types";
import { requiring, run } from "../../testing/checks";
import { conflictWithTrunk } from "../../testing/conflicts";
import { fakeGitHub, inRepository, pullRequest } from "../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { checks } from "./checks";

afterAll(removeScratchRepositories);

// A stack of three changes: `a` with checks, `b` whose pull request's head is a commit pushed
// earlier, and `c` with no open pull request.
const checkedStack = (required: RequiredChecks = requiring("CI")) => {
  const repository = scratchRepository();
  repository.stack("a", "b", "c");
  const commitOf = (bookmark: string) =>
    repository.jj("log", "--no-graph", "-r", bookmark, "-T", "commit_id");
  const pushedEarlier = "0123456789abcdef0123456789abcdef01234567";
  const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
    a: [pullRequest(1, "ready", commitOf("a"))],
    b: [pullRequest(2, "draft", pushedEarlier), pullRequest(3, "merged", "x")],
    c: [pullRequest(4, "closed", commitOf("c"))],
  };
  const github = fakeGitHub({}, [], {
    checks: {
      [commitOf("a")]: [run("CI", "success", "passed"), run("Cleanup", "skipped", "passed")],
      [pushedEarlier]: [run("CI", "cancelled", "failed")],
    },
    pullRequestsFrom: (branch) => byBranch[branch] ?? [],
    required: { main: required },
  });
  return inRepository(repository, github);
};

describe("checks", () => {
  it("prints one line per change top first, with the state of its required checks", async () => {
    expect(
      await Effect.runPromise(checks("@", { verbose: false }).pipe(checkedStack())),
    ).toStrictEqual([
      "c  no open pull request",
      "b  #2 failed: CI         head 0123456789ab differs from the change",
      "a  #1 passed",
    ]);
  });

  it("follows each line with its pull request's check rows, with --verbose", async () => {
    expect(
      await Effect.runPromise(checks("@", { verbose: true }).pipe(checkedStack())),
    ).toStrictEqual([
      "c  no open pull request",
      "",
      "b  #2 failed: CI         head 0123456789ab differs from the change",
      "  required  CI  cancelled",
      "",
      "a  #1 passed",
      "  required      CI       success",
      "  not required  Cleanup  skipped",
    ]);
  });

  it("says once why the required checks are unknown", async () => {
    expect(
      await Effect.runPromise(
        checks("@", { verbose: false }).pipe(
          checkedStack({ _tag: "Unknown", reason: "couldn't read the rules of main" }),
        ),
      ),
    ).toStrictEqual([
      "required checks unknown: couldn't read the rules of main",
      "c  no open pull request",
      "b  #2 unknown            head 0123456789ab differs from the change",
      "a  #1 unknown",
    ]);
  });

  it("separates the reason the required checks are unknown from the pull requests, with --verbose", async () => {
    expect(
      await Effect.runPromise(
        checks("@", { verbose: true }).pipe(
          checkedStack({ _tag: "Unknown", reason: "couldn't read the rules of main" }),
        ),
      ),
    ).toStrictEqual([
      "required checks unknown: couldn't read the rules of main",
      "",
      "c  no open pull request",
      "",
      "b  #2 unknown            head 0123456789ab differs from the change",
      "  maybe required  CI  cancelled",
      "",
      "a  #1 unknown",
      "  maybe required  CI       success",
      "  maybe required  Cleanup  skipped",
    ]);
  });

  it("says where the default branch requires no checks", async () => {
    expect(
      await Effect.runPromise(checks("@", { verbose: false }).pipe(checkedStack(requiring()))),
    ).toStrictEqual([
      "c  no open pull request",
      "b  #2 no required checks  head 0123456789ab differs from the change",
      "a  #1 no required checks",
    ]);
  });

  // As where the stack merges from the bottom, and the unmerged changes above conflict with the
  // trunk.
  it("marks the changes with conflicts, and shows them as any other", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
    conflictWithTrunk(repository, "b", { pushed: ["a"] });
    const commitOf = (bookmark: string) =>
      repository.jj("log", "--no-graph", "-r", bookmark, "-T", "commit_id");
    const pushedB = repository.branches()["b"] ?? "";
    const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
      a: [pullRequest(1, "ready", commitOf("a"))],
      b: [pullRequest(2, "ready", pushedB)],
    };
    const github = fakeGitHub({}, [], {
      checks: {
        [commitOf("a")]: [run("CI", "success", "passed")],
        [pushedB]: [run("CI", "failure", "failed")],
      },
      pullRequestsFrom: (branch) => byBranch[branch] ?? [],
      required: { main: requiring("CI") },
    });
    expect(
      await Effect.runPromise(
        checks("@", { verbose: false }).pipe(inRepository(repository, github)),
      ),
    ).toStrictEqual([
      "c  no open pull request  conflicted",
      `b  #2 failed: CI         head ${pushedB.slice(0, 12)} differs from the change  conflicted`,
      "a  #1 passed",
    ]);
  });
});
