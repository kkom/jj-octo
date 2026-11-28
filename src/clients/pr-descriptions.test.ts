import { afterAll, describe, expect } from "bun:test";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DateTime, Effect, Option, String as EffectString } from "effect";

import { itEffect, provideSetup, setTestClockToLiveTime } from "../testing/it-effect";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchRepository,
} from "../testing/scratch-repository";
import { PullRequestNumberSchema } from "./github/types";
import { PrDescriptions } from "./pr-descriptions";

afterAll(removeScratchRepositories);

const pullRequest = PullRequestNumberSchema.make(7);
const record = { bookmark: "a", commit: "abc", description: "a\n\nbody", pullRequest };

const recordsDirectory = (repository: ScratchRepository): string =>
  path.join(
    EffectString.trim(repository.jj("workspace", "root")),
    ".jj",
    "repo",
    "jj-octo",
    "pr-descriptions",
  );

describe("PrDescriptions", () => {
  itEffect("shares its records with a workspace added to the repository", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      const workspace = path.join(
        path.dirname(EffectString.trim(repository.jj("workspace", "root"))),
        "workspace",
      );
      repository.jj("workspace", "add", "--quiet", workspace);
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
      const repository = scratchRepository();
      yield* repository.records((store) => store.write(record));
      const read = yield* repository.records((store) => store.read(pullRequest, "b"));
      expect(read).toStrictEqual(Option.none());
    }),
  );

  itEffect("reads no record for a pull request it never recorded", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      const read = yield* repository.records((store) => store.read(pullRequest, "a"));
      expect(read).toStrictEqual(Option.none());
    }),
  );

  itEffect("prunes the records of other bookmarks and the unreadable ones", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      const other = PullRequestNumberSchema.make(8);
      yield* repository.records((store) =>
        Effect.all(
          [store.write(record), store.write({ ...record, bookmark: "b", pullRequest: other })],
          { concurrency: "unbounded" },
        ),
      );
      writeFileSync(path.join(recordsDirectory(repository), "9"), "not json");
      yield* repository.records((store) => store.prune(Effect.succeed(["a"])));
      expect(readdirSync(recordsDirectory(repository))).toStrictEqual(["7"]);
    }),
  );

  itEffect("reads no bookmarks to prune where there are no records", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
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
      const repository = scratchRepository();
      yield* repository.records((store) => store.write(record));
      const directory = recordsDirectory(repository);
      const stopped = path.join(directory, "8.0b6e4a.partial");
      const recent = path.join(directory, "8.9f1c2d.partial");
      writeFileSync(stopped, "{");
      writeFileSync(recent, "{");
      const now = yield* DateTime.now;
      const twoHoursAgo = DateTime.toDateUtc(DateTime.subtract(now, { hours: 2 }));
      utimesSync(stopped, twoHoursAgo, twoHoursAgo);
      yield* repository.records((store) => store.prune(Effect.succeed(["a"])));
      expect([existsSync(stopped), existsSync(recent)]).toStrictEqual([false, true]);
    }),
  );
});
