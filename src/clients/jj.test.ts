import { expect } from "bun:test";

import { Array as EffectArray, Effect, FileSystem, Result } from "effect";

import { GitClone, gitClone } from "../testing/git-clone";
import { layer } from "../testing/it-effect";
import { ScratchRepository, scratchRepository } from "../testing/scratch-repository";
import { Jj, JjFailed, jjConfig } from "./jj";

layer(gitClone())("jjConfig", (it) => {
  it("reads a key without a value as an empty string, and fails on a config jj can't read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clone = yield* GitClone;
      const value = yield* jjConfig("jj-octo.no-such-key");
      expect(value).toBe("");
      const config = clone.jjConfigFile;
      yield* Effect.orDie(fs.writeFileString(config, "["));
      const failure = yield* Effect.flip(jjConfig("jj-octo.no-such-key"));
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
    }));

  it("reads strings, and fails on a value of another type", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clone = yield* GitClone;
      yield* Effect.orDie(
        fs.writeFileString(
          clone.jjConfigFile,
          '[jj-octo]\non = true\nword = "true"\ntable = { a = "x" }\n',
        ),
      );
      const word = yield* Effect.result(jjConfig("jj-octo.word"));
      const on = yield* Effect.result(jjConfig("jj-octo.on"));
      const table = yield* Effect.result(jjConfig("jj-octo.table"));
      expect([word, on, table]).toStrictEqual([
        Result.succeed("true"),
        Result.fail(JjFailed.make({ message: "jj-octo.on is true; set it to a string" })),
        Result.fail(
          JjFailed.make({ message: "jj-octo.table is a table; set it to a single value" }),
        ),
      ]);
    }));
});

const dryRun = (args: readonly string[]) => Jj.use((jj) => jj.dryRun(args));

layer(scratchRepository)("Jj.dryRun", (it) => {
  // For the edited file, jj snapshots the working copy in an operation of its own, whose id it
  // prints first.
  it("leaves the repository as it is, and returns the operation that holds the result", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.jj("config", "set", "--repo", "ui.quiet", "true");
      const operations = yield* repository.jj("operation", "log", "--no-graph", "-T", "id");
      yield* repository.write("edited.txt", "edited\n");
      const operation = yield* dryRun(["describe", "-m", "tried"]);
      const description = [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        "@",
        "-T",
        "description",
      ];
      const operationsAfter = yield* repository.jj(
        "operation",
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-T",
        "id",
      );
      const descriptionBefore = yield* repository.jj(...description);
      const descriptionInOperation = yield* repository.jj(
        "--at-operation",
        operation,
        ...description,
      );
      expect([operationsAfter, descriptionBefore, descriptionInOperation]).toStrictEqual([
        operations,
        "",
        "tried\n",
      ]);
    }));

  it("fails where the command changes nothing", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(dryRun(["describe", "-m", ""]));
      expect(failure).toStrictEqual(
        JjFailed.make({ message: "jj describe -m  made no operation" }),
      );
    }));
});
