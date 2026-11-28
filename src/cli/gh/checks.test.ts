import { describe, expect } from "bun:test";

import { Effect, String as EffectString } from "effect";

import type { ListedPullRequest, RequiredChecks } from "../../clients/github/types";
import { requiring, run } from "../../testing/checks";
import { conflictWithTrunk } from "../../testing/conflicts";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { pullRequest } from "../../testing/pull-requests";
import { scratchRepository } from "../../testing/scratch-repository";
import { checks } from "./checks";

// A stack of three changes: `a` with checks, `b` whose pull request's head is a commit pushed
// earlier, and `c` with no open pull request.
const checkedStack = (required: RequiredChecks = requiring("CI")) =>
  Effect.gen(function* () {
    const repository = yield* scratchRepository;
    yield* repository.stack("a", "b", "c");
    const commitA = yield* repository.commitOf("a");
    const commitC = yield* repository.commitOf("c");
    const pushedEarlier = "0123456789abcdef0123456789abcdef01234567";
    const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
      a: [pullRequest(1, "ready", commitA)],
      b: [pullRequest(2, "draft", pushedEarlier), pullRequest(3, "merged", "x")],
      c: [pullRequest(4, "closed", commitC)],
    };
    const github = fakeGitHub({}, [], {
      checks: {
        [commitA]: [run("CI", "success", "passed"), run("Cleanup", "skipped", "passed")],
        [pushedEarlier]: [run("CI", "cancelled", "failed")],
      },
      pullRequestsFrom: (branch) => byBranch[branch] ?? [],
      required: { main: required },
    });
    return inRepository(repository, github);
  });

describe("checks", () => {
  itEffect("prints one line per change top first, with the state of its required checks", () =>
    Effect.gen(function* () {
      const inStack = yield* checkedStack();
      const printed = yield* checks("@", { verbose: false }).pipe(inStack);
      expect(printed).toStrictEqual([
        "c  no open pull request",
        "b  #2 failed: CI         head 0123456789ab differs from the change",
        "a  #1 passed",
      ]);
    }),
  );

  itEffect("follows each line with its pull request's check rows, with --verbose", () =>
    Effect.gen(function* () {
      const inStack = yield* checkedStack();
      const printed = yield* checks("@", { verbose: true }).pipe(inStack);
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
    }),
  );

  itEffect("says once why the required checks are unknown", () =>
    Effect.gen(function* () {
      const inStack = yield* checkedStack({
        _tag: "Unknown",
        reason: "couldn't read the rules of main",
      });
      const printed = yield* checks("@", { verbose: false }).pipe(inStack);
      expect(printed).toStrictEqual([
        "required checks unknown: couldn't read the rules of main",
        "c  no open pull request",
        "b  #2 unknown            head 0123456789ab differs from the change",
        "a  #1 unknown",
      ]);
    }),
  );

  itEffect(
    "separates the reason the required checks are unknown from the pull requests, with --verbose",
    () =>
      Effect.gen(function* () {
        const inStack = yield* checkedStack({
          _tag: "Unknown",
          reason: "couldn't read the rules of main",
        });
        const printed = yield* checks("@", { verbose: true }).pipe(inStack);
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
      }),
  );

  itEffect("says where the default branch requires no checks", () =>
    Effect.gen(function* () {
      const inStack = yield* checkedStack(requiring());
      const printed = yield* checks("@", { verbose: false }).pipe(inStack);
      expect(printed).toStrictEqual([
        "c  no open pull request",
        "b  #2 no required checks  head 0123456789ab differs from the change",
        "a  #1 no required checks",
      ]);
    }),
  );

  // As where the stack merges from the bottom, and the unmerged changes above conflict with the
  // trunk.
  itEffect("marks the changes with conflicts, and shows them as any other", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      yield* conflictWithTrunk(repository, "b", { pushed: ["a"] });
      const branches = yield* repository.branches;
      const pushedB = branches["b"] ?? "";
      const commitA = yield* repository.commitOf("a");
      const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
        a: [pullRequest(1, "ready", commitA)],
        b: [pullRequest(2, "ready", pushedB)],
      };
      const github = fakeGitHub({}, [], {
        checks: {
          [commitA]: [run("CI", "success", "passed")],
          [pushedB]: [run("CI", "failure", "failed")],
        },
        pullRequestsFrom: (branch) => byBranch[branch] ?? [],
        required: { main: requiring("CI") },
      });
      const printed = yield* checks("@", { verbose: false }).pipe(inRepository(repository, github));
      expect(printed).toStrictEqual([
        "c  no open pull request  conflicted",
        `b  #2 failed: CI         head ${EffectString.slice(0, 12)(pushedB)} differs from the change  conflicted`,
        "a  #1 passed",
      ]);
    }),
  );
});
