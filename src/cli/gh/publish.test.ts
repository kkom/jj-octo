import { expect } from "bun:test";

import { Effect, Layer, Option } from "effect";

import { GitHub } from "../../clients/github/client";
import { conflictWithTrunk } from "../../testing/conflicts";
import {
  fakeGitHub,
  gitHubCalls,
  setUpGitHub,
  setUpPullRequestsAB,
  setUpPullRequestsABC,
} from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { openPullRequestsAB, openPullRequestsABC, stackOf } from "../../testing/pull-requests";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";
import { NotPublishable, publish } from "./publish";
import { NotAStack } from "./stack/changes";

// Whether each bookmark's open pull request is a draft.
const draftsOf = (bookmarks: readonly string[]) =>
  Effect.forEach(
    bookmarks,
    (bookmark) =>
      GitHub.use((client) => client.openPullRequest(bookmark)).pipe(
        Effect.map((found) => Option.map(found, ({ draft }) => draft)),
      ),
    { concurrency: "unbounded" },
  );

layer(Layer.merge(pushedStack("a", "b", "c"), fakeGitHub))("publish", (it) => {
  it("publishes a change and the ones below it where a change above has conflicts", () =>
    Effect.gen(function* () {
      yield* conflictWithTrunk("c", { pushed: ["a", "b"] });
      yield* setUpPullRequestsABC();
      yield* publish("b");
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["publish #1", "publish #2"]);
    }));

  it("fails before publishing any where the change named has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* conflictWithTrunk("b", { pushed: ["a"] });
      yield* setUpPullRequestsABC();
      const failure = yield* Effect.flip(publish("b"));
      const labels = yield* repository.labels("b");
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NotAStack.make({ message: `resolve the conflicts first:\n${labels}` }),
      });
    }));

  it("marks the drafts of a change and the ones below it ready, bottom to top", () =>
    Effect.gen(function* () {
      yield* setUpGitHub({
        open: { ...openPullRequestsABC, b: { ...openPullRequestsABC.b, draft: false } },
        stacks: stackOf(1, 2, 3),
      });
      yield* publish("c");
      expect({
        calls: yield* gitHubCalls,
        drafts: yield* draftsOf(["a", "b", "c"]),
      }).toStrictEqual({
        calls: ["publish #1", "publish #3"],
        drafts: [Option.some(false), Option.some(false), Option.some(false)],
      });
    }));
});

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))("publish, with two changes", (it) => {
  it("leaves the changes above the one named as drafts", () =>
    Effect.gen(function* () {
      yield* setUpPullRequestsAB();
      yield* publish("a");
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["publish #1"]);
    }));

  it("publishes nothing while a change has edits that aren't pushed", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("describe", "-r", "b", "-m", "b, reworded");
      yield* setUpPullRequestsAB();
      const failure = yield* Effect.flip(publish("b"));
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NotPublishable.make({
          message: "these changes aren't pushed: b; run `jj gh submit --publish` instead",
        }),
      });
    }));

  it("publishes nothing where a change has no open pull request", () =>
    Effect.gen(function* () {
      yield* setUpGitHub({ open: { b: openPullRequestsAB.b } });
      const failure = yield* Effect.flip(publish("b"));
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NotPublishable.make({
          message: "no open pull request for a; run `jj gh submit --publish` instead",
        }),
      });
    }));
});

layer(Layer.merge(pushedStack("a"), fakeGitHub))("publish, with one change", (it) => {
  it("publishes nothing where every pull request is ready", () =>
    Effect.gen(function* () {
      yield* setUpGitHub({ open: { a: { ...openPullRequestsAB.a, draft: false } } });
      yield* publish("a");
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual([]);
    }));
});
