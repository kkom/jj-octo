import { describe, expect } from "bun:test";

import { DateTime, Effect, FileSystem, Option, Path, String as EffectString } from "effect";

import { itEffect, provideSetup, setTestClockToLiveTime } from "../testing/it-effect";
import { type ScratchRepository, scratchRepository } from "../testing/scratch-repository";
import { PullRequestNumberSchema } from "./github/types";
import { PrDescriptions } from "./pr-descriptions";

const pullRequest = PullRequestNumberSchema.make(7);
const record = { bookmark: "a", commit: "abc", description: "a\n\nbody", pullRequest };

const recordsDirectory = (repository: ScratchRepository): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const workspaceRoot = yield* repository.jj("workspace", "root");
    return path.join(EffectString.trim(workspaceRoot), ".jj", "repo", "jj-octo", "pr-descriptions");
  });

describe("PrDescriptions", () => {
  itEffect("shares its records with a workspace added to the repository", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const path = yield* Path.Path;
      const workspaceRoot = yield* repository.jj("workspace", "root");
      const workspace = path.join(path.dirname(EffectString.trim(workspaceRoot)), "workspace");
      yield* repository.jj("workspace", "add", "--quiet", workspace);
      yield* repository.records((store) => store.write(record));
      const read = yield* Effect.flatMap(PrDescriptions, (store) =>
        store.read(pullRequest, "a"),
      ).pipe(provideSetup(repository.layerAt(workspace)));
      expect(read).toStrictEqual(
        Option.some({ bookmark: "a", commit: "abc", description: "a\n\nbody" }),
      );
    }),
  );

  itEffect("reads no record written for another bookmark", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.records((store) => store.write(record));
      const read = yield* repository.records((store) => store.read(pullRequest, "b"));
      expect(read).toStrictEqual(Option.none());
    }),
  );

  itEffect("reads no record for a pull request it never recorded", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const read = yield* repository.records((store) => store.read(pullRequest, "a"));
      expect(read).toStrictEqual(Option.none());
    }),
  );

  itEffect("prunes the records of other bookmarks and the unreadable ones", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const other = PullRequestNumberSchema.make(8);
      yield* repository.records((store) =>
        Effect.all(
          [store.write(record), store.write({ ...record, bookmark: "b", pullRequest: other })],
          { concurrency: "unbounded" },
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* recordsDirectory(repository);
      yield* Effect.orDie(fs.writeFileString(path.join(directory, "9"), "not json"));
      yield* repository.records((store) => store.prune(Effect.succeed(["a"])));
      const remaining = yield* Effect.orDie(fs.readDirectory(directory));
      expect(remaining).toStrictEqual(["7"]);
    }),
  );

  itEffect("reads no bookmarks to prune where there are no records", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      let isRead = false;
      yield* repository.records((store) =>
        store.prune(
          Effect.sync(() => {
            isRead = true;
            return [];
          }),
        ),
      );
      expect(isRead).toBe(false);
    }),
  );

  itEffect("prunes what a write that stopped an hour ago left, and keeps a recent one", () =>
    Effect.gen(function* () {
      yield* setTestClockToLiveTime;
      const repository = yield* scratchRepository;
      yield* repository.records((store) => store.write(record));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* recordsDirectory(repository);
      const stopped = path.join(directory, "8.0b6e4a.partial");
      const recent = path.join(directory, "8.9f1c2d.partial");
      yield* Effect.orDie(fs.writeFileString(stopped, "{"));
      yield* Effect.orDie(fs.writeFileString(recent, "{"));
      const now = yield* DateTime.now;
      const twoHoursAgo = DateTime.toDateUtc(DateTime.subtract(now, { hours: 2 }));
      yield* Effect.orDie(fs.utimes(stopped, twoHoursAgo, twoHoursAgo));
      yield* repository.records((store) => store.prune(Effect.succeed(["a"])));
      const stoppedExists = yield* Effect.orDie(fs.exists(stopped));
      const recentExists = yield* Effect.orDie(fs.exists(recent));
      expect([stoppedExists, recentExists]).toStrictEqual([false, true]);
    }),
  );
});
