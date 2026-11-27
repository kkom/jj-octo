import { Array as EffectArray, Console, Effect, Filter } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { commitsAt, type LoggedChange, loggedChanges } from "./changes";

/**
 * The changes that one `jj rebase --source` of their bottom changes moves: a stack, or the stacks
 * that a merge joins.
 */
type Stack = readonly LoggedChange[];

/** The changes as stacks. `changes` must list each change after the changes below it. */
const stacksOf = (changes: readonly LoggedChange[]): readonly Stack[] => {
  const stackOf = new Map<string, LoggedChange[]>();
  for (const change of changes) {
    const [stack = [], ...joined] = new Set(
      change.parents.flatMap((parent) => {
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
  const commits = new Set(stack.map(({ commitId }) => commitId));
  return stack.filter(({ parents }) => !parents.some((parent) => commits.has(parent)));
};

// With no stacks, the command would rebase the working copy's change.
const rebaseCommand = (stacks: readonly Stack[]): readonly string[] => [
  "rebase",
  ...stacks
    .flatMap((stack) => bottomChanges(stack))
    .flatMap(({ commitId }) => ["--source", commitId]),
  "--destination",
  "trunk()",
  "--skip-emptied",
];

/**
 * Rebases the stacks onto the trunk in one jj command, except each stack that the rebase gives a
 * conflict it didn't have. Those stay where they are, so work nobody is looking at isn't left
 * conflicted. A stack holding one of the `required` changes is rebased whatever happens, and keeps
 * the conflict.
 *
 * It finds the stacks to leave with a dry run of the rebase of them all, which changes nothing
 * in the repository. It matches a conflict to its stack by change id, so only one of the stacks
 * may hold a given change id.
 */
const rebaseStacks = (stacks: readonly Stack[], required: readonly string[]) =>
  Effect.gen(function* () {
    if (stacks.length === 0) {
      return;
    }
    const jj = yield* Jj;
    const conflictedCommitIds = yield* commitsAt("conflicts() & mutable()");
    const conflictedCommits = new Set(conflictedCommitIds);
    const conflictedChanges = new Set(
      stacks.flatMap((stack) =>
        stack.filter(({ conflict }) => conflict).map(({ changeId }) => changeId),
      ),
    );
    const dryRun = yield* jj.dryRun(rebaseCommand(stacks));
    // The rebase didn't cause a conflict that the change already had. Nor one of a commit from
    // before the rebase, which is a divergent change's other commit, in a stack that stayed.
    const conflictedByRebase = new Set(
      (yield* loggedChanges("conflicts() & mutable()", { atOperation: dryRun }))
        .filter(
          ({ changeId, commitId }) =>
            !conflictedChanges.has(changeId) && !conflictedCommits.has(commitId),
        )
        .map(({ changeId }) => changeId),
    );
    const [left, rebased] = EffectArray.partition(
      stacks,
      Filter.fromPredicate(
        (stack: Stack) =>
          !stack.some(({ changeId }) => required.includes(changeId)) &&
          stack.some(({ changeId }) => conflictedByRebase.has(changeId)),
      ),
    );
    if (rebased.length > 0) {
      yield* jj.run(rebaseCommand(rebased));
    }
    for (const { label } of left.flatMap((stack) => bottomChanges(stack))) {
      yield* Console.error(
        `left "${label}" and the changes on it where they were: they conflict with the trunk`,
      );
    }
  });

const isDivergent = (stack: Stack): boolean => stack.some(({ divergent }) => divergent);

/**
 * Rebases the stacks whose bottom changes the revset holds, as `rebaseStacks` does. A change that
 * wasn't combined with a push from another checkout has two commits with one id, which can be in
 * two stacks. So a stack that holds one is rebased by itself, and the rest together: the number
 * of jj commands grows only with the number of stacks that hold one.
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
    for (const stacks of [together, ...alone.map((stack) => [stack])]) {
      yield* rebaseStacks(stacks, required);
    }
  });
