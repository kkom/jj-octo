import { afterAll, describe, expect } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { Effect, String as EffectString } from "effect";

import { gitClone } from "../testing/git-clone";
import { itEffect, provideSetup } from "../testing/it-effect";
import { removeScratchRepositories, scratchRepository } from "../testing/scratch-repository";
import { GitFailed, gitConfig } from "./git";

afterAll(removeScratchRepositories);

describe("gitConfig", () => {
  itEffect(
    "reads a key without a value as an empty string, and fails on a config git can't read",
    () =>
      Effect.gen(function* () {
        const clone = gitClone(scratchRepository());
        const value = yield* gitConfig(["jj-octo.no-such-key"]).pipe(provideSetup(clone.layer));
        expect(value).toBe("");
        const config = path.join(
          EffectString.trim(clone.git("rev-parse", "--absolute-git-dir")),
          "config",
        );
        appendFileSync(config, "[\n");
        const failure = yield* Effect.flip(gitConfig(["jj-octo.no-such-key"])).pipe(
          provideSetup(clone.layer),
        );
        const badLine = EffectString.split(readFileSync(config, "utf8"), "\n").length - 1;
        expect(failure).toStrictEqual(
          GitFailed.make({
            exitCode: 128,
            message: `git config jj-octo.no-such-key failed: fatal: bad config line ${badLine} in file .git/config`,
          }),
        );
      }),
  );
});
