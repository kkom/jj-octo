import { describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import { GitHub } from "../../clients/github/client";
import { PullRequestNumberSchema, StackNumberSchema } from "../../clients/github/types";
import { fakeGitHub, stackNumbered } from "../../testing/fake-github";
import { dissolve, NoSuchStack } from "./dissolve";

describe("dissolve", () => {
  it("dissolves the stack named, and leaves the others", async () => {
    const github = fakeGitHub({}, [stackNumbered(9, 1, 2), stackNumbered(7, 3)]);
    const stacks = await Effect.runPromise(
      dissolve(StackNumberSchema.make(7)).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const client = yield* GitHub;
            return yield* Effect.all([
              client.stackOf(PullRequestNumberSchema.make(1)),
              client.stackOf(PullRequestNumberSchema.make(3)),
            ]);
          }),
        ),
        Effect.provide(github.layer),
      ),
    );
    expect(github.calls).toStrictEqual(["unstack #7"]);
    expect(stacks).toStrictEqual([Option.some(stackNumbered(9, 1, 2)), Option.none()]);
  });

  it("fails where the repository has no such stack", async () => {
    const github = fakeGitHub({}, [stackNumbered(7, 3)]);
    const failure = await Effect.runPromise(
      Effect.flip(dissolve(StackNumberSchema.make(77)).pipe(Effect.provide(github.layer))),
    );
    expect(failure).toStrictEqual(new NoSuchStack({ message: "this repository has no stack #77" }));
    expect(github.calls).toStrictEqual([]);
  });
});
