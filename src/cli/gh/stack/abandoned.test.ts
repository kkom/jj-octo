import { afterAll, describe, expect } from "bun:test";

import { Effect } from "effect";

import { GitHubFailed } from "../../../clients/github/failure";
import { itEffect } from "../../../testing/it-effect";
import { stackOf } from "../../../testing/pull-requests";
import { pushedStack, removeScratchRepositories } from "../../../testing/scratch-repository";
import { githubWithThree, submitIn } from "../../../testing/submit";
import { CLOSED_COMMENT } from "./abandoned";

afterAll(removeScratchRepositories);

// Which pull requests submit closes once their change has left the stack.
describe("submit after a change left the stack", () => {
  itEffect("closes the pull request of an abandoned change on top, and comments why", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      repository.jj("abandon", "c");
      const github = githubWithThree();
      yield* submitIn(repository, github, { revision: "b" });
      expect(github.calls).toStrictEqual(["close #3", `comment on #3: ${CLOSED_COMMENT}`]);
    }),
  );

  // The branch of a closed pull request stays on GitHub, so a fetch reads it again.
  itEffect("keeps the abandoned change hidden after a later fetch", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      repository.jj("abandon", "c");
      const before = repository.log();
      yield* submitIn(repository, githubWithThree(), { revision: "b" });
      repository.jj("git", "fetch");
      expect(repository.log()).toStrictEqual(before);
    }),
  );

  itEffect(
    "closes the pull request of a change abandoned in the middle, before it registers the stack again",
    () =>
      Effect.gen(function* () {
        const repository = pushedStack("a", "b", "c");
        repository.jj("abandon", "b");
        const github = githubWithThree();
        yield* submitIn(repository, github, { revision: "c" });
        expect(github.calls).toStrictEqual([
          "close #2",
          `comment on #2: ${CLOSED_COMMENT}`,
          "unstack #7",
          "base #3 → main",
          "base #3 → a",
          "create stack 1,3",
        ]);
      }),
  );

  itEffect("closes the pull request of a change abandoned at the bottom", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      repository.jj("abandon", "a");
      const github = githubWithThree();
      yield* submitIn(repository, github, { revision: "c" });
      expect(github.calls).toStrictEqual([
        "close #1",
        `comment on #1: ${CLOSED_COMMENT}`,
        "unstack #7",
        "base #2 → main",
        "create stack 2,3",
      ]);
    }),
  );

  itEffect("fails with the stack as it was where GitHub rejects the comment", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      repository.jj("abandon", "b");
      const github = githubWithThree(stackOf(1, 2, 3), { commentForbidden: true });
      const failure = yield* Effect.flip(submitIn(repository, github, { revision: "c" }));
      expect({ calls: github.calls, failure }).toStrictEqual({
        calls: ["close #2"],
        failure: GitHubFailed.make({
          message: "POST /issues/2/comments returned 403",
          status: 403,
        }),
      });
    }),
  );

  itEffect("leaves open the pull request of a change moved out of the stack", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      repository.jj("rebase", "-r", "c", "-d", "main");
      const github = githubWithThree();
      yield* submitIn(repository, github, { revision: "b" });
      expect(github.calls).toStrictEqual([]);
    }),
  );

  itEffect("leaves open the pull request of a change whose bookmark was deleted by hand", () =>
    Effect.gen(function* () {
      const repository = pushedStack("a", "b", "c");
      repository.jj("bookmark", "delete", "c");
      const github = githubWithThree();
      yield* submitIn(repository, github, { revision: "b" });
      expect(github.calls).toStrictEqual([]);
    }),
  );

  itEffect(
    "leaves open the pull request of an abandoned change that the submitted stack never held",
    () =>
      Effect.gen(function* () {
        const repository = pushedStack("a", "b", "c");
        repository.jj("abandon", "c");
        const github = githubWithThree(stackOf(1, 2));
        yield* submitIn(repository, github, { revision: "b" });
        expect(github.calls).toStrictEqual([]);
      }),
  );
});
