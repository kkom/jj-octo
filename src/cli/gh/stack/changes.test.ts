import { expect } from "bun:test";

import { Array as EffectArray, Effect } from "effect";

import { conflictWithTrunk } from "../../../testing/conflicts";
import { layer } from "../../../testing/it-effect";
import { ScratchRepository, scratchRepository } from "../../../testing/scratch-repository";
import { NotAStack, stackChanges, withoutConflicts } from "./changes";

layer(scratchRepository)("stackChanges", (it) => {
  it("lists the bookmarks bottom to top", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      const stack = yield* stackChanges("@");
      expect(EffectArray.map(stack, ({ bookmark }) => bookmark)).toStrictEqual(["a", "b"]);
      expect(EffectArray.map(stack, ({ description }) => description)).toStrictEqual([
        "a\n",
        "b\n",
      ]);
    }));

  it("reads a change with conflicts as part of the stack, and says it has them", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* conflictWithTrunk("b");
      const read = (template: string) => (bookmark: string) =>
        repository.jj("log", "--no-graph", "-r", bookmark, "-T", template);
      const changeOf = read("change_id");
      const commitOf = read("commit_id");
      const shortOf = read("change_id.shortest(8)");
      const stack = yield* stackChanges("@");
      const expected = yield* Effect.forEach(
        [
          { bookmark: "a", conflict: false },
          { bookmark: "b", conflict: true },
          { bookmark: "c", conflict: true },
        ],
        ({ bookmark, conflict }) =>
          Effect.gen(function* () {
            const changeId = yield* changeOf(bookmark);
            const commitId = yield* commitOf(bookmark);
            const short = yield* shortOf(bookmark);
            return {
              bookmark,
              changeId,
              commitId,
              conflict,
              description: `${bookmark}\n`,
              label: `${short} ${bookmark}`,
            };
          }),
        { concurrency: 1 },
      );
      expect(stack).toStrictEqual(expected);
      const failure = yield* Effect.flip(withoutConflicts(stack));
      const shortB = yield* shortOf("b");
      const shortC = yield* shortOf("c");
      expect(failure).toStrictEqual(
        NotAStack.make({
          message: EffectArray.join(
            ["resolve the conflicts first:", `${shortB} b`, `${shortC} c`],
            "\n",
          ),
        }),
      );
    }));

  it("fails on a stack with two heads", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      yield* repository.jj("new", "a", "-m", "c");
      const failure = yield* Effect.flip(stackChanges("@"));
      expect(failure).toStrictEqual(
        NotAStack.make({
          message: `the stack has several heads, and a GitHub stack must be a chain:\n${yield* repository.labels("b", "@")}`,
        }),
      );
    }));

  it("fails on a change with no bookmark", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      const labelOfA = yield* repository.labels("a");
      yield* repository.jj("bookmark", "delete", "a");
      const failure = yield* Effect.flip(stackChanges("@"));
      expect(failure).toStrictEqual(
        NotAStack.make({
          message: `every change needs a bookmark naming its branch; these have none:\n${labelOfA}`,
        }),
      );
    }));

  it("fails on a change with two bookmarks", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      yield* repository.jj("bookmark", "create", "extra", "-r", "a");
      const failure = yield* Effect.flip(stackChanges("@"));
      expect(failure).toStrictEqual(
        NotAStack.make({
          message:
            "a pull request has one branch, and these changes have several bookmarks:\na extra",
        }),
      );
    }));
});
