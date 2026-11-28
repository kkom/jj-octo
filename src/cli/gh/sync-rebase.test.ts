import { describe, expect } from "bun:test";

import { Array as EffectArray, Effect, String as EffectString } from "effect";

import { moveTrunkOnGitHub } from "../../testing/branch-changes";
import { itEffect } from "../../testing/it-effect";
import { pushedStack } from "../../testing/scratch-repository";
import { syncing } from "../../testing/sync";
import { lines } from "./stack/changes";

const OPERATION = String.raw`description.first_line() ++ "\n"`;

// A stack of `a` and `b`, and a second stack, `c`, which conflicts with what `moveTrunkOnGitHub`
// adds to the trunk.
const withConflictingStack = Effect.gen(function* () {
  const repository = yield* pushedStack("a", "b");
  yield* repository.jj("new", "main", "-m", "c");
  yield* repository.jj("bookmark", "create", "c", "-r", "@");
  yield* repository.write("trunk.txt", "c's own\n");
  return repository;
});

describe("sync, with several stacks to rebase", () => {
  itEffect("rebases the stacks in one jj operation, and leaves no other operation", () =>
    Effect.gen(function* () {
      const repository = yield* withConflictingStack;
      yield* repository.jj("new", "main", "-m", "d");
      yield* repository.jj("bookmark", "create", "d", "-r", "@");
      yield* moveTrunkOnGitHub(repository);
      const operationsBefore = yield* repository.jj(
        "operation",
        "log",
        "--no-graph",
        "-T",
        OPERATION,
      );
      const before = lines(operationsBefore);
      yield* syncing(repository);
      const operationsAfter = yield* repository.jj(
        "operation",
        "log",
        "--no-graph",
        "-T",
        OPERATION,
      );
      const after = lines(operationsAfter);
      expect(
        EffectArray.map(
          after.slice(0, after.length - before.length),
          (line) => EffectString.split(line, " ")[0],
        ),
      ).toEqual(["rebase", "fetch"]);
      const filesOfB = yield* repository.files("b");
      const filesOfD = yield* repository.files("d");
      expect([filesOfB, filesOfD]).toStrictEqual([
        ["a.txt", "b.txt", "base.txt", "trunk.txt"],
        ["base.txt", "trunk.txt"],
      ]);
      const parent = yield* repository.jj("log", "--no-graph", "-r", "c-", "-T", "description");
      expect(parent).toBe("base\n");
    }),
  );

  itEffect("leaves the stacks that a merge joins where one conflicts with the moved trunk", () =>
    Effect.gen(function* () {
      const repository = yield* withConflictingStack;
      yield* repository.jj("new", "b", "c", "-m", "both");
      yield* moveTrunkOnGitHub(repository);
      yield* syncing(repository);
      const conflicts = yield* repository.jj(
        "log",
        "--no-graph",
        "-r",
        "conflicts()",
        "-T",
        "change_id",
      );
      const parents = yield* repository.jj(
        "log",
        "--no-graph",
        "-r",
        "a- | c-",
        "-T",
        "description",
      );
      expect(conflicts).toBe("");
      expect(parents).toBe("base\n");
    }),
  );
});
