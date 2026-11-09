import { afterAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { fakeGitHub, openPullRequest, stackNumbered, stackOf } from "../../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../../testing/scratch-repository";
import { submitIn } from "../../../testing/submit";
import { SeveralStacks } from "./stacks";

afterAll(removeScratchRepositories);

// How submit changes the GitHub stacks its pull requests are in.
describe("submit's stacks", () => {
  // As after a pull request on top of the stack is closed, its change dropped, and another pushed
  // in its place: GitHub adds only above the closed one, whose head no new pull request is on.
  it("registers the stack again where its top pull request was closed without merging", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    const github = fakeGitHub({ a: openPullRequest("main", 1, "a") }, stackOf(1, 2));
    await Effect.runPromise(submitIn(repository, github));
    expect(github.calls).toEqual(["unstack #7", "open b on a as a draft", "create stack 1,99"]);
  });

  // GitHub rejects a base change on a pull request in a stack, and closes a pull request whose
  // head becomes reachable from its base. So the stack goes first, the moved pull request is parked
  // on the trunk before the push, and it gets its new base and a new stack after.
  it("reorders by dissolving, parking on the trunk, pushing, then rebasing and registering", async () => {
    const repository = scratchRepository();
    repository.stack("a", "c", "b");
    const github = fakeGitHub(
      {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
        c: openPullRequest("b", 3, "c"),
      },
      stackOf(1, 2, 3),
    );
    await Effect.runPromise(submitIn(repository, github));
    expect(github.calls).toEqual([
      "unstack #7",
      "base #3 → main",
      "base #2 → main",
      "base #3 → a",
      "base #2 → c",
      "create stack 1,3,2",
    ]);
  });

  // Submit changes only the one stack its pull requests are in. Taking a pull request out of
  // another stack would dissolve that stack, so it's left to an explicit `jj gh dissolve`.
  it("fails without changing GitHub where the pull requests belong to several stacks", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    const github = fakeGitHub(
      {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
        c: openPullRequest("b", 3, "c"),
      },
      [stackNumbered(9, 1, 2), stackNumbered(7, 3)],
    );
    const failure = await Effect.runPromise(Effect.flip(submitIn(repository, github)));
    expect(failure).toStrictEqual(
      new SeveralStacks({
        message:
          "the pull requests are in GitHub stacks #9 (#1, #2), #7 (#3), and submit won't take a pull request out of another stack; to keep #9, which holds the bottom one, run `jj gh dissolve 7`, then submit again",
      }),
    );
    expect(github.calls).toStrictEqual([]);
  });

  it("appends to the stack that's left once the other is dissolved", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    const github = fakeGitHub(
      {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
        c: openPullRequest("b", 3, "c"),
      },
      [stackNumbered(9, 1, 2)],
    );
    await Effect.runPromise(submitIn(repository, github));
    expect(github.calls).toStrictEqual(["add 3 to #9"]);
  });
});
