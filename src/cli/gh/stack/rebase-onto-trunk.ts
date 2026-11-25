import { Console, Effect } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import {
  anyOf,
  changeIdsAt,
  changeRevset,
  changesIn,
  commitsAt,
  lines,
  stackRevset,
} from "./changes";

/**
 * Rebases one stack onto the trunk, unless that gives any of its changes a conflict it didn't
 * have. Then the stack goes back where it was, so work nobody is looking at isn't left conflicted.
 * A stack holding one of the `required` changes is rebased whatever happens, and keeps the conflict.
 */
const rebaseStack = (root: string, required: readonly string[]) =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const stack = stackRevset(root);
    const [name = root] = yield* changesIn(root);
    const changes = yield* changeIdsAt(stack);
    const conflicted = yield* changeIdsAt(`conflicts() & (${stack})`);
    const conflictedCommits = yield* commitsAt("conflicts() & mutable()");
    const [operation = ""] = lines(
      yield* jj.read([
        "operation",
        "log",
        "--no-graph",
        "--limit",
        "1",
        "-T",
        String.raw`id ++ "\n"`,
      ]),
    );
    yield* jj.run(["rebase", "--source", root, "--destination", "trunk()", "--skip-emptied"]);
    // A merged change is abandoned by the rebase, so its id may be gone. A change that wasn't
    // combined with a push from another checkout has two commits with one id. `change_id()`
    // selects none or both, where the bare id fails. The other commit is in another stack, so a
    // conflict it already had isn't one this rebase caused.
    const rebased = anyOf(changes.map((change) => changeRevset(change)));
    const untouched = anyOf(conflictedCommits);
    const conflictedNow = yield* changeIdsAt(`(conflicts() & (${rebased})) ~ (${untouched})`);
    const mayRestore = !changes.some((change) => required.includes(change));
    if (mayRestore && conflictedNow.some((change) => !conflicted.includes(change))) {
      yield* jj.run(["operation", "restore", operation]);
      yield* Console.error(
        `left "${name}" and the changes on it where they were: they conflict with the trunk`,
      );
    }
  });

/** Rebases each stack whose bottom change the revset holds onto the trunk, as `rebaseStack` does. */
export const rebaseOntoTrunk = (
  roots: string,
  required: readonly string[],
): Effect.Effect<void, JjFailed, Jj> =>
  Effect.gen(function* () {
    for (const root of yield* commitsAt(roots)) {
      yield* rebaseStack(root, required);
    }
  });
