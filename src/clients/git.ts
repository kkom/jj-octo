import {
  Array as EffectArray,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Record as EffectRecord,
  Schema,
  String as EffectString,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readOutput } from "./process";

export class GitFailed extends Schema.TaggedError<GitFailed, { readonly brand: unique symbol }>()(
  "GitFailed",
  {
    /** Git's exit code, if git ran and failed. */
    exitCode: Schema.optionalKey(Schema.Finite),
    message: Schema.String,
  },
) {}

export class Git extends Context.Service<
  Git,
  {
    /** Runs a read-only command and returns its stdout. */
    readonly read: (args: readonly string[]) => Effect.Effect<string, GitFailed>;
    /**
     * Merges two edits of a text by line. Where both changed the same lines, conflict markers
     * labelled `local` and `GitHub` surround the two versions.
     */
    readonly mergeText: (texts: {
      readonly base: string;
      readonly local: string;
      readonly remote: string;
    }) => Effect.Effect<{ readonly conflicted: boolean; readonly text: string }, GitFailed>;
  }
>()("jj-octo/clients/git") {}

interface GitOptions {
  readonly cwd?: string;
  /** Added to the environment git inherits. */
  readonly env?: Readonly<Record<string, string>>;
}

export const gitLayer = ({ cwd, env }: GitOptions = {}): Layer.Layer<
  Git,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return {
        mergeText: ({ base, local, remote }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fs.makeTempDirectoryScoped();
              // `git merge-file` treats a last line without a newline as changed.
              const written = { base: `${base}\n`, github: `${remote}\n`, local: `${local}\n` };
              yield* Effect.forEach(
                EffectRecord.toEntries(written),
                ([name, text]) => fs.writeFileString(path.join(directory, name), text),
                { concurrency: "unbounded" },
              );
              const handle = yield* spawner.spawn(
                ChildProcess.make(
                  "git",
                  [
                    "merge-file",
                    "-p",
                    "-L",
                    "local",
                    "-L",
                    "base",
                    "-L",
                    "GitHub",
                    "local",
                    "base",
                    "github",
                  ],
                  { cwd: directory },
                ),
              );
              const { exitCode, stderr, stdout } = yield* readOutput(handle);
              // The exit code is the conflict count, or 255 on failure.
              if (exitCode > 127) {
                return yield* GitFailed.make({
                  message: `git merge-file failed: ${EffectString.trim(stderr)}`,
                });
              }
              return { conflicted: exitCode > 0, text: EffectString.trimEnd(stdout) };
            }),
          ).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(GitFailed.make({ message: `git merge-file failed: ${error.message}` })),
            ),
          ),
        read: (args) =>
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make("git", args, { cwd, env, extendEnv: true }),
              );
              const { exitCode, stderr, stdout } = yield* readOutput(handle);
              return exitCode === 0
                ? stdout
                : yield* GitFailed.make({
                    exitCode,
                    message: `git ${EffectArray.join(args, " ")} failed${EffectString.trim(stderr) === "" ? "" : `: ${EffectString.trim(stderr)}`}`,
                  });
            }),
          ).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(
                GitFailed.make({
                  message: `git ${EffectArray.join(args, " ")} failed: ${error.message}`,
                }),
              ),
            ),
          ),
      };
    }),
  );

export const GitLive = gitLayer();

export const gitConfig = (args: readonly string[]): Effect.Effect<string, GitFailed, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const value = yield* git.read(["config", ...args]).pipe(
      // Git exits 1 for an unset key, and 128 for an unparseable config file.
      Effect.catchIf(
        (error) => error.exitCode === 1,
        () => Effect.succeed(""),
      ),
    );
    return EffectString.trim(value);
  });

/** Absolute paths. In a git worktree, `gitDirectory` and `commonDirectory` differ. */
export const gitDirectories: Effect.Effect<
  { readonly commonDirectory: string; readonly gitDirectory: string; readonly topLevel: string },
  GitFailed,
  Git
> = Effect.gen(function* () {
  const git = yield* Git;
  const printed = yield* git.read([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [topLevel, gitDirectory = "", commonDirectory = ""] = EffectString.split(printed, "\n");
  return { commonDirectory, gitDirectory, topLevel };
});
