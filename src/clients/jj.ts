import {
  Array as EffectArray,
  Context,
  Effect,
  Layer,
  Schema,
  String as EffectString,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { formatJson } from "../json";
import { readOutput } from "./process";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class JjFailed extends Schema.TaggedError<JjFailed, { readonly brand: unique symbol }>()(
  "JjFailed",
  { message: Schema.String },
) {}

export class Jj extends Context.Service<
  Jj,
  {
    /** Runs a read-only command and returns its stdout. */
    readonly read: (args: readonly string[]) => Effect.Effect<string, JjFailed>;
    /** Runs a command that changes something, streaming its output. */
    readonly run: (args: readonly string[]) => Effect.Effect<void, JjFailed>;
    /**
     * Runs a jj command without adding its operation to the operation log, so bookmarks, git
     * branches and the working copy don't change. Returns the operation's id, for `--at-operation`.
     * Its commits stay, unreferenced, until jj collects them. Fails if the command changed nothing.
     */
    readonly dryRun: (args: readonly string[]) => Effect.Effect<string, JjFailed>;
  }
>()("jj-octo/clients/jj") {}

// Jj's output is the message. The command is named only where there is no output: jj failed to
// start, or printed to the terminal.
const failed = (args: readonly string[], detail: string): JjFailed =>
  JjFailed.make({
    message:
      EffectString.trim(detail) === ""
        ? `jj ${EffectArray.join(args, " ")} failed`
        : EffectString.replace(/^Error: /u, "")(EffectString.trim(detail)),
  });

// The user's `ui.quiet` would hide the operation's id.
const DRY_RUN = ["--no-integrate-operation", "--config", "ui.quiet=false"];

// Jj prints this after each operation. The command's own comes last, after any working-copy
// snapshot or import of a moved git `HEAD`.
const NOT_INTEGRATED =
  /left uncommitted because --no-integrate-operation was requested: (?<operation>[0-9a-f]+)/gu;

interface JjOptions {
  readonly cwd?: string;
  /** Added to the environment jj inherits. */
  readonly env?: Readonly<Record<string, string>>;
  /** Receives `run` output, which otherwise goes to the terminal. */
  readonly printed?: (text: string) => Effect.Effect<void>;
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

      const captured = (args: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("jj", args, location));
            return yield* readOutput(handle);
          }),
        ).pipe(
          Effect.catchTag("PlatformError", (error) => Effect.fail(failed(args, error.message))),
        );

      const read = (args: readonly string[]): Effect.Effect<string, JjFailed> =>
        Effect.flatMap(captured(args), ({ exitCode, stderr, stdout }) =>
          exitCode === 0 ? Effect.succeed(stdout) : Effect.fail(failed(args, stderr)),
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
          : Effect.flatMap(captured(args), ({ exitCode, stderr, stdout }) =>
              printed(stdout + stderr).pipe(
                Effect.andThen(exitCode === 0 ? Effect.void : Effect.fail(failed(args, stderr))),
              ),
            );

      const dryRun = (args: readonly string[]): Effect.Effect<string, JjFailed> =>
        Effect.flatMap(captured([...DRY_RUN, ...args]), ({ exitCode, stderr }) => {
          if (exitCode !== 0) {
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
 * A key's value, or `undefined` if unset (`jj config get` fails there). `repo` reads only the
 * repository's config, unshadowed by the user's.
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
    // For a table, jj lists its keys.
    const prefix = `${formatJson(key)} `;
    if (EffectArray.some(lines, (line) => !EffectString.startsWith(prefix)(line))) {
      return yield* JjFailed.make({ message: `${key} is a table; set it to a single value` });
    }
    const [line] = lines;
    // Jj writes each value as JSON, so other text is a defect.
    return line === undefined
      ? undefined
      : yield* Effect.orDie(decodeJson(EffectString.slice(prefix.length)(line)));
  });

/** A string key's value, or `""` if unset. Fails on any other value. */
export const jjConfig = (key: string): Effect.Effect<string, JjFailed, Jj> =>
  Effect.gen(function* () {
    const value = yield* readJjConfig(key);
    if (value === undefined || typeof value === "string") {
      return value ?? "";
    }
    return yield* JjFailed.make({
      message: `${key} is ${formatJson(value)}; set it to a string`,
    });
  });

// Sets the key in the repository's config. Jj parses the value as TOML, which a JSON string or
// array also is.
export const setJjConfig = (
  key: string,
  value: string | readonly string[],
): Effect.Effect<void, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    yield* jj.run(["config", "set", "--repo", key, formatJson(value)]);
  });
