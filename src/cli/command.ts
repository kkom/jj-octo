import { Array as EffectArray, Context, Effect, Option, String as EffectString } from "effect";
import { CliError, CliOutput, Command, Flag } from "effect/cli";

const userError = (message: string): CliError.UserError =>
  CliError.UserError.make({ cause: message, userMessage: message });

// Every failure the commands raise is one a person can act on, so each is shown as a message
// rather than a stack trace.
export const asUserError = <A, R>(
  program: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>,
): Effect.Effect<A, CliError.UserError, R> =>
  program.pipe(Effect.mapError(({ message }) => userError(message)));

// The summary is the line a parent command lists. The command's own help shows it above the
// paragraphs, which are indented here because the help formatter only indents the first line.
export const withHelp =
  (summary: string, ...paragraphs: readonly string[]) =>
  <Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> =>
    command.pipe(
      Command.withShortDescription(summary),
      Command.withDescription(EffectArray.join([summary, ...paragraphs], "\n\n  ")),
    );

/** A section that a command's help shows after the ones Effect generates. */
export interface HelpSection {
  /** Each line of the section, which the help indents. */
  readonly lines: readonly string[];
  readonly title: string;
}

export class HelpSections extends Context.Service<HelpSections, readonly HelpSection[]>()(
  "jj-octo/HelpSections",
) {}

/** Adds sections to the command's help, after the ones Effect generates. */
export const withSections =
  (...sections: readonly HelpSection[]) =>
  <Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> =>
    Command.annotate(command, HelpSections, sections);

/** Rows of cells, each column lined up `gap` spaces past the widest cell of the one before it. */
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

/** Effect's help formatter, which also shows each command's `HelpSections`. */
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

/** `-r`, as jj has it. The working copy is the default, as it is for jj's own commands. */
export const revisionFlag = (description: string): Flag.Flag<string> =>
  Flag.String("revision").pipe(
    Flag.withAlias("r"),
    Flag.withDefault("@"),
    Flag.withDescription(`${description}, the working copy by default`),
  );
