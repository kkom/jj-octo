import {
  Array as EffectArray,
  Context,
  Effect,
  type FileSystem,
  Layer,
  Option,
  String as EffectString,
} from "effect";
import { CliError, CliOutput, Command, Flag } from "effect/cli";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import type { Git } from "../clients/git";
import type { GitHub } from "../clients/github/client";
import { gitHubLayerFromOrigin } from "../clients/github/origin";
import type { Jj } from "../clients/jj";

const userError = (message: string): CliError.UserError =>
  CliError.UserError.make({ cause: message, userMessage: message });

// Shows each failure as a message, not a stack trace, since a person can act on it.
export const asUserError = <A, R>(
  program: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>,
): Effect.Effect<A, CliError.UserError, R> =>
  program.pipe(Effect.mapError(({ message }) => userError(message)));

// Builds `origin`'s GitHub client only for the commands that use GitHub.
export const provideGitHubFromOrigin = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
): Command.Command<
  Name,
  Input,
  ContextInput,
  E | CliError.UserError,
  | Exclude<R, GitHub>
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Git
  | HttpClient.HttpClient
  | Jj
> => command.pipe(Command.provide(Layer.unwrap(asUserError(gitHubLayerFromOrigin))));

// A parent command lists the summary. The command's own help shows it above the paragraphs,
// indented here since the help formatter indents only the first line.
export const withHelp =
  (summary: string, ...paragraphs: readonly string[]) =>
  <Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> =>
    command.pipe(
      Command.withShortDescription(summary),
      Command.withDescription(EffectArray.join([summary, ...paragraphs], "\n\n  ")),
    );

export interface HelpSection {
  /** The help indents each line. */
  readonly lines: readonly string[];
  readonly title: string;
}

export class HelpSections extends Context.Service<HelpSections, readonly HelpSection[]>()(
  "jj-octo/cli/command/HelpSections",
) {}

/** Adds sections to the command's help, after Effect's generated ones. */
export const withSections =
  (...sections: readonly HelpSection[]) =>
  <Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> =>
    Command.annotate(command, HelpSections, sections);

/** Rows of cells, each column `gap` spaces past the previous column's widest cell. */
export const table = (rows: readonly (readonly string[])[], gap: number): readonly string[] => {
  const width = (column: number): number =>
    Math.max(0, ...EffectArray.map(rows, (row) => CliOutput.displayWidth(row[column] ?? "")));
  return EffectArray.map(rows, (row) =>
    EffectString.trimEnd(
      EffectArray.join(
        EffectArray.map(
          row,
          (cell, column) =>
            `${cell}${EffectString.repeat(width(column) - CliOutput.displayWidth(cell))(" ")}`,
        ),
        EffectString.repeat(gap)(" "),
      ),
    ),
  );
};

/** Effect's help formatter, also showing each command's `HelpSections`. */
export const helpFormatter = (colors: boolean): CliOutput.Formatter => {
  const base = CliOutput.defaultFormatter({ colors });
  const bold = (text: string) => (colors ? `\u001B[1m${text}\u001B[0m` : text);
  return {
    formatCliError: base.formatCliError,
    formatError: base.formatError,
    formatErrors: base.formatErrors,
    formatHelpDoc: (doc) => {
      const sections = Option.getOrElse(Context.getOption(doc.annotations, HelpSections), () => []);
      return EffectArray.join(
        [
          base.formatHelpDoc(doc),
          ...EffectArray.map(sections, ({ lines, title }) =>
            EffectArray.join(
              [bold(title), ...EffectArray.map(lines, (line) => (line === "" ? "" : `  ${line}`))],
              "\n",
            ),
          ),
        ],
        "\n\n",
      );
    },
    formatVersion: base.formatVersion,
  };
};

export const revisionFlag = (description: string): Flag.Flag<string> =>
  Flag.String("revision").pipe(
    Flag.withAlias("r"),
    Flag.withDefault("@"),
    Flag.withDescription(`${description}, the working copy by default`),
  );
