import { Array as EffectArray, Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { claudeCodeCloudSession, environmentString, WAYLAND_DISPLAY } from "../settings";

export class ClipboardFailed extends Schema.TaggedError<
  ClipboardFailed,
  { readonly brand: unique symbol }
>()("ClipboardFailed", { message: Schema.String }) {}

/** Formatted text, and its plain version for apps that take only plain text. */
export interface RichText {
  readonly html: string;
  readonly text: string;
}

/**
 * `unreachable` means nothing was copied: in a Claude Code cloud session, the user's clipboard is
 * on another device.
 */
export type ClipboardWrite = "copied" | "unreachable";

export class Clipboard extends Context.Service<
  Clipboard,
  { readonly write: (content: RichText) => Effect.Effect<ClipboardWrite, ClipboardFailed> }
>()("jj-octo/clients/clipboard") {}

// AppleScript's `set the clipboard` sets only plain text, so this sets both types through AppKit.
// osascript passes the trailing arguments to `run`, and exits non-zero if it throws.
export const MACOS_SCRIPT = `
ObjC.import("AppKit");
function run([html, text]) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (
    !pasteboard.setStringForType($(html), $.NSPasteboardTypeHTML) ||
    !pasteboard.setStringForType($(text), $.NSPasteboardTypeString)
  ) {
    throw new Error("the pasteboard didn't take the links");
  }
}`;

interface ClipboardOptions {
  readonly platform?: string;
}

interface ClipboardCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly input: "arguments" | "stdin";
}

/**
 * The first installed command runs. Linux commands take one type, so the clipboard gets only HTML.
 * Under Wayland without wl-copy, xclip works through XWayland.
 */
const commandsFor = (
  { html, text }: RichText,
  platform: string,
  wayland: string,
): readonly ClipboardCommand[] => {
  if (platform === "darwin") {
    return [
      {
        args: ["-l", "JavaScript", "-e", MACOS_SCRIPT, html, text],
        input: "arguments",
        name: "osascript",
      },
    ];
  }
  if (platform !== "linux") {
    return [];
  }
  const xclip: ClipboardCommand = {
    args: ["-selection", "clipboard", "-t", "text/html"],
    input: "stdin",
    name: "xclip",
  };
  return wayland === ""
    ? [xclip]
    : [{ args: ["--type", "text/html"], input: "stdin", name: "wl-copy" }, xclip];
};

/**
 * A command reading stdin leaves a process holding the clipboard. It would die with a detached
 * process group, and would block a caller reading inherited stdout and stderr, so its output is
 * dropped.
 */
const childProcess = (
  { args, input }: ClipboardCommand,
  executable: string,
  html: string,
): ChildProcess.Command =>
  ChildProcess.make(executable, args, {
    detached: false,
    stdout: "ignore",
    ...(input === "stdin"
      ? { stderr: "ignore", stdin: Stream.make(html).pipe(Stream.encodeText) }
      : { stderr: "inherit", stdin: "ignore" }),
  });

export const clipboardLayer = ({ platform = process.platform }: ClipboardOptions = {}): Layer.Layer<
  Clipboard,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    Clipboard,
    Effect.gen(function* () {
      const path = yield* environmentString("PATH");
      const wayland = yield* environmentString(WAYLAND_DISPLAY.name);
      if (yield* claudeCodeCloudSession) {
        return Clipboard.of({ write: () => Effect.succeed("unreachable" as const) });
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Clipboard.of({
        write: (content) => {
          const commands = commandsFor(content, platform, wayland);
          if (commands.length === 0) {
            return Effect.fail(
              ClipboardFailed.make({
                message: `copying to the clipboard needs macOS or Linux, not ${platform}`,
              }),
            );
          }
          const [installed] = EffectArray.flatMap(commands, (command) => {
            const executable = Bun.which(command.name, { PATH: path });
            return executable === null ? [] : [{ command, executable }];
          });
          if (installed === undefined) {
            const names = EffectArray.join(
              EffectArray.map(commands, ({ name }) => name),
              " or ",
            );
            return Effect.fail(ClipboardFailed.make({ message: `couldn't find ${names}` }));
          }
          const { command, executable } = installed;
          const { name } = command;
          return spawner.exitCode(childProcess(command, executable, content.html)).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(ClipboardFailed.make({ message: `${name} failed: ${error.message}` })),
            ),
            Effect.flatMap((code) =>
              code === 0
                ? Effect.succeed("copied" as const)
                : Effect.fail(ClipboardFailed.make({ message: `${name} exited with ${code}` })),
            ),
          );
        },
      });
    }),
  );

export const ClipboardLive = clipboardLayer();
