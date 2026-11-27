import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { removeScratchRepositories, scratchDirectory } from "../src/testing/scratch-repository";

afterAll(removeScratchRepositories);

const script = path.join(import.meta.dirname, "effect-tsgo-oxlint.sh");

// Outside the repository, as the editor may start the script from anywhere.
const directory = scratchDirectory("effect-tsgo-oxlint-");
const file = path.join(directory, "linted.ts");
const config = path.join(directory, ".oxlintrc.json");
writeFileSync(
  config,
  JSON.stringify({
    plugins: ["effecttsgo"],
    rules: { "effecttsgo/prefer-effect-array": "error" },
  }),
);

// Lints a file holding the line given, with a config naming the effecttsgo plugin. The format is
// named, since oxlint chooses its default from the environment.
const lint = async (line: string) => {
  writeFileSync(file, `${line}\n`);
  const child = Bun.spawn([script, "--format", "unix", "--type-aware", "-c", config, file], {
    cwd: directory,
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
};

describe("effect-tsgo-oxlint.sh", () => {
  it("passes a file that breaks no effecttsgo rule", async () => {
    expect(await lint("export const value = 1;")).toStrictEqual({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
  });

  it("reports a file that breaks an effecttsgo rule", async () => {
    expect(
      await lint("export const isList = (value: unknown): boolean => Array.isArray(value);"),
    ).toStrictEqual({
      exitCode: 1,
      stderr: "",
      stdout: `${file}:1:58: Consider effect/Array.isArray instead of native Array.isArray. Narrows elements to unknown rather than any. [Error/effecttsgo(prefer-effect-array)]\n\n1 problem\n`,
    });
  });
});
