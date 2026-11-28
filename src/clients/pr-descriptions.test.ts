import { expect } from "bun:test";

import { DateTime, Effect, FileSystem, Option, Path, Ref } from "effect";

import { layer, setTestClockToLiveTime } from "../testing/it-effect";
import { ScratchRepository, scratchRepository } from "../testing/scratch-repository";
import { addWorkspace } from "../testing/workspace";
import { PullRequestNumberSchema } from "./github/types";
import { PrDescriptions } from "./pr-descriptions";

const pullRequest = PullRequestNumberSchema.make(7);
const record = { bookmark: "a", commit: "abc", description: "a\n\nbody", pullRequest };

const recordsDirectory: Effect.Effect<string, never, Path.Path | ScratchRepository> = Effect.gen(
  function* () {
    const path = yield* Path.Path;
    const repository = yield* ScratchRepository;
    return path.join(repository.checkout, ".jj", "repo", "jj-octo", "pr-descriptions");
  },
);

layer(scratchRepository)("PrDescriptions", (it) => {
  it("shares its records with a workspace added to the repository", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      const workspace = yield* addWorkspace("@");
      const store = yield* PrDescriptions;
      yield* store.write(record);
      const clients = yield* repository.clientsIn(workspace);
      const read = yield* PrDescriptions.use((inWorkspace) =>
        inWorkspace.read(pullRequest, "a"),
      ).pipe(Effect.provide(clients));
      expect(read).toStrictEqual(
        Option.some({ bookmark: "a", commit: "abc", description: "a\n\nbody" }),
      );
    }));

  it("reads no record written for another bookmark", () =>
    Effect.gen(function* () {
      const store = yield* PrDescriptions;
      yield* store.write(record);
      const read = yield* store.read(pullRequest, "b");
      expect(read).toStrictEqual(Option.none());
    }));

  it("reads no record for a pull request it never recorded", () =>
    Effect.gen(function* () {
      const store = yield* PrDescriptions;
      const read = yield* store.read(pullRequest, "a");
      expect(read).toStrictEqual(Option.none());
    }));

  it("prunes the records of other bookmarks and the unreadable ones", () =>
    Effect.gen(function* () {
      const store = yield* PrDescriptions;
      const other = PullRequestNumberSchema.make(8);
      yield* Effect.all(
        [store.write(record), store.write({ ...record, bookmark: "b", pullRequest: other })],
        { concurrency: "unbounded" },
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* recordsDirectory;
      yield* Effect.orDie(fs.writeFileString(path.join(directory, "9"), "not json"));
      yield* store.prune(Effect.succeed(["a"]));
      const remaining = yield* Effect.orDie(fs.readDirectory(directory));
      expect(remaining).toStrictEqual(["7"]);
    }));

  it("reads no bookmarks to prune where there are no records", () =>
    Effect.gen(function* () {
      const store = yield* PrDescriptions;
      const isRead = yield* Ref.make(false);
      yield* store.prune(Ref.set(isRead, true).pipe(Effect.as([])));
      const read = yield* Ref.get(isRead);
      expect(read).toBe(false);
    }));

  it("prunes what a write that stopped an hour ago left, and keeps a recent one", () =>
    Effect.gen(function* () {
      yield* setTestClockToLiveTime;
      const store = yield* PrDescriptions;
      yield* store.write(record);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* recordsDirectory;
      const stopped = path.join(directory, "8.0b6e4a.partial");
      const recent = path.join(directory, "8.9f1c2d.partial");
      yield* Effect.orDie(fs.writeFileString(stopped, "{"));
      yield* Effect.orDie(fs.writeFileString(recent, "{"));
      const now = yield* DateTime.now;
      const twoHoursAgo = DateTime.toDateUtc(DateTime.subtract(now, { hours: 2 }));
      yield* Effect.orDie(fs.utimes(stopped, twoHoursAgo, twoHoursAgo));
      yield* store.prune(Effect.succeed(["a"]));
      const stoppedExists = yield* Effect.orDie(fs.exists(stopped));
      const recentExists = yield* Effect.orDie(fs.exists(recent));
      expect([stoppedExists, recentExists]).toStrictEqual([false, true]);
    }));
});
