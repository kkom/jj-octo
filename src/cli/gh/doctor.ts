import { Array as EffectArray, Console, Effect, type FileSystem } from "effect";
import { Command } from "effect/cli";

import type { Git } from "../../clients/git";
import type { Jj } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { NotSetUp, type SetupStep, advice, runSteps } from "./setup";

const find = ({ check }: SetupStep) =>
  check.pipe(
    Effect.map((problem) => (problem === undefined ? undefined : advice(problem))),
    Effect.catch((error) => Effect.succeed(`could not check: ${error.message}`)),
  );

export const problems: Effect.Effect<readonly string[], never, FileSystem.FileSystem | Git | Jj> =
  Effect.map(runSteps(find), ({ problems: found }) => found);

export const doctor: Effect.Effect<void, NotSetUp, FileSystem.FileSystem | Git | Jj> = Effect.gen(
  function* () {
    const found = yield* problems;
    if (found.length > 0) {
      return yield* NotSetUp.make({ message: EffectArray.join(found, "\n") });
    }
    yield* Console.error("set up for jj-octo");
  },
);

export const doctorCommand = Command.make("doctor", {}, () => asUserError(doctor)).pipe(
  withHelp(
    "Check that a checkout is set up for the other commands",
    "Checks everything `init` sets up or requires, changing nothing. Fails with each problem and its fix.",
  ),
);
