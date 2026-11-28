import { describe, expect } from "bun:test";

import {
  Array as EffectArray,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  String as EffectString,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { withEnvironment } from "../testing/environment";
import { itEffect } from "../testing/it-effect";
import { scratchDirectory } from "../testing/scratch-process";
import { Clipboard, ClipboardFailed, clipboardLayer, MACOS_SCRIPT } from "./clipboard";
import { readOutput } from "./process";

const content = {
  html: '<a href="https://example.com">#1 Add a</a>',
  text: "[#1 Add a](https://example.com)",
};

// Builds the clipboard for the platform in an environment holding `env`, and writes the content.
const writeWith = (platform: string, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const built = yield* Layer.build(clipboardLayer({ platform })).pipe(withEnvironment(env));
    return yield* Context.get(built, Clipboard).write(content);
  });

/**
 * A directory with a stand-in for the command. It records its arguments and stdin, and leaves a
 * process behind to hold the clipboard, as xclip and wl-copy do.
 */
const standIn = (command: string, exitCode = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* scratchDirectory("clipboard-");
    const script = path.join(directory, command);
    yield* Effect.orDie(
      fs.writeFileString(
        script,
        EffectArray.join(
          [
            "#!/bin/sh",
            `printf '%s\\n' "$@" > "${directory}/args"`,
            `cat > "${directory}/stdin"`,
            "sleep 30 &",
            `echo $! > "${directory}/held"`,
            `exit ${exitCode}`,
          ],
          "\n",
        ),
      ),
    );
    yield* Effect.orDie(fs.chmod(script, 0o755));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const read = (file: string) => Effect.orDie(fs.readFileString(path.join(directory, file)));
    const run = (file: string, args: readonly string[]) =>
      Effect.scoped(Effect.flatMap(spawner.spawn(ChildProcess.make(file, args)), readOutput));
    // The process the stand-in left behind, ended when the test's scope closes.
    const held = Effect.orDie(fs.exists(path.join(directory, "held"))).pipe(
      Effect.flatMap((exists) =>
        exists ? read("held").pipe(Effect.map(EffectString.trim)) : Effect.succeed(""),
      ),
    );
    yield* Effect.addFinalizer(() =>
      held.pipe(
        Effect.flatMap((pid) => (pid === "" ? Effect.void : run("kill", [pid]))),
        Effect.ignore,
      ),
    );
    return {
      PATH: directory,
      recorded: Effect.gen(function* () {
        const pid = yield* held;
        // A killed process can stay as a zombie, which `ps` shows with the state Z. `ps` exits 1
        // for a process that's gone, with nothing printed.
        const { stdout } = yield* Effect.orDie(run("ps", ["-o", "stat=", "-p", pid]));
        const state = EffectString.trim(stdout);
        const alive = state !== "" && !EffectString.startsWith("Z")(state);
        return { alive, args: yield* read("args"), stdin: yield* read("stdin") };
      }),
    };
  });

describe("clipboardLayer", () => {
  itEffect("sets the HTML and the text with osascript on macOS", () =>
    Effect.gen(function* () {
      const osascript = yield* standIn("osascript");
      const reported = yield* writeWith("darwin", { PATH: osascript.PATH });
      const recorded = yield* osascript.recorded;
      expect({ recorded, reported }).toStrictEqual({
        recorded: {
          alive: true,
          args: EffectArray.join(
            ["-l", "JavaScript", "-e", MACOS_SCRIPT, content.html, content.text, ""],
            "\n",
          ),
          stdin: "",
        },
        reported: "copied",
      });
    }),
  );

  itEffect("pipes the HTML to wl-copy under Wayland, leaving its process running", () =>
    Effect.gen(function* () {
      const wlCopy = yield* standIn("wl-copy");
      const reported = yield* writeWith("linux", {
        PATH: wlCopy.PATH,
        WAYLAND_DISPLAY: "wayland-0",
      });
      const recorded = yield* wlCopy.recorded;
      expect({ recorded, reported }).toStrictEqual({
        recorded: {
          alive: true,
          args: "--type\ntext/html\n",
          stdin: content.html,
        },
        reported: "copied",
      });
    }),
  );

  itEffect("pipes the HTML to xclip under X, leaving its process running", () =>
    Effect.gen(function* () {
      const xclip = yield* standIn("xclip");
      const reported = yield* writeWith("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "" });
      const recorded = yield* xclip.recorded;
      expect({ recorded, reported }).toStrictEqual({
        recorded: {
          alive: true,
          args: "-selection\nclipboard\n-t\ntext/html\n",
          stdin: content.html,
        },
        reported: "copied",
      });
    }),
  );

  itEffect("falls back to xclip under Wayland where wl-copy isn't installed", () =>
    Effect.gen(function* () {
      const xclip = yield* standIn("xclip");
      const reported = yield* writeWith("linux", {
        PATH: xclip.PATH,
        WAYLAND_DISPLAY: "wayland-0",
      });
      const recorded = yield* xclip.recorded;
      expect({ recorded, reported }).toStrictEqual({
        recorded: {
          alive: true,
          args: "-selection\nclipboard\n-t\ntext/html\n",
          stdin: content.html,
        },
        reported: "copied",
      });
    }),
  );

  // There's no command for win32, so reporting rather than failing shows that nothing ran.
  itEffect("runs no command in a Claude Code cloud session, which can't reach the clipboard", () =>
    Effect.gen(function* () {
      const reported = yield* writeWith("win32", { CLAUDE_CODE_REMOTE: "true" });
      expect(reported).toBe("unreachable");
    }),
  );

  itEffect("fails naming the command where it exits non-zero", () =>
    Effect.gen(function* () {
      const xclip = yield* standIn("xclip", 1);
      const failure = yield* Effect.flip(
        writeWith("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "" }),
      );
      yield* xclip.recorded;
      expect(failure).toStrictEqual(ClipboardFailed.make({ message: "xclip exited with 1" }));
    }),
  );

  itEffect("fails naming the command where it isn't installed", () =>
    Effect.gen(function* () {
      const empty = yield* scratchDirectory("clipboard-");
      const failure = yield* Effect.flip(writeWith("linux", { PATH: empty, WAYLAND_DISPLAY: "" }));
      expect(failure).toStrictEqual(
        ClipboardFailed.make({
          message: "couldn't find xclip",
        }),
      );
    }),
  );

  itEffect("fails on a platform it has no command for", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(writeWith("win32"));
      expect(failure).toStrictEqual(
        ClipboardFailed.make({
          message: "copying to the clipboard needs macOS or Linux, not win32",
        }),
      );
    }),
  );
});
