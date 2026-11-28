import { describe, expect } from "bun:test";

import { Effect, Option } from "effect";

import { GitHub } from "../../clients/github/client";
import { conflictWithTrunk, labelsOf } from "../../testing/conflicts";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { openPullRequest, stackOf } from "../../testing/pull-requests";
import { pushedStack, type ScratchRepository } from "../../testing/scratch-repository";
import { githubWithThree } from "../../testing/submit";
import { publish } from "./publish";

const publishIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  revision: string,
) => publish(revision).pipe(inRepository(repository, github));

// Whether each bookmark's open pull request is a draft, as the fake GitHub reports it afterwards.
const draftsIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  bookmarks: readonly string[],
) =>
  Effect.forEach(
    bookmarks,
    (bookmark) =>
      GitHub.use((client) => client.openPullRequest(bookmark)).pipe(
        Effect.map((found) => Option.map(found, ({ draft }) => draft)),
      ),
    { concurrency: "unbounded" },
  ).pipe(inRepository(repository, github));

describe("publish", () => {
  itEffect("publishes a change and the ones below it where a change above has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b", "c");
      yield* conflictWithTrunk(repository, "c", { pushed: ["a", "b"] });
      const github = githubWithThree();
      yield* publishIn(repository, github, "b");
      expect(github.calls).toStrictEqual(["publish #1", "publish #2"]);
    }),
  );

  itEffect("fails before publishing any where the change named has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b", "c");
      yield* conflictWithTrunk(repository, "b", { pushed: ["a"] });
      const github = githubWithThree();
      const failure = yield* Effect.flip(publishIn(repository, github, "b"));
      const labels = yield* labelsOf(repository, "b");
      expect({ calls: github.calls, message: failure.message }).toStrictEqual({
        calls: [],
        message: `resolve the conflicts first:\n${labels}`,
      });
    }),
  );

  itEffect("marks the drafts of a change and the ones below it ready, bottom to top", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b", "c");
      const github = fakeGitHub(
        {
          a: openPullRequest("main", 1, "a"),
          b: { ...openPullRequest("a", 2, "b"), draft: false },
          c: openPullRequest("b", 3, "c"),
        },
        stackOf(1, 2, 3),
      );
      yield* publishIn(repository, github, "c");
      expect({
        calls: github.calls,
        drafts: yield* draftsIn(repository, github, ["a", "b", "c"]),
      }).toStrictEqual({
        calls: ["publish #1", "publish #3"],
        drafts: [Option.some(false), Option.some(false), Option.some(false)],
      });
    }),
  );

  itEffect("leaves the changes above the one named as drafts", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      const github = fakeGitHub(
        { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
        stackOf(1, 2),
      );
      yield* publishIn(repository, github, "a");
      expect(github.calls).toStrictEqual(["publish #1"]);
    }),
  );

  itEffect("publishes nothing where every pull request is ready", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a");
      const github = fakeGitHub({ a: { ...openPullRequest("main", 1, "a"), draft: false } }, []);
      yield* publishIn(repository, github, "a");
      expect(github.calls).toStrictEqual([]);
    }),
  );

  itEffect("publishes nothing while a change has edits that aren't pushed", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      yield* repository.jj("describe", "-r", "b", "-m", "b, reworded");
      const github = fakeGitHub(
        { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
        stackOf(1, 2),
      );
      const failure = yield* Effect.flip(publishIn(repository, github, "b"));
      expect({ calls: github.calls, message: failure.message }).toStrictEqual({
        calls: [],
        message: "these changes aren't pushed: b; run `jj gh submit --publish` instead",
      });
    }),
  );

  itEffect("publishes nothing where a change has no open pull request", () =>
    Effect.gen(function* () {
      const repository = yield* pushedStack("a", "b");
      const github = fakeGitHub({ b: openPullRequest("a", 2, "b") }, []);
      const failure = yield* Effect.flip(publishIn(repository, github, "b"));
      expect({ calls: github.calls, message: failure.message }).toStrictEqual({
        calls: [],
        message: "no open pull request for a; run `jj gh submit --publish` instead",
      });
    }),
  );
});
