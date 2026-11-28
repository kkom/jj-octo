import { expect } from "bun:test";

import { Effect, Option } from "effect";

import { GitHub } from "../../clients/github/client";
import { PullRequestNumberSchema, StackNumberSchema } from "../../clients/github/types";
import { fakeGitHub, gitHubCalls, setUpGitHub } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { stackNumbered } from "../../testing/pull-requests";
import { dissolve, NoSuchStack } from "./dissolve";

layer(fakeGitHub)("dissolve", (it) => {
  it("dissolves the stack named, and leaves the others", () =>
    Effect.gen(function* () {
      const client = yield* GitHub;
      yield* setUpGitHub({ stacks: [stackNumbered(9, 1, 2), stackNumbered(7, 3)] });
      yield* dissolve(StackNumberSchema.make(7));
      const stacks = yield* Effect.all(
        [
          client.stackOf(PullRequestNumberSchema.make(1)),
          client.stackOf(PullRequestNumberSchema.make(3)),
        ],
        { concurrency: "unbounded" },
      );
      expect({ calls: yield* gitHubCalls, stacks }).toStrictEqual({
        calls: ["unstack #7"],
        stacks: [Option.some(stackNumbered(9, 1, 2)), Option.none()],
      });
    }));

  it("fails where the repository has no such stack", () =>
    Effect.gen(function* () {
      yield* setUpGitHub({ stacks: [stackNumbered(7, 3)] });
      const failure = yield* Effect.flip(dissolve(StackNumberSchema.make(77)));
      expect({ calls: yield* gitHubCalls, failure }).toStrictEqual({
        calls: [],
        failure: NoSuchStack.make({ message: "this repository has no stack #77" }),
      });
    }));
});
