import { expect } from "bun:test";

import { Effect, FileSystem } from "effect";

import { IGNORE_CLAUDE_CODE_FOOTER, readSetting, type Setting } from "./settings";
import { withEnvironment } from "./testing/environment";
import { GitClone, gitClone } from "./testing/git-clone";
import { layer } from "./testing/it-effect";

const mode: Setting<"fast" | "slow"> = {
  choices: [
    { description: "Goes fast.", value: "fast" },
    { description: "Goes slow.", value: "slow" },
  ],
  default: { description: "slow", value: Effect.succeed("slow") },
  description: "How fast it goes.",
  key: "jj-octo.mode",
};

/**
 * Writes `config` as the clone's jj config, then reads the setting with `env` as the environment.
 */
const readWith = <A extends boolean | string>(
  setting: Setting<A>,
  config: string,
  env: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const clone = yield* GitClone;
    yield* Effect.orDie(fs.writeFileString(clone.jjConfigFile, config));
    return yield* readSetting(setting).pipe(
      Effect.map((value) => ({ value })),
      Effect.catch(({ message }) => Effect.succeed({ message })),
      withEnvironment(env),
    );
  });

layer(gitClone())("readSetting", (it) => {
  it("reads a choice, the default where the key has none, and fails on any other value", () =>
    Effect.gen(function* () {
      const config = '[jj-octo]\nmode = "fast"\nignore-claude-code-footer = "yes"\n';
      const set = yield* readWith(mode, config);
      const unset = yield* readWith(mode, "");
      const invalid = yield* readWith(IGNORE_CLAUDE_CODE_FOOTER, config);
      expect([set, unset, invalid]).toStrictEqual([
        { value: "fast" },
        { value: "slow" },
        { message: 'jj-octo.ignore-claude-code-footer is "yes"; set it to true or false' },
      ]);
    }));

  it("reads a choice of another type as a value it doesn't know", () =>
    Effect.gen(function* () {
      const result = yield* readWith(mode, "[jj-octo]\nmode = true\n");
      expect(result).toStrictEqual({
        message: "jj-octo.mode is true; set it to fast or slow",
      });
    }));

  it("reads a default that depends on the environment", () =>
    Effect.gen(function* () {
      const inCloudSession = yield* readWith(IGNORE_CLAUDE_CODE_FOOTER, "", {
        CLAUDE_CODE_REMOTE: "true",
      });
      const elsewhere = yield* readWith(IGNORE_CLAUDE_CODE_FOOTER, "");
      const overridden = yield* readWith(
        IGNORE_CLAUDE_CODE_FOOTER,
        "[jj-octo]\nignore-claude-code-footer = false\n",
        { CLAUDE_CODE_REMOTE: "true" },
      );
      expect([inCloudSession, elsewhere, overridden]).toStrictEqual([
        { value: true },
        { value: false },
        { value: false },
      ]);
    }));
});
