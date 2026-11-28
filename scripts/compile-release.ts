// Compiles a standalone jj-octo for each release platform into `dist/release`, each as a tarball of
// one `jj-octo` executable, which installers like mise expect.
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Array as EffectArray,
  Effect,
  FileSystem,
  pipe,
  Schema,
  String as EffectString,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class CompileFailed extends Schema.TaggedError<CompileFailed, { readonly brand: unique symbol }>()(
  "CompileFailed",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

// The x64 build is Bun's baseline, which runs without AVX2.
const targets: readonly Bun.Build.CompileTarget[] = [
  "bun-darwin-arm64",
  "bun-linux-arm64",
  "bun-linux-x64-baseline",
];

const compile = (target: Bun.Build.CompileTarget) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = pipe(
      target,
      EffectString.replace(/^bun-/u, ""),
      EffectString.replace(/-baseline$/u, ""),
    );
    const directory = `dist/compile/${platform}`;
    const built = yield* Effect.tryPromise({
      catch: (cause) => CompileFailed.make({ cause, message: `compiling for ${target} failed` }),
      try: () =>
        Bun.build({
          // Jj-octo runs in other checkouts, whose `.env` and `bunfig.toml` aren't its own.
          compile: {
            autoloadBunfig: false,
            autoloadDotenv: false,
            outfile: `${directory}/jj-octo`,
            target,
          },
          entrypoints: ["src/main.ts"],
          throw: false,
        }),
    });
    if (!built.success) {
      return yield* CompileFailed.make({
        message: `compiling for ${target} failed:\n${EffectArray.join(EffectArray.map(built.logs, String), "\n")}`,
      });
    }
    const archive = `dist/release/jj-octo-${platform}.tar.gz`;
    // Tar prints to this process's stderr, so a failure says why.
    const code = yield* spawner.exitCode(
      ChildProcess.make(
        "tar",
        ["--create", "--gzip", "--file", archive, "--directory", directory, "jj-octo"],
        { stderr: "inherit" },
      ),
    );
    if (code !== 0) {
      return yield* CompileFailed.make({ message: `tar exited ${code} writing ${archive}` });
    }
  });

const compileRelease = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    ["dist/compile", "dist/release"],
    (directory) => fs.remove(directory, { force: true, recursive: true }),
    { concurrency: "unbounded", discard: true },
  );
  yield* fs.makeDirectory("dist/release", { recursive: true });
  // One at a time, as each build downloads its runtime into Bun's shared cache.
  yield* Effect.forEach(targets, compile, { concurrency: 1, discard: true });
});

BunRuntime.runMain(compileRelease.pipe(Effect.provide(BunServices.layer)));
