import { describe, expect } from "bun:test";

import { Effect, Record as EffectRecord } from "effect";

import { conflictWithTrunk, labelsOf } from "../../../testing/conflicts";
import { fakeGitHub } from "../../../testing/fake-github";
import { itEffect } from "../../../testing/it-effect";
import { openPullRequest, stackOf } from "../../../testing/pull-requests";
import { scratchRepository } from "../../../testing/scratch-repository";
import { submitIn } from "../../../testing/submit";

describe("submit", () => {
  itEffect("submits a change and the ones below it where a change above has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* conflictWithTrunk(repository, "c");
      const github = fakeGitHub({}, []);
      yield* submitIn(repository, github, { revision: "b" });
      const branches = yield* repository.branches;
      expect({
        branches: EffectRecord.keys(branches),
        calls: github.calls,
      }).toStrictEqual({
        branches: ["a", "b", "main"],
        calls: ["open a on main as a draft", "open b on a as a draft", "create stack 99,100"],
      });
    }),
  );

  itEffect("fails before pushing anything where a submitted change has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* conflictWithTrunk(repository, "b");
      const github = fakeGitHub({}, []);
      const failure = yield* Effect.flip(submitIn(repository, github, { revision: "b" }));
      const labels = yield* labelsOf(repository, "b");
      const branches = yield* repository.branches;
      expect({
        branches: EffectRecord.keys(branches),
        calls: github.calls,
        message: failure.message,
      }).toStrictEqual({
        branches: ["main"],
        calls: [],
        message: `resolve the conflicts first:\n${labels}`,
      });
    }),
  );

  itEffect("pushes the bookmarks, opens the missing pull requests and registers a new stack", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b");
      const github = fakeGitHub({}, []);
      yield* submitIn(repository, github);
      const branches = yield* repository.branches;
      expect(EffectRecord.keys(branches)).toEqual(["a", "b", "main"]);
      expect(github.calls).toEqual([
        "open a on main as a draft",
        "open b on a as a draft",
        "create stack 99,100",
      ]);
    }),
  );

  itEffect("opens the missing pull requests ready for review when not drafts", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b");
      const github = fakeGitHub({}, []);
      yield* submitIn(repository, github, { draft: false });
      expect(github.calls).toEqual(["open a on main", "open b on a", "create stack 99,100"]);
    }),
  );

  itEffect(
    "marks the existing drafts ready when not drafts, and opens the missing ones ready",
    () =>
      Effect.gen(function* () {
        const repository = yield* scratchRepository;
        yield* repository.stack("a", "b", "c");
        const github = fakeGitHub(
          {
            a: openPullRequest("main", 1, "a"),
            b: { ...openPullRequest("a", 2, "b"), draft: false },
          },
          stackOf(1, 2),
        );
        yield* submitIn(repository, github, { draft: false });
        expect(github.calls).toStrictEqual(["open c on b", "add 99 to #7", "publish #1"]);
      }),
  );

  itEffect("changes nothing on GitHub for a stack already in order", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b");
      const github = fakeGitHub(
        { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
        stackOf(1, 2),
      );
      yield* submitIn(repository, github);
      expect(github.calls).toEqual([]);
    }),
  );

  itEffect("appends a pull request opened on top", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      const github = fakeGitHub(
        { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
        stackOf(1, 2),
      );
      yield* submitIn(repository, github);
      expect(github.calls).toEqual(["open c on b as a draft", "add 99 to #7"]);
    }),
  );

  itEffect("submits a named change and the ones below it, from a working copy elsewhere", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("new", "main", "-m", "d");
      const github = fakeGitHub({}, []);
      yield* submitIn(repository, github, { revision: "b" });
      const branches = yield* repository.branches;
      expect(EffectRecord.keys(branches)).toEqual(["a", "b", "main"]);
      expect(github.calls).toEqual([
        "open a on main as a draft",
        "open b on a as a draft",
        "create stack 99,100",
      ]);
    }),
  );
});
