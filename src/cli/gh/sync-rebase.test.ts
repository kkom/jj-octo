import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import { Array as EffectArray, String as EffectString } from "effect";

import { moveTrunkOnGitHub } from "../../testing/branch-changes";
import { pushedStack, removeScratchRepositories } from "../../testing/scratch-repository";
import { syncIn } from "../../testing/sync";
import { lines } from "./stack/changes";

afterAll(removeScratchRepositories);

const OPERATION = String.raw`description.first_line() ++ "\n"`;

describe("sync, with several stacks to rebase", () => {
  let repository = pushedStack("a", "b");

  // A second stack, `c`, which conflicts with what `moveTrunkOnGitHub` adds to the trunk.
  beforeEach(() => {
    repository = pushedStack("a", "b");
    repository.jj("new", "main", "-m", "c");
    repository.jj("bookmark", "create", "c", "-r", "@");
    repository.write("trunk.txt", "c's own\n");
  });

  it("rebases the stacks in one jj operation, and leaves no other operation", async () => {
    repository.jj("new", "main", "-m", "d");
    repository.jj("bookmark", "create", "d", "-r", "@");
    moveTrunkOnGitHub(repository);
    const before = lines(repository.jj("operation", "log", "--no-graph", "-T", OPERATION));
    await syncIn(repository);
    const after = lines(repository.jj("operation", "log", "--no-graph", "-T", OPERATION));
    expect(
      EffectArray.map(
        after.slice(0, after.length - before.length),
        (line) => EffectString.split(line, " ")[0],
      ),
    ).toEqual(["rebase", "fetch"]);
    expect([repository.files("b"), repository.files("d")]).toStrictEqual([
      ["a.txt", "b.txt", "base.txt", "trunk.txt"],
      ["base.txt", "trunk.txt"],
    ]);
    expect(repository.jj("log", "--no-graph", "-r", "c-", "-T", "description")).toBe("base\n");
  });

  it("leaves the stacks that a merge joins where one conflicts with the moved trunk", async () => {
    repository.jj("new", "b", "c", "-m", "both");
    moveTrunkOnGitHub(repository);
    await syncIn(repository);
    expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "change_id")).toBe("");
    expect(repository.jj("log", "--no-graph", "-r", "a- | c-", "-T", "description")).toBe("base\n");
  });
});
