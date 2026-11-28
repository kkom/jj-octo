import { expect } from "bun:test";

import { Array as EffectArray, Effect } from "effect";

import { addWorktree, GitClone, gitClone } from "../../testing/git-clone";
import { layer } from "../../testing/it-effect";
import { problems } from "./doctor";
import { init } from "./init";
import { NotSetUp } from "./setup";

const INIT = "; run `jj-octo init`";

layer(gitClone())("problems", (it) => {
  it("finds what init sets up in a plain git clone, and nothing once init has", () =>
    Effect.gen(function* () {
      const found = yield* problems;
      expect(found).toStrictEqual([
        `this checkout isn't a jj repository colocated with git${INIT}`,
      ]);
      yield* init;
      const foundOnceSetUp = yield* problems;
      expect(foundOnceSetUp).toStrictEqual([]);
    }));

  it("takes jj's own trunk() alias for the default branch", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      // Jj sets `trunk()` to `main@origin`, without the quotes init writes.
      yield* clone.jj("git", "init", "--colocate");
      yield* clone.jj("bookmark", "track", "main", "--remote", "origin");
      // The changes jj made without an identity count as part of the identity's problem.
      const found = yield* problems;
      expect(found).toStrictEqual([
        `jj has no user.name, which git has${INIT}`,
        `jj has no user.email, which git has${INIT}`,
        `\`jj gh\` isn't set up${INIT}`,
      ]);
    }));

  it("finds only that a git worktree isn't a jj repository", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      const worktree = yield* addWorktree;
      const clients = yield* clone.clientsIn(worktree);
      const found = yield* problems.pipe(Effect.provide(clients));
      expect(found).toStrictEqual([
        "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
      ]);
    }));

  it("tells to set an identity where neither jj nor git has one", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* clone.git("config", "--unset", "user.name");
      yield* clone.git("config", "--unset", "user.email");
      const identity = [
        "neither jj nor git has user.name; set it with `jj config set --user user.name`",
        "neither jj nor git has user.email; set it with `jj config set --user user.email`",
      ];
      const failure = yield* Effect.flip(init);
      expect(failure).toStrictEqual(NotSetUp.make({ message: EffectArray.join(identity, "\n") }));
      const found = yield* problems;
      expect(found).toStrictEqual(identity);
    }));

  it("finds a trunk() that isn't the default branch", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* init;
      yield* clone.jj("config", "set", "--repo", 'revset-aliases."trunk()"', "root()");
      const found = yield* problems;
      expect(found).toStrictEqual([
        `trunk() isn't main@origin, GitHub's default branch, fetched and tracked${INIT}`,
      ]);
    }));

  it("runs the other checks where origin can't be read", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* init;
      yield* clone.git("remote", "set-url", "origin", "/nonexistent");
      const found = yield* problems;
      expect(found).toStrictEqual([
        EffectArray.join(
          [
            "could not check: git ls-remote --symref origin HEAD failed: fatal: '/nonexistent' does not appear to be a git repository",
            "fatal: Could not read from remote repository.",
            "",
            "Please make sure you have the correct access rights",
            "and the repository exists.",
          ],
          "\n",
        ),
      ]);
    }));
});
