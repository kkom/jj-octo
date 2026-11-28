import { expect } from "bun:test";

import { Effect, Layer, String as EffectString } from "effect";

import type { ListedPullRequest, RequiredChecks } from "../../clients/github/types";
import { requiring, run } from "../../testing/checks";
import { conflictWithTrunk } from "../../testing/conflicts";
import { fakeGitHub, setUpGitHub } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { pullRequest } from "../../testing/pull-requests";
import { ScratchRepository, scratchRepository } from "../../testing/scratch-repository";
import { checks } from "./checks";

// A stack of three changes: `a` with checks, `b` whose pull request's head is a commit pushed
// earlier, and `c` with no open pull request.
const checkedStack = (required: RequiredChecks = requiring("CI")) =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* repository.stack("a", "b", "c");
    const commitA = yield* repository.commitOf("a");
    const commitC = yield* repository.commitOf("c");
    const pushedEarlier = "0123456789abcdef0123456789abcdef01234567";
    const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
      a: [pullRequest(1, "ready", commitA)],
      b: [pullRequest(2, "draft", pushedEarlier), pullRequest(3, "merged", "x")],
      c: [pullRequest(4, "closed", commitC)],
    };
    yield* setUpGitHub({
      checks: {
        [commitA]: [run("CI", "success", "passed"), run("Cleanup", "skipped", "passed")],
        [pushedEarlier]: [run("CI", "cancelled", "failed")],
      },
      pullRequestsFrom: (branch) => byBranch[branch] ?? [],
      required: { main: required },
    });
  });

layer(Layer.merge(scratchRepository, fakeGitHub))("checks", (it) => {
  it("prints one line per change top first, with the state of its required checks", () =>
    Effect.gen(function* () {
      yield* checkedStack();
      const printed = yield* checks("@", { verbose: false });
      expect(printed).toStrictEqual([
        "c  no open pull request",
        "b  #2 failed: CI         head 0123456789ab differs from the change",
        "a  #1 passed",
      ]);
    }));

  it("follows each line with its pull request's check rows, with --verbose", () =>
    Effect.gen(function* () {
      yield* checkedStack();
      const printed = yield* checks("@", { verbose: true });
      expect(printed).toStrictEqual([
        "c  no open pull request",
        "",
        "b  #2 failed: CI         head 0123456789ab differs from the change",
        "  required  CI  cancelled",
        "",
        "a  #1 passed",
        "  required      CI       success",
        "  not required  Cleanup  skipped",
      ]);
    }));

  it("says once why the required checks are unknown", () =>
    Effect.gen(function* () {
      yield* checkedStack({
        _tag: "Unknown",
        reason: "couldn't read the rules of main",
      });
      const printed = yield* checks("@", { verbose: false });
      expect(printed).toStrictEqual([
        "required checks unknown: couldn't read the rules of main",
        "c  no open pull request",
        "b  #2 unknown            head 0123456789ab differs from the change",
        "a  #1 unknown",
      ]);
    }));

  it("separates the reason the required checks are unknown from the pull requests, with --verbose", () =>
    Effect.gen(function* () {
      yield* checkedStack({
        _tag: "Unknown",
        reason: "couldn't read the rules of main",
      });
      const printed = yield* checks("@", { verbose: true });
      expect(printed).toStrictEqual([
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
    }));

  it("says where the default branch requires no checks", () =>
    Effect.gen(function* () {
      yield* checkedStack(requiring());
      const printed = yield* checks("@", { verbose: false });
      expect(printed).toStrictEqual([
        "c  no open pull request",
        "b  #2 no required checks  head 0123456789ab differs from the change",
        "a  #1 no required checks",
      ]);
    }));

  // As where the stack merges from the bottom, and the unmerged changes above conflict with the
  // trunk.
  it("marks the changes with conflicts, and shows them as any other", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      yield* conflictWithTrunk("b", { pushed: ["a"] });
      const branches = yield* repository.branches;
      const pushedB = branches["b"] ?? "";
      const commitA = yield* repository.commitOf("a");
      const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
        a: [pullRequest(1, "ready", commitA)],
        b: [pullRequest(2, "ready", pushedB)],
      };
      yield* setUpGitHub({
        checks: {
          [commitA]: [run("CI", "success", "passed")],
          [pushedB]: [run("CI", "failure", "failed")],
        },
        pullRequestsFrom: (branch) => byBranch[branch] ?? [],
        required: { main: requiring("CI") },
      });
      const printed = yield* checks("@", { verbose: false });
      expect(printed).toStrictEqual([
        "c  no open pull request  conflicted",
        `b  #2 failed: CI         head ${EffectString.slice(0, 12)(pushedB)} differs from the change  conflicted`,
        "a  #1 passed",
      ]);
    }));
});
