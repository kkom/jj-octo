import { describe, expect } from "bun:test";

import { Effect, FileSystem, Path, String as EffectString } from "effect";

import { gitClone } from "../testing/git-clone";
import { itEffect, provideSetup } from "../testing/it-effect";
import { scratchRepository } from "../testing/scratch-repository";
import { GitFailed, gitConfig } from "./git";

describe("gitConfig", () => {
  itEffect(
    "reads a key without a value as an empty string, and fails on a config git can't read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repository = yield* scratchRepository;
        const clone = yield* gitClone(repository);
        const value = yield* gitConfig(["jj-octo.no-such-key"]).pipe(provideSetup(clone.layer));
        expect(value).toBe("");
        const gitDirectory = yield* clone.git("rev-parse", "--absolute-git-dir");
        const config = path.join(EffectString.trim(gitDirectory), "config");
        const original = yield* Effect.orDie(fs.readFileString(config));
        yield* Effect.orDie(fs.writeFileString(config, `${original}[\n`));
        const failure = yield* Effect.flip(gitConfig(["jj-octo.no-such-key"])).pipe(
          provideSetup(clone.layer),
        );
        const written = yield* Effect.orDie(fs.readFileString(config));
        const badLine = EffectString.split(written, "\n").length - 1;
        expect(failure).toStrictEqual(
          GitFailed.make({
            exitCode: 128,
            message: `git config jj-octo.no-such-key failed: fatal: bad config line ${badLine} in file .git/config`,
          }),
        );
      }),
  );
});
