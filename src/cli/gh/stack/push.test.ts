import { expect } from "bun:test";

import { Effect, Layer, Record as EffectRecord } from "effect";

import { conflictWithTrunk } from "../../../testing/conflicts";
import {
  fakeGitHub,
  gitHubCalls,
  setUpGitHub,
  setUpPullRequestsAB,
} from "../../../testing/fake-github";
import { layer } from "../../../testing/it-effect";
import { openPullRequestsAB, stackOf } from "../../../testing/pull-requests";
import { ScratchRepository, scratchRepository } from "../../../testing/scratch-repository";
import { submitting } from "../../../testing/submit";
import { NotAStack } from "./changes";

layer(Layer.merge(scratchRepository, fakeGitHub))("submit", (it) => {
  it("submits a change and the ones below it where a change above has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* conflictWithTrunk("c");
      yield* submitting({ revision: "b" });
      const branches = yield* repository.branches;
      expect({
        branches: EffectRecord.keys(branches),
        calls: yield* gitHubCalls,
      }).toStrictEqual({
        branches: ["a", "b", "main"],
        calls: ["open a on main as a draft", "open b on a as a draft", "create stack 99,100"],
      });
    }));

  it("fails before pushing anything where a submitted change has conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* conflictWithTrunk("b");
      const failure = yield* Effect.flip(submitting({ revision: "b" }));
      const labels = yield* repository.labels("b");
      const branches = yield* repository.branches;
      expect({
        branches: EffectRecord.keys(branches),
        calls: yield* gitHubCalls,
        failure,
      }).toStrictEqual({
        branches: ["main"],
        calls: [],
        failure: NotAStack.make({ message: `resolve the conflicts first:\n${labels}` }),
      });
    }));

  it("pushes the bookmarks, opens the missing pull requests and registers a new stack", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      yield* submitting();
      const branches = yield* repository.branches;
      expect({
        branches: EffectRecord.keys(branches),
        calls: yield* gitHubCalls,
      }).toStrictEqual({
        branches: ["a", "b", "main"],
        calls: ["open a on main as a draft", "open b on a as a draft", "create stack 99,100"],
      });
    }));

  it("opens the missing pull requests ready for review when not drafts", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      yield* submitting({ draft: false });
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["open a on main", "open b on a", "create stack 99,100"]);
    }));

  it("marks the existing drafts ready when not drafts, and opens the missing ones ready", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* setUpGitHub({
        open: { ...openPullRequestsAB, b: { ...openPullRequestsAB.b, draft: false } },
        stacks: stackOf(1, 2),
      });
      yield* submitting({ draft: false });
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["open c on b", "add 99 to #7", "publish #1"]);
    }));

  it("changes nothing on GitHub for a stack already in order", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      yield* setUpPullRequestsAB();
      yield* submitting();
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual([]);
    }));

  it("appends a pull request opened on top", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* setUpPullRequestsAB();
      yield* submitting();
      const calls = yield* gitHubCalls;
      expect(calls).toStrictEqual(["open c on b as a draft", "add 99 to #7"]);
    }));

  it("submits a named change and the ones below it, from a working copy elsewhere", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("new", "main", "-m", "d");
      yield* submitting({ revision: "b" });
      const branches = yield* repository.branches;
      expect({
        branches: EffectRecord.keys(branches),
        calls: yield* gitHubCalls,
      }).toStrictEqual({
        branches: ["a", "b", "main"],
        calls: ["open a on main as a draft", "open b on a as a draft", "create stack 99,100"],
      });
    }));
});
