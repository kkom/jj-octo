import { Effect, FileSystem, Layer, Path, type Scope, String as EffectString } from "effect";

import type { Git } from "../clients/git";
import type { Jj } from "../clients/jj";
import {
  isolatedEnv,
  layerAt,
  makeExecutor,
  type ScratchServices,
  scratchDirectory,
} from "./scratch-process";
import type { ScratchRepository } from "./scratch-repository";

/**
 * A plain git clone of a repository's `origin`, with no jj repository, and git's identity, under
 * `name`, set in its own config. jj reads an empty configuration, so it has no identity of its own.
 * `layerAt` gives the git and jj clients in another directory, such as a worktree of the clone.
 * The clone's directory is removed when the test's scope closes.
 */
export const gitClone = (
  repository: ScratchRepository,
  name = "Cloner",
): Effect.Effect<
  {
    readonly git: (...args: readonly string[]) => Effect.Effect<string>;
    readonly jj: (...args: readonly string[]) => Effect.Effect<string>;
    /** The jj config file that jj reads in place of the user's. */
    readonly jjConfigFile: string;
    readonly layer: Layer.Layer<Git | Jj>;
    readonly layerAt: (directory: string) => Layer.Layer<Git | Jj>;
  },
  never,
  ScratchServices | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<ScratchServices>();
    const root = yield* scratchDirectory("clone-");
    const env = isolatedEnv(root);
    const jjConfigFile = env["JJ_CONFIG"] ?? "";
    yield* Effect.orDie(fs.writeFileString(jjConfigFile, ""));
    const execute = yield* makeExecutor(env);
    const checkout = path.join(root, "checkout");
    const originUrl = yield* repository.git("remote", "get-url", "origin");
    const origin = EffectString.trim(originUrl);
    yield* execute(root, ["git", "clone", "--quiet", origin, checkout]);
    yield* execute(checkout, ["git", "config", "user.name", name]);
    yield* execute(checkout, ["git", "config", "user.email", "cloner@example.com"]);
    const printed: string[] = [];
    const print = (text: string): void => {
      printed.push(text);
    };
    const layerIn = (directory: string) =>
      layerAt(directory, env, print).pipe(Layer.provide(Layer.succeedContext(services)));
    return {
      git: (...args: readonly string[]) => execute(checkout, ["git", ...args]),
      jj: (...args: readonly string[]) => execute(checkout, ["jj", ...args]),
      jjConfigFile,
      layer: layerIn(checkout),
      layerAt: layerIn,
    };
  });
