import {
  Array as EffectArray,
  Effect,
  Record as EffectRecord,
  String as EffectString,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readOutput } from "../clients/process";

const dist = new URL("../../dist", import.meta.url).pathname;

/**
 * What `bun run test` builds first: the file npm publishes, run through its shebang, and this
 * platform's standalone executable, which carries Bun.
 */
export const builds: readonly {
  readonly command: readonly [string, ...string[]];
  readonly name: string;
}[] = [
  { command: [`${dist}/jj-octo.js`], name: "the built file" },
  { command: [`${dist}/jj-octo`], name: "the standalone executable" },
];

// The tests' environment without its proxy settings, which would route requests past the proxy
// under test.
const proxySettings = new Set(["http_proxy", "https_proxy", "no_proxy", "node_extra_ca_certs"]);
const inherited = EffectRecord.filter(
  process.env,
  (_, key) => !proxySettings.has(EffectString.toLowerCase(key)),
);

export interface RunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Runs a build with `args`. Where it exits non-zero, dies with its stderr. It waits without
 * blocking, so a proxy in this process can answer, and kills the build if interrupted.
 */
export const output = (
  command: readonly [string, ...string[]],
  args: readonly string[],
  options: RunOptions,
): Effect.Effect<
  { readonly stderr: string; readonly stdout: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const [file, ...leading] = command;
      const handle = yield* spawner.spawn(
        ChildProcess.make(file, [...leading, ...args], {
          cwd: options.cwd,
          env: { ...inherited, ...options.env },
          extendEnv: false,
          stdin: "ignore",
        }),
      );
      const { exitCode, stderr, stdout } = yield* readOutput(handle);
      if (exitCode !== 0) {
        return yield* Effect.die(
          new Error(`jj-octo ${EffectArray.join(args, " ")} failed:\n${stderr}`),
        );
      }
      return { stderr, stdout };
    }),
  ).pipe(Effect.orDie);

/** `output`'s stdout. */
export const run = (
  command: readonly [string, ...string[]],
  args: readonly string[],
  options: RunOptions,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
  output(command, args, options).pipe(Effect.map(({ stdout }) => stdout));
