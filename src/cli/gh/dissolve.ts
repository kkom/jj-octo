import { Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import { type StackNumber, StackNumberSchema } from "../../clients/github/types";
import { asUserError, provideGitHubFromOrigin, withHelp } from "../command";

export class NoSuchStack extends Schema.TaggedError<
  NoSuchStack,
  { readonly brand: unique symbol }
>()("NoSuchStack", { message: Schema.String }) {}

export const dissolve = (
  stack: StackNumber,
): Effect.Effect<void, GitHubFailed | NoSuchStack, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    yield* github.unstack(stack).pipe(
      Effect.catchIf(
        (failure) => failure.status === 404,
        () => NoSuchStack.make({ message: `this repository has no stack #${stack}` }),
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
  ({ stack }) => asUserError(dissolve(StackNumberSchema.make(stack))),
).pipe(
  provideGitHubFromOrigin,
  withHelp(
    "Dissolve a GitHub stack, leaving its pull requests open",
    "Each pull request keeps its base.",
    "Where a jj stack's pull requests are in several GitHub stacks, `submit` fails and names this command for the ones to dissolve. Check a stack's contents on GitHub before dissolving it.",
  ),
);
