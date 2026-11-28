import { Array as EffectArray, Console, Effect, Filter } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { commitsAt, type LoggedChange, loggedChanges } from "./changes";

/**
 * The changes one `jj rebase --source` of their bottom changes moves: a stack, or stacks a merge
 * joins.
 */
type Stack = readonly LoggedChange[];

/** `changes` must list each change after those below it. */
const stacksOf = (changes: readonly LoggedChange[]): readonly Stack[] => {
  const stackOf = new Map<string, LoggedChange[]>();
  for (const change of changes) {
    const [stack = [], ...joined] = new Set(
      EffectArray.flatMap(change.parents, (parent) => {
        const below = stackOf.get(parent);
        return below === undefined ? [] : [below];
      }),
    );
    for (const moved of [...joined.flat(), change]) {
      stack.push(moved);
      stackOf.set(moved.commitId, stack);
    }
  }
  return [...new Set(stackOf.values())];
};

const bottomChanges = (stack: Stack): readonly LoggedChange[] => {
  const commits = new Set(EffectArray.map(stack, ({ commitId }) => commitId));
  return EffectArray.filter(
    stack,
    ({ parents }) => !EffectArray.some(parents, (parent) => commits.has(parent)),
  );
};

// With no stacks, the command would rebase the working copy's change.
const rebaseCommand = (stacks: readonly Stack[]): readonly string[] => [
  "rebase",
  ...EffectArray.flatMap(
    EffectArray.flatMap(stacks, (stack) => bottomChanges(stack)),
    ({ commitId }: LoggedChange) => ["--source", commitId],
  ),
  "--destination",
  "trunk()",
  "--skip-emptied",
];

/**
 * The ids of the changes that a rebase of the stacks onto the trunk gives a new conflict. A dry run
 * finds them, changing nothing.
 */
const conflictedByRebase = (stacks: readonly Stack[]) =>
  Effect.gen(function* () {
    if (stacks.length === 0) {
      return new Set<string>();
    }
    const jj = yield* Jj;
    const conflictedCommitIds = yield* commitsAt("conflicts() & mutable()");
    const conflictedCommits = new Set(conflictedCommitIds);
    const conflictedChanges = new Set(
      EffectArray.flatMap(stacks, (stack) =>
        EffectArray.map(
          EffectArray.filter(stack, ({ conflict }) => conflict),
          ({ changeId }) => changeId,
        ),
      ),
    );
    const dryRun = yield* jj.dryRun(rebaseCommand(stacks));
    // The rebase didn't cause a conflict the change already had, nor one on a pre-rebase commit: a
    // divergent change's other commit, in a stack that stayed.
    const conflictedNow = yield* loggedChanges("conflicts() & mutable()", { atOperation: dryRun });
    return new Set(
      EffectArray.map(
        EffectArray.filter(
          conflictedNow,
          ({ changeId, commitId }) =>
            !conflictedChanges.has(changeId) && !conflictedCommits.has(commitId),
        ),
        ({ changeId }) => changeId,
      ),
    );
  });

const holdsAnyOf =
  (changeIds: readonly string[]) =>
  (stack: Stack): boolean =>
    EffectArray.some(stack, ({ changeId }) => changeIds.includes(changeId));

/**
 * Rebases the stacks onto the trunk in one command, except each stack the rebase gives a new
 * conflict, unless it holds a `required` change, so unwatched work isn't left conflicted. Conflicts
 * match stacks by change id, so a change id may be in only one stack.
 */
const rebaseStacks = (stacks: readonly Stack[], required: readonly string[]) =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const holdsRequired = holdsAnyOf(required);
    // Only a stack without a required change can stay.
    const conflicted = yield* conflictedByRebase(
      EffectArray.filter(stacks, (stack) => !holdsRequired(stack)),
    );
    const [left, rebased] = EffectArray.partition(
      stacks,
      Filter.fromPredicate(
        (stack: Stack) =>
          !holdsRequired(stack) &&
          EffectArray.some(stack, ({ changeId }) => conflicted.has(changeId)),
      ),
    );
    if (rebased.length > 0) {
      yield* jj.run(rebaseCommand(rebased));
    }
    for (const { label } of EffectArray.flatMap(left, (stack) => bottomChanges(stack))) {
      yield* Console.error(
        `left "${label}" and the changes on it where they were: they conflict with the trunk`,
      );
    }
  });

const isDivergent = (stack: Stack): boolean =>
  EffectArray.some(stack, ({ divergent }) => divergent);

/**
 * A change not combined with another checkout's push has two commits with one id, possibly in two
 * stacks. So each stack holding one is rebased alone and the rest together.
 */
export const rebaseOntoTrunk = (
  roots: string,
  required: readonly string[],
): Effect.Effect<void, JjFailed, Jj> =>
  Effect.gen(function* () {
    const logged = yield* loggedChanges(`(${roots})::`);
    const [alone, together] = EffectArray.partition(
      stacksOf(logged),
      Filter.fromPredicate(isDivergent),
    );
    for (const stacks of [together, ...EffectArray.map(alone, (stack) => [stack])]) {
      yield* rebaseStacks(stacks, required);
    }
  });
