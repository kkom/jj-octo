#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { CliConfig, CliOutput, Command, GlobalFlag, TerminalCapabilities } from "effect/cli";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

import manifest from "../package.json" with { type: "json" };
import { helpFormatter } from "./cli/command";
import { jjGhCommand } from "./cli/gh/command";
import { GitLive } from "./clients/git";
import { JjLive } from "./clients/jj";
import { prDescriptionsLayer } from "./clients/pr-descriptions";

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  SecureRandom.layerWebCrypto,
);

const services = Layer.mergeAll(
  GitLive,
  Layer.provideMerge(prDescriptionsLayer, JjLive),
  // No completions flag: its script completes a command of this name, but the shell hands
  // everything after `jj` to jj's completions.
  CliConfig.layer({
    builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Wizard, GlobalFlag.LogLevel],
  }),
  Layer.effect(CliOutput.Formatter)(
    Effect.map(TerminalCapabilities.TerminalCapabilities, ({ canColor }) =>
      helpFormatter(canColor),
    ),
  ),
).pipe(Layer.provideMerge(platform));

BunRuntime.runMain(
  Command.run(jjGhCommand, { version: manifest.version }).pipe(Effect.provide(services)),
);
