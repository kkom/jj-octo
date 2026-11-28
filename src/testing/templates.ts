import {
  Array as EffectArray,
  Clock,
  Config,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  String as EffectString,
} from "effect";
import { TestClock } from "effect/testing";

// Spotlight on macOS doesn't index a directory named `.noindex`, and each test writes and deletes
// a few hundred small files.
export const scratchParent: Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The process's own environment, not the one a test gives the code under test.
    const temporary = yield* Config.String("TMPDIR").pipe(
      Config.withDefault(""),
      Config.map((value) => (value === "" ? "/tmp" : value)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
      Effect.orDie,
    );
    const parent = path.join(temporary, "jj-octo-tests.noindex");
    yield* Effect.orDie(fs.makeDirectory(parent, { recursive: true }));
    return parent;
  });

// Running jj and git a dozen times per test is most of what the tests cost, so each kind of
// repository is built once per test process and copied. Each name holds its build's outcome, set
// before the build starts, so a second test that asks for it during the build waits for it.
const templates = new Map<string, Deferred.Deferred<string>>();

// The templates earlier runs left are removed once per process, before the first build.
let staleRemoved = false;

// A template that a run still copies is a few minutes old at most.
const STALE_AFTER_MS = 60 * 60 * 1000;

// Bun doesn't run a test process's exit handlers, so a run can't remove its own templates. The
// age compares file modification times, which the test clock can't fake, so it reads the real one.
const removeStaleTemplates = (
  parent: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* TestClock.withLive(Clock.currentTimeMillis);
    const entries = yield* fs.readDirectory(parent);
    yield* Effect.forEach(
      EffectArray.filter(entries, EffectString.startsWith("template-")),
      (name) =>
        Effect.gen(function* () {
          const template = path.join(parent, name);
          const modified = yield* fs.stat(template).pipe(
            Effect.map(({ mtime }) =>
              Option.match(mtime, { onNone: () => now, onSome: (time) => time.getTime() }),
            ),
            Effect.orElseSucceed(() => now),
          );
          if (now - modified > STALE_AFTER_MS) {
            yield* fs.remove(template, { force: true, recursive: true });
          }
        }),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.orDie);

/**
 * The directory that `build` filled for the name, built on first use. Before the first build,
 * removes the templates that earlier runs left. A build that fails or is interrupted leaves no
 * template behind, and the next test that asks builds it again.
 */
export const templateOf = <R>(
  name: string,
  build: (root: string) => Effect.Effect<void, never, R>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | R> =>
  Effect.suspend(() => {
    const known = templates.get(name);
    if (known !== undefined) {
      return Deferred.await(known);
    }
    const outcome = Deferred.makeUnsafe<string>();
    templates.set(name, outcome);
    const removeStale = staleRemoved;
    staleRemoved = true;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* scratchParent;
      if (!removeStale) {
        yield* removeStaleTemplates(parent);
      }
      const template = yield* Effect.orDie(
        fs.makeTempDirectory({ directory: parent, prefix: `template-${name}-` }),
      );
      yield* build(template).pipe(
        Effect.onError(() => Effect.ignore(fs.remove(template, { force: true, recursive: true }))),
      );
      return template;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Deferred.succeed(outcome, exit.value)
          : Effect.sync(() => {
              templates.delete(name);
            }).pipe(Effect.andThen(Deferred.failCause(outcome, exit.cause))),
      ),
    );
  });
