import { describe, expect } from "bun:test";

import { Effect, Option } from "effect";

import { GitHub } from "../../clients/github/client";
import { PullRequestNumberSchema, StackNumberSchema } from "../../clients/github/types";
import { fakeGitHub } from "../../testing/fake-github";
import { itEffect, provideSetup } from "../../testing/it-effect";
import { stackNumbered } from "../../testing/pull-requests";
import { dissolve, NoSuchStack } from "./dissolve";

describe("dissolve", () => {
  itEffect("dissolves the stack named, and leaves the others", () =>
    Effect.gen(function* () {
      const github = fakeGitHub({}, [stackNumbered(9, 1, 2), stackNumbered(7, 3)]);
      const stacks = yield* dissolve(StackNumberSchema.make(7)).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const client = yield* GitHub;
            return yield* Effect.all(
              [
                client.stackOf(PullRequestNumberSchema.make(1)),
                client.stackOf(PullRequestNumberSchema.make(3)),
              ],
              { concurrency: "unbounded" },
            );
          }),
        ),
        provideSetup(github.layer),
      );
      expect(github.calls).toStrictEqual(["unstack #7"]);
      expect(stacks).toStrictEqual([Option.some(stackNumbered(9, 1, 2)), Option.none()]);
    }),
  );

  itEffect("fails where the repository has no such stack", () =>
    Effect.gen(function* () {
      const github = fakeGitHub({}, [stackNumbered(7, 3)]);
      const failure = yield* Effect.flip(
        dissolve(StackNumberSchema.make(77)).pipe(provideSetup(github.layer)),
      );
      expect(failure).toStrictEqual(
        NoSuchStack.make({ message: "this repository has no stack #77" }),
      );
      expect(github.calls).toStrictEqual([]);
    }),
  );
});
