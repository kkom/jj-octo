import { expect } from "bun:test";

import { Effect, Layer } from "effect";

import { GitHubFailed } from "../../../clients/github/failure";
import { fakeGitHub, gitHubCalls, setUpPullRequestsABC } from "../../../testing/fake-github";
import { layer } from "../../../testing/it-effect";
import { stackOf } from "../../../testing/pull-requests";
import { pushedStack, ScratchRepository } from "../../../testing/scratch-repository";
import { submitting } from "../../../testing/submit";
import { CLOSED_COMMENT } from "./abandoned";

layer(Layer.merge(pushedStack("a", "b", "c"), fakeGitHub))(
  "submit after a change left the stack",
  (it) => {
    it("closes the pull request of an abandoned change on top, and comments why", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("abandon", "c");
        yield* setUpPullRequestsABC();
        yield* submitting({ revision: "b" });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual(["close #3", `comment on #3: ${CLOSED_COMMENT}`]);
      }));

    // The branch of a closed pull request stays on GitHub, so a fetch reads it again.
    it("keeps the abandoned change hidden after a later fetch", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("abandon", "c");
        const before = yield* repository.log;
        yield* setUpPullRequestsABC();
        yield* submitting({ revision: "b" });
        yield* repository.jj("git", "fetch");
        const after = yield* repository.log;
        expect(after).toStrictEqual(before);
      }));

    it("closes the pull request of a change abandoned in the middle, before it registers the stack again", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("abandon", "b");
        yield* setUpPullRequestsABC();
        yield* submitting({ revision: "c" });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual([
          "close #2",
          `comment on #2: ${CLOSED_COMMENT}`,
          "unstack #7",
          "base #3 → main",
          "base #3 → a",
          "create stack 1,3",
        ]);
      }));

    it("closes the pull request of a change abandoned at the bottom", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("abandon", "a");
        yield* setUpPullRequestsABC();
        yield* submitting({ revision: "c" });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual([
          "close #1",
          `comment on #1: ${CLOSED_COMMENT}`,
          "unstack #7",
          "base #2 → main",
          "create stack 2,3",
        ]);
      }));

    it("fails with the stack as it was where GitHub rejects the comment", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("abandon", "b");
        yield* setUpPullRequestsABC({ commentForbidden: true });
        const failure = yield* Effect.flip(submitting({ revision: "c" }));
        expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
          calls: ["close #2"],
          failure: GitHubFailed.make({
            message: "POST /issues/2/comments returned 403",
            status: 403,
          }),
        });
      }));

    it("leaves open the pull request of a change moved out of the stack", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("rebase", "-r", "c", "-d", "main");
        yield* setUpPullRequestsABC();
        yield* submitting({ revision: "b" });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual([]);
      }));

    it("leaves open the pull request of a change whose bookmark was deleted by hand", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("bookmark", "delete", "c");
        yield* setUpPullRequestsABC();
        yield* submitting({ revision: "b" });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual([]);
      }));

    it("leaves open the pull request of an abandoned change that the submitted stack never held", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* repository.jj("abandon", "c");
        yield* setUpPullRequestsABC({ stacks: stackOf(1, 2) });
        yield* submitting({ revision: "b" });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual([]);
      }));
  },
);
