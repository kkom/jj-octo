import { describe, expect } from "bun:test";

import { Effect, FileSystem, Layer } from "effect";

import { IGNORE_CLAUDE_CODE_FOOTER, readSetting, type Setting } from "./settings";
import { environment } from "./testing/environment";
import { gitClone } from "./testing/git-clone";
import { itEffect, provideSetup } from "./testing/it-effect";
import { scratchRepository } from "./testing/scratch-repository";

const mode: Setting<"fast" | "slow"> = {
  choices: [
    { description: "Goes fast.", value: "fast" },
    { description: "Goes slow.", value: "slow" },
  ],
  default: { description: "slow", value: Effect.succeed("slow") },
  description: "How fast it goes.",
  key: "jj-octo.mode",
};

/** A clone whose jj config holds `config`, and reads settings with `env` as the environment. */
const reader = (config: string, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repository = yield* scratchRepository;
    const clone = yield* gitClone(repository);
    yield* Effect.orDie(fs.writeFileString(clone.jjConfigFile, config));
    return <A extends boolean | string>(setting: Setting<A>) =>
      readSetting(setting).pipe(
        Effect.map((value) => ({ value })),
        Effect.catch(({ message }) => Effect.succeed({ message })),
        provideSetup(Layer.merge(clone.layer, environment(env))),
      );
  });

describe("readSetting", () => {
  itEffect("reads a choice, the default where the key has none, and fails on any other value", () =>
    Effect.gen(function* () {
      const set = yield* reader('[jj-octo]\nmode = "fast"\nignore-claude-code-footer = "yes"\n');
      const unset = yield* reader("");
      expect([
        yield* set(mode),
        yield* unset(mode),
        yield* set(IGNORE_CLAUDE_CODE_FOOTER),
      ]).toStrictEqual([
        { value: "fast" },
        { value: "slow" },
        { message: 'jj-octo.ignore-claude-code-footer is "yes"; set it to true or false' },
      ]);
    }),
  );

  itEffect("reads a choice of another type as a value it doesn't know", () =>
    Effect.gen(function* () {
      const read = yield* reader("[jj-octo]\nmode = true\n");
      const result = yield* read(mode);
      expect(result).toStrictEqual({
        message: "jj-octo.mode is true; set it to fast or slow",
      });
    }),
  );

  itEffect("reads a default that depends on the environment", () =>
    Effect.gen(function* () {
      const inCloudSession = yield* reader("", { CLAUDE_CODE_REMOTE: "true" });
      const elsewhere = yield* reader("");
      const overridden = yield* reader("[jj-octo]\nignore-claude-code-footer = false\n", {
        CLAUDE_CODE_REMOTE: "true",
      });
      expect([
        yield* inCloudSession(IGNORE_CLAUDE_CODE_FOOTER),
        yield* elsewhere(IGNORE_CLAUDE_CODE_FOOTER),
        yield* overridden(IGNORE_CLAUDE_CODE_FOOTER),
      ]).toStrictEqual([{ value: true }, { value: false }, { value: false }]);
    }),
  );
});
