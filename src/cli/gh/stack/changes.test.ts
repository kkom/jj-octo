import { afterAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { conflictWithTrunk } from "../../../testing/conflicts";
import { removeScratchRepositories, scratchRepository } from "../../../testing/scratch-repository";
import { NotAStack, stackChanges, withoutConflicts } from "./changes";

afterAll(removeScratchRepositories);

describe("stackBookmarks", () => {
  it("lists the bookmarks bottom to top", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    const stack = await Effect.runPromise(stackChanges("@").pipe(Effect.provide(repository.layer)));
    expect(stack.map(({ bookmark }) => bookmark)).toEqual(["a", "b"]);
    expect(stack.map(({ description }) => description)).toEqual(["a\n", "b\n"]);
  });

  it("reads a change with conflicts as part of the stack, and says it has them", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    conflictWithTrunk(repository, "b");
    const read = (template: string) => (bookmark: string) =>
      repository.jj("log", "--no-graph", "-r", bookmark, "-T", template);
    const changeOf = read("change_id");
    const commitOf = read("commit_id");
    const shortOf = read("change_id.shortest(8)");
    const stack = await Effect.runPromise(stackChanges("@").pipe(Effect.provide(repository.layer)));
    expect(stack).toStrictEqual(
      [
        { bookmark: "a", conflict: false },
        { bookmark: "b", conflict: true },
        { bookmark: "c", conflict: true },
      ].map(({ bookmark, conflict }) => ({
        bookmark,
        changeId: changeOf(bookmark),
        commitId: commitOf(bookmark),
        conflict,
        description: `${bookmark}\n`,
        label: `${shortOf(bookmark)} ${bookmark}`,
      })),
    );
    const failure = await Effect.runPromise(Effect.flip(withoutConflicts(stack)));
    expect(failure).toStrictEqual(
      new NotAStack({
        message: ["resolve the conflicts first:", `${shortOf("b")} b`, `${shortOf("c")} c`].join(
          "\n",
        ),
      }),
    );
  });

  it("fails on a stack with two heads", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    repository.jj("new", "a", "-m", "c");
    const failure = await Effect.runPromise(
      Effect.flip(stackChanges("@")).pipe(Effect.provide(repository.layer)),
    );
    expect(failure).toBeInstanceOf(NotAStack);
    expect(failure.message).toContain("several heads");
  });

  it("fails on a change with no bookmark", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    repository.jj("bookmark", "delete", "a");
    const failure = await Effect.runPromise(
      Effect.flip(stackChanges("@")).pipe(Effect.provide(repository.layer)),
    );
    expect(failure.message).toContain("needs a bookmark");
  });

  it("fails on a change with two bookmarks", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    repository.jj("bookmark", "create", "extra", "-r", "a");
    const failure = await Effect.runPromise(
      Effect.flip(stackChanges("@")).pipe(Effect.provide(repository.layer)),
    );
    expect(failure.message).toContain("several bookmarks");
  });
});
