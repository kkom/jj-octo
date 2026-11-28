import { afterAll, describe, expect } from "bun:test";

import { Array as EffectArray, Effect, Option } from "effect";

import { PullRequestNumberSchema } from "../../clients/github/types";
import { squashMergeOnGitHub } from "../../testing/branch-changes";
import { itEffect } from "../../testing/it-effect";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { syncing } from "../../testing/sync";

afterAll(removeScratchRepositories);

const [one, two] = [PullRequestNumberSchema.make(1), PullRequestNumberSchema.make(2)];

// A stack of `a` and `b`, with a record of each pull request's description.
const recorded = Effect.gen(function* () {
  const repository = pushedStack("a", "b");
  yield* repository.records((store) =>
    Effect.all(
      [
        store.write({ bookmark: "a", commit: "1", description: "a", pullRequest: one }),
        store.write({ bookmark: "b", commit: "2", description: "b", pullRequest: two }),
      ],
      { concurrency: "unbounded" },
    ),
  );
  return repository;
});

const left = (repository: ScratchRepository) =>
  repository.records((store) =>
    Effect.all([store.read(one, "a"), store.read(two, "b")], { concurrency: "unbounded" }).pipe(
      Effect.map((records) =>
        EffectArray.map(records, (record) => Option.map(record, ({ description }) => description)),
      ),
    ),
  );

describe("sync", () => {
  itEffect("deletes the recorded descriptions of merged pull requests, and keeps the others", () =>
    Effect.gen(function* () {
      const repository = yield* recorded;
      squashMergeOnGitHub(repository, "a");
      yield* syncing(repository);
      const descriptions = yield* left(repository);
      expect(descriptions).toStrictEqual([Option.none(), Option.some("b")]);
    }),
  );
});
