import { expect } from "bun:test";

import { Effect, Layer } from "effect";

import { conflictWithTrunk } from "../../testing/conflicts";
import { fakeGitHub, setUpGitHub, setUpPullRequestsAB } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { openPullRequestsAB } from "../../testing/pull-requests";
import { ScratchRepository, scratchRepository } from "../../testing/scratch-repository";
import { log } from "./log";

layer(Layer.merge(scratchRepository, fakeGitHub))("log", (it) => {
  it("prints each change top first, with its pull request and whether it is pushed", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      yield* repository.jj("describe", "-r", "b", "-m", "b, reworded");
      yield* setUpGitHub({
        open: { ...openPullRequestsAB, a: { ...openPullRequestsAB.a, draft: false } },
      });
      const printed = yield* log("@");
      expect(printed).toStrictEqual([
        "c  no pull request  not pushed",
        "b  #2 draft         changed since push",
        "a  #1 ready         pushed",
      ]);
    }));

  it("marks the changes with conflicts, and shows them as any other", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      yield* conflictWithTrunk("b", { pushed: ["a"] });
      yield* setUpPullRequestsAB({ stacks: [] });
      const printed = yield* log("@");
      expect(printed).toStrictEqual([
        "c  no pull request  not pushed          conflicted",
        "b  #2 draft         changed since push  conflicted",
        "a  #1 draft         pushed",
      ]);
    }));
});
