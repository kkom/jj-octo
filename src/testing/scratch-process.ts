import { Array as EffectArray, Context, Effect, FileSystem, Layer, Path, type Scope } from "effect";
import { SecureRandom } from "effect/crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type Git, gitLayer } from "../clients/git";
import { type Jj, jjLayer } from "../clients/jj";
import { type PrDescriptions, prDescriptionsLayer } from "../clients/pr-descriptions";
import { readOutput } from "../clients/process";
import { scratchParent } from "./templates";

export type ScratchServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

/**
 * The `ScratchServices` of the current context. A fixture keeps them to build clients later, in
 * the caller's `Scope` rather than the fixture's.
 */
export const scratchServices: Effect.Effect<
  Context.Context<ScratchServices>,
  never,
  ScratchServices
> = Effect.map(
  Effect.context<ScratchServices>(),
  Context.pick(ChildProcessSpawner.ChildProcessSpawner, FileSystem.FileSystem, Path.Path),
);

/** A new directory, removed when the scope closes. */
export const scratchDirectory = (
  prefix: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* scratchParent;
    return yield* Effect.orDie(fs.makeTempDirectoryScoped({ directory: parent, prefix }));
  });

/** The file jj reads in place of the user's config. */
export const jjConfigFile = (root: string): string => `${root}/config.toml`;

/** Keeps git and jj from reading the configuration of whoever runs the tests. */
export const isolatedEnv = (root: string): Readonly<Record<string, string>> => ({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  JJ_CONFIG: jjConfigFile(root),
});

/** Runs a command and returns its stdout. Where it fails, dies with its stderr. */
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

export type RepositoryClients = Git | Jj | PrDescriptions;

/**
 * Builds the `RepositoryClients` in a directory. What jj commands that change something print goes
 * to `printed`, not the test's output.
 */
export const clientsIn = (
  cwd: string,
  env: Readonly<Record<string, string>>,
  printed: (text: string) => Effect.Effect<void>,
): Effect.Effect<Context.Context<RepositoryClients>, never, ScratchServices | Scope.Scope> =>
  Layer.build(
    Layer.merge(
      gitLayer({ cwd, env }),
      Layer.provideMerge(prDescriptionsLayer, jjLayer({ cwd, env, printed })),
    ).pipe(Layer.provide(SecureRandom.layerWebCrypto)),
  );
