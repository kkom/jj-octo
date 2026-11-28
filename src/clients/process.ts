import { Effect, Stream, type PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";

export const readOutput = (
  handle: ChildProcessSpawner.ChildProcessHandle,
): Effect.Effect<
  { readonly exitCode: number; readonly stderr: string; readonly stdout: string },
  PlatformError.PlatformError
> =>
  Effect.all(
    {
      exitCode: handle.exitCode,
      stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
      stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
    },
    { concurrency: "unbounded" },
  );
