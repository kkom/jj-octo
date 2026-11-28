import { Effect, Schema } from "effect";

import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import type { Jj, JjFailed } from "../../../clients/jj";
import { formatJson } from "../../../json";
import {
  commitsAt,
  downstackChanges,
  type NotAStack,
  type StackChange,
  withoutConflicts,
} from "./changes";

export class TrunkMismatch extends Schema.TaggedError<
  TrunkMismatch,
  { readonly brand: unique symbol }
>()("TrunkMismatch", { message: Schema.String }) {}

// Quoted so any branch name parses.
export const trunkRevset = (branch: string): string => `${formatJson(branch)}@origin`;

/**
 * By default, jj's `trunk()` guesses from branch names, and a wrong guess would rebase stacks onto
 * one branch and base their pull requests on another.
 *
 * `trunk()` and the branch don't depend on the working copy, so the read skips the snapshot and can
 * run beside another.
 */
export const checkTrunk = (branch: string): Effect.Effect<void, JjFailed | TrunkMismatch, Jj> =>
  Effect.gen(function* () {
    const trunk = yield* commitsAt(`trunk() & present(${trunkRevset(branch)})`, {
      ignoreWorkingCopy: true,
    });
    if (trunk.length === 0) {
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

/**
 * `checkedTrunk`, and the revision's change and the ones below it in its stack, none with
 * conflicts. The two run concurrently. Where both fail, it fails as `checkedTrunk` does.
 */
export const trunkAndDownstack = (
  revision: string,
): Effect.Effect<
  { readonly downstack: readonly StackChange[]; readonly trunk: string },
  GitHubFailed | JjFailed | NotAStack | TrunkMismatch,
  GitHub | Jj
> =>
  Effect.gen(function* () {
    const [trunk, downstack] = yield* Effect.all(
      [
        checkedTrunk,
        Effect.result(downstackChanges(revision).pipe(Effect.flatMap(withoutConflicts))),
      ],
      { concurrency: "unbounded" },
    );
    return { downstack: yield* Effect.fromResult(downstack), trunk };
  });
