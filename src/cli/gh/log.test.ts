import { describe, expect } from "bun:test";

import { Effect } from "effect";

import { conflictWithTrunk } from "../../testing/conflicts";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { openPullRequest } from "../../testing/pull-requests";
import { scratchRepository } from "../../testing/scratch-repository";
import { log } from "./log";

describe("log", () => {
  itEffect("prints each change top first, with its pull request and whether it is pushed", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      yield* repository.jj("describe", "-r", "b", "-m", "b, reworded");
      const github = fakeGitHub(
        {
          a: { ...openPullRequest("main", 1, "a"), draft: false },
          b: openPullRequest("a", 2, "b"),
        },
        [],
      );
      const printed = yield* log("@").pipe(inRepository(repository, github));
      expect(printed).toEqual([
        "c  no pull request  not pushed",
        "b  #2 draft         changed since push",
        "a  #1 ready         pushed",
      ]);
    }),
  );

  itEffect("marks the changes with conflicts, and shows them as any other", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      yield* conflictWithTrunk(repository, "b", { pushed: ["a"] });
      const github = fakeGitHub(
        { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
        [],
      );
      const printed = yield* log("@").pipe(inRepository(repository, github));
      expect(printed).toStrictEqual([
        "c  no pull request  not pushed          conflicted",
        "b  #2 draft         changed since push  conflicted",
        "a  #1 draft         pushed",
      ]);
    }),
  );
});
