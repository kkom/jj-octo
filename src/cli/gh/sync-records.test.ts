import { expect } from "bun:test";

import { Array as EffectArray, Effect, Layer, Option } from "effect";

import { PullRequestNumberSchema } from "../../clients/github/types";
import { PrDescriptions } from "../../clients/pr-descriptions";
import { squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { pushedStack } from "../../testing/scratch-repository";
import { syncing } from "../../testing/sync";

const [one, two] = [PullRequestNumberSchema.make(1), PullRequestNumberSchema.make(2)];

// Records the description of the pull request of `a` and of `b`.
const record = Effect.gen(function* () {
  const store = yield* PrDescriptions;
  yield* Effect.all(
    [
      store.write({ bookmark: "a", commit: "1", description: "a", pullRequest: one }),
      store.write({ bookmark: "b", commit: "2", description: "b", pullRequest: two }),
    ],
    { concurrency: "unbounded" },
  );
});

const left = Effect.gen(function* () {
  const store = yield* PrDescriptions;
  const records = yield* Effect.all([store.read(one, "a"), store.read(two, "b")], {
    concurrency: "unbounded",
  });
  return EffectArray.map(records, (found) => Option.map(found, ({ description }) => description));
});

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))("sync", (it) => {
  it("deletes the recorded descriptions of merged pull requests, and keeps the others", () =>
    Effect.gen(function* () {
      yield* record;
      yield* squashMergeOnGitHub("a");
      yield* syncing();
      const descriptions = yield* left;
      expect(descriptions).toStrictEqual([Option.none(), Option.some("b")]);
    }));
});
