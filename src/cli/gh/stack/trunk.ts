import { Effect, Schema } from "effect";

import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import type { Jj, JjFailed } from "../../../clients/jj";
import { formatJson } from "../../../json";
import { commitsAt } from "./changes";

export class TrunkMismatch extends Schema.TaggedError<
  TrunkMismatch,
  { readonly brand: unique symbol }
>()("TrunkMismatch", { message: Schema.String }) {}

// Quoted so any branch name parses.
export const trunkRevset = (branch: string): string => `${formatJson(branch)}@origin`;

// By default, jj's `trunk()` guesses from branch names, and a wrong guess would rebase stacks onto
// one branch and base their pull requests on another.
export const checkTrunk = (branch: string): Effect.Effect<void, JjFailed | TrunkMismatch, Jj> =>
  Effect.gen(function* () {
    if ((yield* commitsAt(`trunk() & present(${trunkRevset(branch)})`)).length === 0) {
      return yield* TrunkMismatch.make({
        message: `trunk() isn't ${branch}@origin, GitHub's default branch; run \`jj-octo init\``,
      });
    }
  });

export const checkedTrunk: Effect.Effect<
  string,
  GitHubFailed | JjFailed | TrunkMismatch,
  GitHub | Jj
> = Effect.gen(function* () {
  const branch = yield* (yield* GitHub).defaultBranch;
  yield* checkTrunk(branch);
  return branch;
});
