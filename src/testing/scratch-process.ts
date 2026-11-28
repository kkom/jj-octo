import { Array as EffectArray, Effect, FileSystem, Layer, type Path, type Scope } from "effect";
import { SecureRandom } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type Git, gitLayer } from "../clients/git";
import { type Jj, jjLayer } from "../clients/jj";
import { type PrDescriptions, prDescriptionsLayer } from "../clients/pr-descriptions";
import { readOutput } from "../clients/process";
import { scratchParent } from "./templates";

/** The platform services that the scratch repositories run on. */
export type ScratchServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

/** A new directory, removed when the test's scope closes. */
export const scratchDirectory = (
  prefix: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* scratchParent;
    return yield* Effect.orDie(fs.makeTempDirectoryScoped({ directory: parent, prefix }));
  });

/**
 * The environment that keeps git and jj from reading the configuration of whoever runs the tests.
 * jj reads `config.toml` in the root instead.
 */
export const isolatedEnv = (root: string): Readonly<Record<string, string>> => ({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  JJ_CONFIG: `${root}/config.toml`,
});

/**
 * Runs a command in a directory with the environment, and returns what it printed. It dies with
 * what the command printed to stderr where it fails.
 */
export const makeExecutor = (
  env: Readonly<Record<string, string>>,
): Effect.Effect<
  (cwd: string, command: readonly [string, ...string[]]) => Effect.Effect<string>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.map(
    ChildProcessSpawner.ChildProcessSpawner,
    (spawner) =>
      (cwd: string, [command, ...args]: readonly [string, ...string[]]): Effect.Effect<string> =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, args, { cwd, env, extendEnv: true, stdin: "ignore" }),
            );
            const { exitCode, stderr, stdout } = yield* readOutput(handle);
            if (exitCode !== 0) {
              return yield* Effect.die(
                new Error(`${EffectArray.join([command, ...args], " ")} failed:\n${stderr}`),
              );
            }
            return stdout;
          }),
        ).pipe(Effect.orDie),
  );

/**
 * The git and jj clients, running in a directory with the environment. What jj commands that
 * change something print goes to `printed`, rather than into the test's output.
 */
export const layerAt = (
  cwd: string,
  env: Readonly<Record<string, string>>,
  printed: (text: string) => void,
): Layer.Layer<Git | Jj | PrDescriptions, never, ScratchServices> =>
  Layer.merge(
    gitLayer({ cwd, env }),
    Layer.provideMerge(prDescriptionsLayer, jjLayer({ cwd, env, printed })),
  ).pipe(Layer.provide(SecureRandom.layerWebCrypto));
