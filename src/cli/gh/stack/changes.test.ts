import { describe, expect } from "bun:test";

import { Array as EffectArray, Effect } from "effect";

import { conflictWithTrunk } from "../../../testing/conflicts";
import { itEffect, provideSetup } from "../../../testing/it-effect";
import { scratchRepository } from "../../../testing/scratch-repository";
import { NotAStack, stackChanges, withoutConflicts } from "./changes";

describe("stackBookmarks", () => {
  itEffect("lists the bookmarks bottom to top", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b");
      const stack = yield* stackChanges("@").pipe(provideSetup(repository.layer));
      expect(EffectArray.map(stack, ({ bookmark }) => bookmark)).toEqual(["a", "b"]);
      expect(EffectArray.map(stack, ({ description }) => description)).toEqual(["a\n", "b\n"]);
    }),
  );

  itEffect("reads a change with conflicts as part of the stack, and says it has them", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* conflictWithTrunk(repository, "b");
      const read = (template: string) => (bookmark: string) =>
        repository.jj("log", "--no-graph", "-r", bookmark, "-T", template);
      const changeOf = read("change_id");
      const commitOf = read("commit_id");
      const shortOf = read("change_id.shortest(8)");
      const stack = yield* stackChanges("@").pipe(provideSetup(repository.layer));
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
    }),
  );

  itEffect("fails on a stack with two heads", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b");
      yield* repository.jj("new", "a", "-m", "c");
      const failure = yield* Effect.flip(stackChanges("@")).pipe(provideSetup(repository.layer));
      expect(failure).toBeInstanceOf(NotAStack);
      expect(failure.message).toContain("several heads");
    }),
  );

  itEffect("fails on a change with no bookmark", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b");
      yield* repository.jj("bookmark", "delete", "a");
      const failure = yield* Effect.flip(stackChanges("@")).pipe(provideSetup(repository.layer));
      expect(failure.message).toContain("needs a bookmark");
    }),
  );

  itEffect("fails on a change with two bookmarks", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b");
      yield* repository.jj("bookmark", "create", "extra", "-r", "a");
      const failure = yield* Effect.flip(stackChanges("@")).pipe(provideSetup(repository.layer));
      expect(failure.message).toContain("several bookmarks");
    }),
  );
});
