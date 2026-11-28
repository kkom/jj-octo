import { Context, Effect, FileSystem, Layer, Path, type Scope } from "effect";

import {
  clientsIn,
  isolatedEnv,
  jjConfigFile,
  makeExecutor,
  type RepositoryClients,
  type ScratchServices,
  scratchDirectory,
  scratchServices,
} from "./scratch-process";
import { ScratchRepository, scratchRepositoryWithoutClients } from "./scratch-repository";

/**
 * A plain git clone of the scratch repository's `origin`, with no jj repository, and git's identity
 * set in its own config. jj reads an empty configuration, so it has no identity of its own.
 */
export class GitClone extends Context.Service<
  GitClone,
  {
    /**
     * Builds the git, jj and pull request description clients in a directory, such as a worktree
     * of the clone, as a `Context` for `Effect.provide`.
     */
    readonly clientsIn: (
      directory: string,
    ) => Effect.Effect<Context.Context<RepositoryClients>, never, Scope.Scope>;
    /** Runs git in the clone, and returns what it printed. */
    readonly git: (...args: readonly string[]) => Effect.Effect<string>;
    /** Runs jj in the clone, and returns what it printed. */
    readonly jj: (...args: readonly string[]) => Effect.Effect<string>;
    /** The jj config file that jj reads in place of the user's. */
    readonly jjConfigFile: string;
  }
>()("jj-octo/testing/git-clone/GitClone") {}

const clone = (
  name: string,
): Layer.Layer<GitClone | RepositoryClients, never, ScratchRepository | ScratchServices> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* ScratchRepository;
      const services = yield* scratchServices;
      const root = yield* scratchDirectory("clone-");
      const env = isolatedEnv(root);
      const configFile = jjConfigFile(root);
      yield* Effect.orDie(fs.writeFileString(configFile, ""));
      const execute = yield* makeExecutor(env);
      const checkout = path.join(root, "checkout");
      yield* execute(root, ["git", "clone", "--quiet", repository.origin, checkout]);
      yield* execute(checkout, ["git", "config", "user.name", name]);
      yield* execute(checkout, ["git", "config", "user.email", "cloner@example.com"]);
      // What jj prints goes nowhere, since no test reads it.
      const clientsInClone = (directory: string) =>
        clientsIn(directory, env, () => Effect.void).pipe(Effect.provide(services));
      const service = GitClone.of({
        clientsIn: clientsInClone,
        git: (...args) => execute(checkout, ["git", ...args]),
        jj: (...args) => execute(checkout, ["jj", ...args]),
        jjConfigFile: configFile,
      });
      const clients = yield* clientsInClone(checkout);
      return Context.add(clients, GitClone, service);
    }),
  );

/**
 * The scratch repository, a clone of its `origin` with git's identity under `name`, and the git,
 * jj and pull request description clients in the clone. The directories are removed when the
 * layer's scope closes.
 */
export const gitClone = (
  name = "Cloner",
): Layer.Layer<GitClone | RepositoryClients | ScratchRepository, never, ScratchServices> =>
  clone(name).pipe(Layer.provideMerge(scratchRepositoryWithoutClients));

/**
 * Adds a git worktree of the clone, with a detached `HEAD`. Returns its directory, which is removed
 * when the test's scope closes.
 */
export const addWorktree: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | GitClone | Path.Path | Scope.Scope
> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { git } = yield* GitClone;
  const directory = yield* scratchDirectory("worktree-");
  const worktree = path.join(directory, "checkout");
  yield* git("worktree", "add", "--detach", worktree);
  return worktree;
});
