import { Array as EffectArray } from "effect";
import { Command } from "effect/cli";

import { ENVIRONMENT_VARIABLES, GITHUB_AUTH, SETTINGS } from "../../settings";
import { asUserError, type HelpSection, table, withHelp, withSections } from "../command";
import { checksCommand } from "./checks";
import { dissolveCommand } from "./dissolve";
import { doctorCommand } from "./doctor";
import { initCommand, setUpOnUpgrade } from "./init";
import { linksCommand } from "./links";
import { logCommand } from "./log";
import { mergeCommand } from "./merge";
import { publishCommand } from "./publish";
import { submitCommand } from "./submit";
import { syncCommand } from "./sync";

// Runs before the handler's layers, which need the jj repository `init` may make.
const setUpFirst = <const Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
) => Command.provideEffectDiscard(command, asUserError(setUpOnUpgrade));

const settingsSection: HelpSection = {
  lines: [
    "jj config keys. Set one with `jj config set --repo <key> <value>` for this repository, or with `--user` in place of `--repo` for every repository.",
    ...EffectArray.flatMap(SETTINGS, (setting) => [
      "",
      setting.key,
      `  ${setting.description}`,
      ...EffectArray.map(
        table(
          EffectArray.map(setting.choices, ({ description, value }) => [
            String(value),
            description,
          ]),
          3,
        ),
        (row) => `  ${row}`,
      ),
      `  Default: ${setting.default.description}`,
    ]),
  ],
  title: "SETTINGS",
};

const environmentSection: HelpSection = {
  lines: table(
    EffectArray.map(ENVIRONMENT_VARIABLES, ({ description, name }) => [name, description]),
    3,
  ),
  title: "ENVIRONMENT",
};

export const jjGhCommand = Command.make("jj gh").pipe(
  // `doctor` only reports the setup, and `init` performs it.
  Command.withSubcommands([
    checksCommand.pipe(setUpFirst),
    dissolveCommand.pipe(setUpFirst),
    doctorCommand,
    initCommand,
    linksCommand.pipe(setUpFirst),
    logCommand.pipe(setUpFirst),
    mergeCommand.pipe(setUpFirst),
    publishCommand.pipe(setUpFirst),
    submitCommand.pipe(setUpFirst),
    syncCommand.pipe(setUpFirst),
  ]),
  withHelp(
    "Commands for publishing jj changes as GitHub pull requests",
    "A stack is a chain of changes. Each change becomes a pull request on its bookmark's branch, based on the branch of the change below, so it shows only that change's diff. A single change gets an ordinary pull request, outside any GitHub stack.",
    "A change's stack is every change connected to it through mutable changes, except an empty, undescribed working copy. It must be a chain: no merges, and one bookmark per change. `submit`, `publish` and `merge` act on a change and those below it, which must have no conflicts. An empty working copy means the change below it.",
    `jj-octo acts on \`origin\`'s repository through GitHub's REST API, since a Claude Code cloud session's GitHub proxy rejects GraphQL. Only marking a draft ready uses GraphQL (see \`jj gh publish --help\`). In an Anthropic-hosted session, the default settings work. On a self-hosted runner sending git through the Anthropic git proxy, set \`${GITHUB_AUTH.key}\` to \`git-proxy\`.`,
  ),
  withSections(settingsSection, environmentSection),
);
