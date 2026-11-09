import { Array as EffectArray, Console, Data, Effect, Match, Option } from "effect";

import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import type { PullRequestNumber, RemoteStack } from "../../../clients/github/types";
import { registrationFor } from "./plan";

export class SeveralStacks extends Data.TaggedError("SeveralStacks")<{
  readonly message: string;
}> {}

/**
 * The one GitHub stack containing any of the pull requests, bottom to top, if there is one. Submit
 * changes only that stack, so pull requests in several fail: taking one out of another stack would
 * dissolve a stack it doesn't own.
 */
export const stackContaining = (
  pullRequests: readonly PullRequestNumber[],
): Effect.Effect<Option.Option<RemoteStack>, GitHubFailed | SeveralStacks, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const found = yield* Effect.all(
      pullRequests.map((pullRequest) => github.stackOf(pullRequest)),
      { concurrency: "unbounded" },
    );
    const stacks = EffectArray.dedupeWith(
      found.flatMap((stack) => Option.toArray(stack)),
      (a, b) => a.number === b.number,
    );
    const [bottom, ...others] = stacks;
    if (bottom !== undefined && others.length > 0) {
      const listed = stacks.map(
        ({ number, unmerged }) => `#${number} (${unmerged.map((pr) => `#${pr}`).join(", ")})`,
      );
      return yield* new SeveralStacks({
        message: `the pull requests are in GitHub stacks ${listed.join(", ")}, and submit won't take a pull request out of another stack; to keep #${bottom.number}, which holds the bottom one, run ${others.map(({ number }) => `\`jj gh dissolve ${number}\``).join(" and ")}, then submit again`,
      });
    }
    return Option.fromNullishOr(stacks[0]);
  });

/** Makes the pull requests, bottom to top, the unmerged part of one GitHub stack. */
export const register = (
  remaining: Option.Option<RemoteStack>,
  pullRequests: readonly PullRequestNumber[],
): Effect.Effect<void, GitHubFailed, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    yield* Match.value(registrationFor(remaining, pullRequests)).pipe(
      Match.tag("Unchanged", () => Effect.void),
      Match.tag("Append", ({ pullRequests: added, stack }) =>
        github
          .addToStack(stack, added)
          .pipe(Effect.andThen(Console.error(`added ${added.join(", ")} to stack #${stack}`))),
      ),
      Match.tag("Create", ({ pullRequests: all }) =>
        github
          .createStack(all)
          .pipe(Effect.flatMap((stack) => Console.error(`registered stack #${stack}`))),
      ),
      Match.exhaustive,
    );
  });
