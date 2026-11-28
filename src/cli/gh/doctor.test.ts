import { afterAll, describe, expect } from "bun:test";
import path from "node:path";

import { Array as EffectArray, Effect } from "effect";

import { gitClone, provideClients } from "../../testing/git-clone";
import { itEffect } from "../../testing/it-effect";
import {
  removeScratchRepositories,
  scratchDirectory,
  scratchRepository,
} from "../../testing/scratch-repository";
import { problems } from "./doctor";
import { init } from "./init";
import { NotSetUp } from "./setup";

afterAll(removeScratchRepositories);

const INIT = "; run `jj-octo init`";

describe("problems", () => {
  itEffect("finds what init sets up in a plain git clone, and nothing once init has", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      const found = yield* problems.pipe(provideClients(clone.layer));
      expect(found).toStrictEqual([
        `this checkout isn't a jj repository colocated with git${INIT}`,
      ]);
      yield* init.pipe(provideClients(clone.layer));
      const foundOnceSetUp = yield* problems.pipe(provideClients(clone.layer));
      expect(foundOnceSetUp).toStrictEqual([]);
    }),
  );

  itEffect("takes jj's own trunk() alias for the default branch", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      // Jj sets `trunk()` to `main@origin`, without the quotes init writes.
      clone.jj("git", "init", "--colocate");
      clone.jj("bookmark", "track", "main", "--remote", "origin");
      // The changes jj made without an identity count as part of the identity's problem.
      const found = yield* problems.pipe(provideClients(clone.layer));
      expect(found).toStrictEqual([
        `jj has no user.name, which git has${INIT}`,
        `jj has no user.email, which git has${INIT}`,
        `\`jj gh\` isn't set up${INIT}`,
      ]);
    }),
  );

  itEffect("finds only that a git worktree isn't a jj repository", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      const worktree = path.join(scratchDirectory("worktree-"), "checkout");
      clone.git("worktree", "add", "--detach", worktree);
      const found = yield* problems.pipe(provideClients(clone.layerAt(worktree)));
      expect(found).toStrictEqual([
        "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
      ]);
    }),
  );

  itEffect("tells to set an identity where neither jj nor git has one", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      clone.git("config", "--unset", "user.name");
      clone.git("config", "--unset", "user.email");
      const identity = [
        "neither jj nor git has user.name; set it with `jj config set --user user.name`",
        "neither jj nor git has user.email; set it with `jj config set --user user.email`",
      ];
      const failure = yield* Effect.flip(init).pipe(provideClients(clone.layer));
      expect(failure).toStrictEqual(NotSetUp.make({ message: EffectArray.join(identity, "\n") }));
      const found = yield* problems.pipe(provideClients(clone.layer));
      expect(found).toStrictEqual(identity);
    }),
  );

  itEffect("finds a trunk() that isn't the default branch", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      yield* init.pipe(provideClients(clone.layer));
      clone.jj("config", "set", "--repo", 'revset-aliases."trunk()"', "root()");
      const found = yield* problems.pipe(provideClients(clone.layer));
      expect(found).toStrictEqual([
        `trunk() isn't main@origin, GitHub's default branch, fetched and tracked${INIT}`,
      ]);
    }),
  );

  itEffect("runs the other checks where origin can't be read", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      yield* init.pipe(provideClients(clone.layer));
      clone.git("remote", "set-url", "origin", "/nonexistent");
      const found = yield* problems.pipe(provideClients(clone.layer));
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
    }),
  );
});
