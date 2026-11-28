import { afterAll, describe, expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Array as EffectArray, Effect, String as EffectString } from "effect";

import { gitClone } from "../../testing/git-clone";
import { itEffect, provideSetup } from "../../testing/it-effect";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchDirectory,
  scratchRepository,
} from "../../testing/scratch-repository";
import { init } from "./init";
import { NotSetUp } from "./setup";
import { checkTrunk } from "./stack/trunk";

afterAll(removeScratchRepositories);

/** Pushes a `develop` branch, and makes it `origin`'s default branch. */
const defaultToDevelop = (repository: ScratchRepository): void => {
  repository.jj("new", "main", "-m", "develop");
  repository.write("develop.txt", "develop\n");
  repository.jj("bookmark", "create", "develop", "-r", "@");
  repository.jj("git", "push", "--bookmark", "develop");
  const origin = EffectString.trim(repository.git("remote", "get-url", "origin"));
  repository.git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/develop");
};

describe("init", () => {
  itEffect("colocates a git clone, and copies git's identity into jj", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      yield* init.pipe(provideSetup(clone.layer));
      expect(clone.jj("config", "get", "user.name")).toBe("Cloner\n");
      expect(clone.jj("config", "get", "user.email")).toBe("cloner@example.com\n");
      expect(clone.jj("log", "--no-graph", "-r", "@", "-T", "author.email()")).toBe(
        "cloner@example.com",
      );
      expect(clone.jj("config", "get", "aliases.gh")).toContain("jj-octo");
    }),
  );

  itEffect("keeps a `jj gh` alias that runs another build", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      clone.jj("git", "init", "--colocate");
      clone.jj("config", "set", "--repo", "aliases.gh", '["util", "exec", "--", "bun", "main.ts"]');
      yield* init.pipe(provideSetup(clone.layer));
      expect(clone.jj("config", "get", "aliases.gh")).toBe(
        '["util", "exec", "--", "bun", "main.ts"]\n',
      );
    }),
  );

  itEffect("sets the repository's `jj gh` alias where only the user's config has one", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      writeFileSync(clone.jjConfigFile, 'aliases.gh = ["gh"]\n');
      yield* init.pipe(provideSetup(clone.layer));
      expect(clone.jj("config", "list", "--repo", "aliases.gh")).toBe(
        'aliases.gh = ["util","exec","--","jj-octo"]\n',
      );
    }),
  );

  itEffect("copies a name that isn't a bare TOML value, such as a bot's", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository(), "renovate[bot]");
      yield* init.pipe(provideSetup(clone.layer));
      expect(clone.jj("config", "get", "user.name")).toBe("renovate[bot]\n");
    }),
  );

  itEffect(
    "sets up the rest, and then fails on the part of an identity that neither jj nor git has",
    () =>
      Effect.gen(function* () {
        const clone = gitClone(scratchRepository());
        clone.git("config", "--unset", "user.email");
        const failure = yield* Effect.flip(init.pipe(provideSetup(clone.layer)));
        expect(failure).toStrictEqual(
          NotSetUp.make({
            message:
              "neither jj nor git has user.email; set it with `jj config set --user user.email`",
          }),
        );
        expect([
          clone.jj("config", "get", "user.name"),
          clone.jj("config", "list", "--repo", "aliases.gh"),
        ]).toStrictEqual(["Cloner\n", 'aliases.gh = ["util","exec","--","jj-octo"]\n']);
      }),
  );

  itEffect("sets up the rest where origin can't be read, and then fails with git's error", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      clone.git("remote", "set-url", "origin", "/nonexistent");
      const failure = yield* Effect.flip(init.pipe(provideSetup(clone.layer)));
      expect(failure).toStrictEqual(
        NotSetUp.make({
          message: EffectArray.join(
            [
              "git ls-remote --symref origin HEAD failed: fatal: '/nonexistent' does not appear to be a git repository",
              "fatal: Could not read from remote repository.",
              "",
              "Please make sure you have the correct access rights",
              "and the repository exists.",
            ],
            "\n",
          ),
        }),
      );
      expect(clone.jj("config", "list", "--repo", "aliases.gh")).toBe(
        'aliases.gh = ["util","exec","--","jj-octo"]\n',
      );
    }),
  );

  itEffect("fails where a config that overrides the repository's undoes a fix", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      yield* init.pipe(provideSetup(clone.layer));
      clone.jj("config", "set", "--workspace", 'revset-aliases."trunk()"', "root()");
      const failure = yield* Effect.flip(init.pipe(provideSetup(clone.layer)));
      expect(failure).toStrictEqual(
        NotSetUp.make({
          message:
            "trunk() isn't main@origin, GitHub's default branch, fetched and tracked, though init set it up",
        }),
      );
    }),
  );

  itEffect("leaves a git worktree as it is", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      const worktree = path.join(scratchDirectory("worktree-"), "checkout");
      clone.git("worktree", "add", "--detach", worktree);
      const failure = yield* Effect.flip(init.pipe(provideSetup(clone.layerAt(worktree))));
      expect(failure).toStrictEqual(
        NotSetUp.make({
          message:
            "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
        }),
      );
      expect(existsSync(path.join(worktree, ".jj"))).toBe(false);
    }),
  );

  itEffect("gives an author to the working copy of a repository colocated without one", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      clone.jj("git", "init", "--colocate");
      clone.jj("commit", "-m", "work");
      yield* init.pipe(provideSetup(clone.layer));
      expect(
        clone.jj("log", "--no-graph", "-r", "@ | @-", "-T", String.raw`author.email() ++ "\n"`),
      ).toBe("cloner@example.com\ncloner@example.com\n");
    }),
  );

  itEffect("makes trunk() the default branch, fetching and tracking it", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      const clone = gitClone(repository);
      // Jj makes `trunk()` the default branch it finds when it colocates.
      clone.jj("git", "init", "--colocate");
      defaultToDevelop(repository);
      yield* init.pipe(provideSetup(clone.layer));
      expect(clone.jj("config", "get", 'revset-aliases."trunk()"')).toBe('"develop"@origin\n');
      expect(clone.jj("bookmark", "list", "--tracked", "-T", String.raw`name ++ "\n"`)).toContain(
        "develop",
      );
    }),
  );

  itEffect("makes trunk() a new default branch on the same commit as the old one", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      const clone = gitClone(repository);
      clone.jj("git", "init", "--colocate");
      repository.jj("bookmark", "create", "develop", "-r", "main");
      repository.jj("git", "push", "--bookmark", "develop");
      const origin = EffectString.trim(repository.git("remote", "get-url", "origin"));
      repository.git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/develop");
      yield* init.pipe(provideSetup(clone.layer));
      expect(clone.jj("config", "get", 'revset-aliases."trunk()"')).toBe('"develop"@origin\n');
    }),
  );

  itEffect("changes nothing when run again", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      yield* init.pipe(provideSetup(clone.layer));
      const operations = clone.jj("operation", "log", "--no-graph", "-T", String.raw`id ++ "\n"`);
      yield* init.pipe(provideSetup(clone.layer));
      expect(clone.jj("operation", "log", "--no-graph", "-T", String.raw`id ++ "\n"`)).toBe(
        operations,
      );
    }),
  );
});

describe("checkTrunk", () => {
  itEffect("fails where trunk() isn't the default branch, until init sets it", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      defaultToDevelop(repository);
      const check = checkTrunk("develop").pipe(provideSetup(repository.layer));
      const failure = yield* Effect.flip(check);
      expect(failure.message).toBe(
        "trunk() isn't develop@origin, GitHub's default branch; run `jj-octo init`",
      );
      yield* init.pipe(provideSetup(repository.layer));
      yield* check;
    }),
  );
});
