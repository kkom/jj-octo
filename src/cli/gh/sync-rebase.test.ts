import { expect } from "bun:test";

import { Array as EffectArray, Effect, Layer, String as EffectString } from "effect";

import { moveTrunkOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";
import { syncing } from "../../testing/sync";
import { lines } from "./stack/changes";

const OPERATION = String.raw`description.first_line() ++ "\n"`;

// A second stack, `c`, on the trunk the stack of `a` and `b` started from, which conflicts with
// what `moveTrunkOnGitHub` adds to the trunk.
const addConflictingStack = Effect.gen(function* () {
  const repository = yield* ScratchRepository;
  yield* repository.jj("new", "main", "-m", "c");
  yield* repository.jj("bookmark", "create", "c", "-r", "@");
  yield* repository.write("trunk.txt", "c's own\n");
});

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))(
  "sync, with several stacks to rebase",
  (it) => {
    it("rebases the stacks in one jj operation, and leaves no other operation", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addConflictingStack;
        yield* repository.jj("new", "main", "-m", "d");
        yield* repository.jj("bookmark", "create", "d", "-r", "@");
        yield* moveTrunkOnGitHub();
        const operationsBefore = yield* repository.jj(
          "operation",
          "log",
          "--no-graph",
          "-T",
          OPERATION,
        );
        const before = lines(operationsBefore);
        yield* syncing();
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
        ).toStrictEqual(["rebase", "fetch"]);
        const filesOfB = yield* repository.files("b");
        const filesOfD = yield* repository.files("d");
        expect([filesOfB, filesOfD]).toStrictEqual([
          ["a.txt", "b.txt", "base.txt", "trunk.txt"],
          ["base.txt", "trunk.txt"],
        ]);
        const parent = yield* repository.description("c-");
        expect(parent).toBe("base");
      }));

    it("leaves the stacks that a merge joins where one conflicts with the moved trunk", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addConflictingStack;
        yield* repository.jj("new", "b", "c", "-m", "both");
        yield* moveTrunkOnGitHub();
        yield* syncing();
        expect({
          conflicted: yield* repository.conflicted,
          parents: yield* repository.description("a- | c-"),
        }).toStrictEqual({ conflicted: "", parents: "base" });
      }));
  },
);
