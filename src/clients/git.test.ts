import { expect } from "bun:test";

import { Effect, FileSystem, Path, String as EffectString } from "effect";

import { GitClone, gitClone } from "../testing/git-clone";
import { layer } from "../testing/it-effect";
import { GitFailed, gitConfig } from "./git";

layer(gitClone())("gitConfig", (it) => {
  it("reads a key without a value as an empty string, and fails on a config git can't read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const clone = yield* GitClone;
      const value = yield* gitConfig(["jj-octo.no-such-key"]);
      expect(value).toBe("");
      const gitDirectory = yield* clone.git("rev-parse", "--absolute-git-dir");
      const config = path.join(EffectString.trim(gitDirectory), "config");
      const original = yield* Effect.orDie(fs.readFileString(config));
      yield* Effect.orDie(fs.writeFileString(config, `${original}[\n`));
      const failure = yield* Effect.flip(gitConfig(["jj-octo.no-such-key"]));
      const written = yield* Effect.orDie(fs.readFileString(config));
      const badLine = EffectString.split(written, "\n").length - 1;
      expect(failure).toStrictEqual(
        GitFailed.make({
          exitCode: 128,
          message: `git config jj-octo.no-such-key failed: fatal: bad config line ${badLine} in file .git/config`,
        }),
      );
    }));
});
