import { afterAll, describe, expect } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Array as EffectArray, Effect, Layer, String as EffectString } from "effect";

import { environment } from "../testing/environment";
import { itEffect } from "../testing/it-effect";
import { removeScratchRepositories, scratchDirectory } from "../testing/scratch-repository";
import { Clipboard, ClipboardFailed, clipboardLayer, MACOS_SCRIPT } from "./clipboard";

afterAll(removeScratchRepositories);

const content = {
  html: '<a href="https://example.com">#1 Add a</a>',
  text: "[#1 Add a](https://example.com)",
};

const writeWith = (layer: Layer.Layer<Clipboard>) =>
  Effect.flatMap(Clipboard, (clipboard) => clipboard.write(content)).pipe(Effect.provide(layer));

const layerFor = (platform: string, env: Readonly<Record<string, string>> = {}) =>
  clipboardLayer({ platform }).pipe(Layer.provide([BunServices.layer, environment(env)]));

/**
 * A directory holding a stand-in for the command, which records its arguments and stdin, and
 * leaves a process behind as xclip and wl-copy do to hold the clipboard.
 */
const standIn = (command: string, exitCode = 0) => {
  const directory = scratchDirectory("clipboard-");
  const script = path.join(directory, command);
  writeFileSync(
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
  );
  chmodSync(script, 0o755);
  const read = (file: string) => readFileSync(path.join(directory, file), "utf8");
  const held = () => Number(EffectString.trim(read("held")));
  return {
    PATH: directory,
    recorded: () => {
      // A killed process can stay as a zombie, which `ps` shows with the state Z.
      const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(held())]).stdout.toString();
      const alive = EffectString.trim(state) !== "" && !EffectString.startsWith("Z")(state);
      if (alive) {
        process.kill(held());
      }
      return { alive, args: read("args"), stdin: read("stdin") };
    },
  };
};

describe("clipboardLayer", () => {
  itEffect("sets the HTML and the text with osascript on macOS", () =>
    Effect.gen(function* () {
      const osascript = standIn("osascript");
      const reported = yield* writeWith(layerFor("darwin", { PATH: osascript.PATH }));
      expect({ recorded: osascript.recorded(), reported }).toStrictEqual({
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
      const wlCopy = standIn("wl-copy");
      const reported = yield* writeWith(
        layerFor("linux", { PATH: wlCopy.PATH, WAYLAND_DISPLAY: "wayland-0" }),
      );
      expect({ recorded: wlCopy.recorded(), reported }).toStrictEqual({
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
      const xclip = standIn("xclip");
      const reported = yield* writeWith(
        layerFor("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "" }),
      );
      expect({ recorded: xclip.recorded(), reported }).toStrictEqual({
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
      const xclip = standIn("xclip");
      const reported = yield* writeWith(
        layerFor("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "wayland-0" }),
      );
      expect({ recorded: xclip.recorded(), reported }).toStrictEqual({
        recorded: {
          alive: true,
          args: "-selection\nclipboard\n-t\ntext/html\n",
          stdin: content.html,
        },
        reported: "copied",
      });
    }),
  );

  // On a platform it has no command for, reporting rather than failing shows that nothing ran.
  itEffect("runs no command in a Claude Code cloud session, which can't reach the clipboard", () =>
    Effect.gen(function* () {
      const reported = yield* writeWith(layerFor("win32", { CLAUDE_CODE_REMOTE: "true" }));
      expect(reported).toBe("unreachable");
    }),
  );

  itEffect("fails naming the command where it exits non-zero", () =>
    Effect.gen(function* () {
      const xclip = standIn("xclip", 1);
      const failure = yield* layerFor("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "" }).pipe(
        writeWith,
        Effect.flip,
      );
      xclip.recorded();
      expect(failure).toStrictEqual(ClipboardFailed.make({ message: "xclip exited with 1" }));
    }),
  );

  itEffect("fails naming the command where it isn't installed", () =>
    Effect.gen(function* () {
      const empty = scratchDirectory("clipboard-");
      const failure = yield* layerFor("linux", { PATH: empty, WAYLAND_DISPLAY: "" }).pipe(
        writeWith,
        Effect.flip,
      );
      expect(failure).toStrictEqual(
        ClipboardFailed.make({
          message: "couldn't find xclip",
        }),
      );
    }),
  );

  itEffect("fails on a platform it has no command for", () =>
    Effect.gen(function* () {
      const failure = yield* layerFor("win32").pipe(writeWith, Effect.flip);
      expect(failure).toStrictEqual(
        ClipboardFailed.make({
          message:
            "copying to the clipboard needs macOS, or Linux with wl-copy or xclip, not win32",
        }),
      );
    }),
  );
});
