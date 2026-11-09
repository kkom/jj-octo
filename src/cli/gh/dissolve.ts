import { Console, Data, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import { GitHubFromOrigin } from "../../clients/github/origin";
import { type StackNumber, StackNumberSchema } from "../../clients/github/types";
import { asUserError, withHelp } from "../command";

export class NoSuchStack extends Data.TaggedError("NoSuchStack")<{
  readonly message: string;
}> {}

/** Dissolves a GitHub stack. Its pull requests stay open, each on the base it had. */
export const dissolve = (
  stack: StackNumber,
): Effect.Effect<void, GitHubFailed | NoSuchStack, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    yield* github.unstack(stack).pipe(
      Effect.catchIf(
        (failure) => failure.status === 404,
        () => new NoSuchStack({ message: `this repository has no stack #${stack}` }),
      ),
    );
    yield* Console.error(`dissolved stack #${stack}`);
  });

export const dissolveCommand = Command.make(
  "dissolve",
  {
    stack: Argument.Int("stack").pipe(
      Argument.filter(
        (stack) => stack > 0,
        (stack) => `${stack} isn't a stack number`,
      ),
      Argument.withDescription("The number of the GitHub stack to dissolve"),
    ),
  },
  ({ stack }) =>
    asUserError(dissolve(StackNumberSchema.make(stack)).pipe(Effect.provide(GitHubFromOrigin))),
).pipe(
  withHelp(
    "Dissolve a GitHub stack, leaving its pull requests open",
    "Each pull request keeps its base, so it still shows only its own change's diff.",
    "`submit` dissolves and registers again the one stack its pull requests are in, where a reorder, an insertion or a dropped change needs it. It changes only that one stack: where its pull requests belong to several, it won't take one out of another stack, and it fails and names this command for the stacks to dissolve. Check what a stack holds on GitHub before dissolving it.",
  ),
);
