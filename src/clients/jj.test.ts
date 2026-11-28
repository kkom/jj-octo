import { afterAll, describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";

import { Array as EffectArray, Effect } from "effect";

import { gitClone } from "../testing/git-clone";
import { itEffect, provideSetup } from "../testing/it-effect";
import { removeScratchRepositories, scratchRepository } from "../testing/scratch-repository";
import { Jj, JjFailed, jjConfig } from "./jj";

afterAll(removeScratchRepositories);

describe("jjConfig", () => {
  itEffect(
    "reads a key without a value as an empty string, and fails on a config jj can't read",
    () =>
      Effect.gen(function* () {
        const clone = gitClone(scratchRepository());
        const value = yield* jjConfig("jj-octo.no-such-key").pipe(provideSetup(clone.layer));
        expect(value).toBe("");
        const config = clone.jjConfigFile;
        writeFileSync(config, "[");
        const failure = yield* Effect.flip(jjConfig("jj-octo.no-such-key")).pipe(
          provideSetup(clone.layer),
        );
        expect(failure).toStrictEqual(
          JjFailed.make({
            message: EffectArray.join(
              [
                "Config error: Configuration cannot be parsed as TOML document",
                "Caused by: TOML parse error at line 1, column 2",
                "  |",
                "1 | [",
                "  |  ^",
                "unquoted keys cannot be empty, expected letters, numbers, `-`, `_`",
                "",
                `Hint: Check the config file: ${config}`,
                "For help, see https://docs.jj-vcs.dev/latest/config/ or use `jj help -k config`.",
              ],
              "\n",
            ),
          }),
        );
      }),
  );

  itEffect("reads strings, and fails on a value of another type", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      writeFileSync(
        clone.jjConfigFile,
        '[jj-octo]\non = true\nword = "true"\ntable = { a = "x" }\n',
      );
      const read = <A>(program: Effect.Effect<A, JjFailed, Jj>) =>
        program.pipe(
          Effect.map((value) => ({ value })),
          Effect.catch(({ message }) => Effect.succeed({ message })),
          provideSetup(clone.layer),
        );
      expect([
        yield* read(jjConfig("jj-octo.word")),
        yield* read(jjConfig("jj-octo.on")),
        yield* read(jjConfig("jj-octo.table")),
      ]).toStrictEqual([
        { value: "true" },
        { message: "jj-octo.on is true; set it to a string" },
        { message: "jj-octo.table is a table; set it to a single value" },
      ]);
    }),
  );
});

const dryRun = (args: readonly string[]) => Jj.use((jj) => jj.dryRun(args));

describe("Jj.dryRun", () => {
  // For the edited file, jj snapshots the working copy in an operation of its own, whose id it
  // prints first.
  itEffect("leaves the repository as it is, and returns the operation that holds the result", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.jj("config", "set", "--repo", "ui.quiet", "true");
      const operations = repository.jj("operation", "log", "--no-graph", "-T", "id");
      repository.write("edited.txt", "edited\n");
      const operation = yield* dryRun(["describe", "-m", "tried"]).pipe(
        provideSetup(repository.layer),
      );
      const description = [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        "@",
        "-T",
        "description",
      ];
      expect([
        repository.jj("operation", "log", "--ignore-working-copy", "--no-graph", "-T", "id"),
        repository.jj(...description),
        repository.jj("--at-operation", operation, ...description),
      ]).toStrictEqual([operations, "", "tried\n"]);
    }),
  );

  itEffect("fails where the command changes nothing", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      const failure = yield* Effect.flip(dryRun(["describe", "-m", ""])).pipe(
        provideSetup(repository.layer),
      );
      expect(failure).toStrictEqual(
        JjFailed.make({ message: "jj describe -m  made no operation" }),
      );
    }),
  );
});
