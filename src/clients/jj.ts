import {
  Array as EffectArray,
  Context,
  Data,
  Effect,
  Layer,
  Schema,
  Stream,
  String as EffectString,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { formatJson } from "../json";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class JjFailed extends Data.TaggedError("JjFailed")<{ readonly message: string }> {}

export class Jj extends Context.Service<
  Jj,
  {
    /** Runs a jj command that reads the repository, and returns what it printed. */
    readonly read: (args: readonly string[]) => Effect.Effect<string, JjFailed>;
    /** Runs a jj command that changes something, showing its output as it goes. */
    readonly run: (args: readonly string[]) => Effect.Effect<void, JjFailed>;
    /**
     * Runs a jj command that changes something as a dry run: jj makes the operation, and doesn't
     * add it to the operation log. So the bookmarks, the git branches and the working copy stay as
     * they are. The commits it makes stay in the repository, unreferenced, until jj collects them.
     * Returns the operation's id, which `--at-operation` reads the result at. Fails where the
     * command changed nothing.
     */
    readonly dryRun: (args: readonly string[]) => Effect.Effect<string, JjFailed>;
  }
>()("jj-octo/clients/jj") {}

// What jj printed says what went wrong, so it's the message. The command is named only where jj
// printed nothing to this program: it failed to start, or its output went to the terminal.
const failed = (args: readonly string[], detail: string): JjFailed =>
  new JjFailed({
    message:
      EffectString.trim(detail) === ""
        ? `jj ${EffectArray.join(args, " ")} failed`
        : EffectString.replace(/^Error: /u, "")(EffectString.trim(detail)),
  });

// `ui.quiet` in the user's config would keep jj from printing the operation's id.
const DRY_RUN = ["--no-integrate-operation", "--config", "ui.quiet=false"];

// What jj prints after each operation that a command run with `--no-integrate-operation` makes.
// The command's own operation is the last one: before it, jj makes one where it snapshots the
// working copy, and one where it imports a git `HEAD` that moved.
const NOT_INTEGRATED =
  /left uncommitted because --no-integrate-operation was requested: (?<operation>[0-9a-f]+)/gu;

interface JjOptions {
  readonly cwd?: string;
  /** Added to the environment jj inherits. */
  readonly env?: Readonly<Record<string, string>>;
  /** Receives what `run` commands print, which otherwise goes to the terminal. */
  readonly printed?: (text: string) => void;
}

export const jjLayer = ({ cwd, env, printed }: JjOptions = {}): Layer.Layer<
  Jj,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    Jj,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const location = { cwd, env, extendEnv: true };

      // What jj printed to stdout and to stderr, and its exit code.
      const captured = (args: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("jj", args, location));
            return yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
          }),
        ).pipe(
          Effect.catchTag("PlatformError", (error) => Effect.fail(failed(args, error.message))),
        );

      const read = (args: readonly string[]): Effect.Effect<string, JjFailed> =>
        Effect.flatMap(captured(args), ([stdout, stderr, code]) =>
          code === 0 ? Effect.succeed(stdout) : Effect.fail(failed(args, stderr)),
        );

      const run = (args: readonly string[]): Effect.Effect<void, JjFailed> =>
        printed === undefined
          ? spawner
              .exitCode(
                ChildProcess.make("jj", args, {
                  ...location,
                  stderr: "inherit",
                  stdout: "inherit",
                }),
              )
              .pipe(
                Effect.catchTag("PlatformError", (error) =>
                  Effect.fail(failed(args, error.message)),
                ),
                Effect.flatMap((code) =>
                  code === 0 ? Effect.void : Effect.fail(failed(args, "")),
                ),
              )
          : Effect.flatMap(captured(args), ([stdout, stderr, code]) => {
              printed(stdout + stderr);
              return code === 0 ? Effect.void : Effect.fail(failed(args, stderr));
            });

      const dryRun = (args: readonly string[]): Effect.Effect<string, JjFailed> =>
        Effect.flatMap(captured([...DRY_RUN, ...args]), ([, stderr, code]) => {
          if (code !== 0) {
            return Effect.fail(failed(args, stderr));
          }
          const operation = [...EffectString.matchAll(NOT_INTEGRATED)(stderr)].at(-1)?.groups?.[
            "operation"
          ];
          return operation === undefined
            ? Effect.fail(failed(args, `jj ${EffectArray.join(args, " ")} made no operation`))
            : Effect.succeed(operation);
        });

      return { dryRun, read, run };
    }),
  );

export const JjLive = jjLayer();

const ENTRY = String.raw`json(name) ++ " " ++ json(value) ++ "\n"`;

/**
 * A key's value in jj's config, or `undefined` where it has none. `jj config list` prints nothing
 * for a key without a value, where `jj config get` fails. `repo` reads the repository's config
 * alone, which the user's config doesn't shadow.
 */
export const readJjConfig = (
  key: string,
  { repo = false }: { readonly repo?: boolean } = {},
): Effect.Effect<unknown, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const scope = repo ? ["--repo"] : [];
    const output = yield* jj.read(["config", "list", ...scope, key, "-T", ENTRY]);
    const lines = EffectArray.filter(EffectString.split(output, "\n"), (line) => line !== "");
    // For a table, jj lists the keys inside it.
    const prefix = `${formatJson(key)} `;
    if (EffectArray.some(lines, (line) => !EffectString.startsWith(prefix)(line))) {
      return yield* new JjFailed({ message: `${key} is a table; set it to a single value` });
    }
    const [line] = lines;
    // Jj writes each value as JSON, so one it doesn't is a defect
    return line === undefined
      ? undefined
      : yield* Effect.orDie(decodeJson(EffectString.slice(prefix.length)(line)));
  });

/** A string in jj's config, or an empty string where it has none. Fails on any other value. */
export const jjConfig = (key: string): Effect.Effect<string, JjFailed, Jj> =>
  Effect.gen(function* () {
    const value = yield* readJjConfig(key);
    if (value === undefined || typeof value === "string") {
      return value ?? "";
    }
    return yield* new JjFailed({
      message: `${key} is ${formatJson(value)}; set it to a string`,
    });
  });

/**
 * Sets a value in the repository's jj config. Jj parses the value as TOML, so a string or an array
 * goes in as JSON writes it, which is also TOML.
 */
export const setJjConfig = (
  key: string,
  value: string | readonly string[],
): Effect.Effect<void, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    yield* jj.run(["config", "set", "--repo", key, formatJson(value)]);
  });
