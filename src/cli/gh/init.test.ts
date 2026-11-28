import { describe, expect } from "bun:test";

import { Array as EffectArray, Effect, FileSystem, Path, String as EffectString } from "effect";

import { gitClone } from "../../testing/git-clone";
import { itEffect, provideSetup } from "../../testing/it-effect";
import { scratchDirectory } from "../../testing/scratch-process";
import { type ScratchRepository, scratchRepository } from "../../testing/scratch-repository";
import { init } from "./init";
import { NotSetUp } from "./setup";
import { checkTrunk } from "./stack/trunk";

/** Pushes a `develop` branch, and makes it `origin`'s default branch. */
const defaultToDevelop = (repository: ScratchRepository): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* repository.jj("new", "main", "-m", "develop");
    yield* repository.write("develop.txt", "develop\n");
    yield* repository.jj("bookmark", "create", "develop", "-r", "@");
    yield* repository.jj("git", "push", "--bookmark", "develop");
    const url = yield* repository.git("remote", "get-url", "origin");
    const origin = EffectString.trim(url);
    yield* repository.git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/develop");
  });

describe("init", () => {
  itEffect("colocates a git clone, and copies git's identity into jj", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* init.pipe(provideSetup(clone.layer));
      const name = yield* clone.jj("config", "get", "user.name");
      const email = yield* clone.jj("config", "get", "user.email");
      const author = yield* clone.jj("log", "--no-graph", "-r", "@", "-T", "author.email()");
      const alias = yield* clone.jj("config", "get", "aliases.gh");
      expect(name).toBe("Cloner\n");
      expect(email).toBe("cloner@example.com\n");
      expect(author).toBe("cloner@example.com");
      expect(alias).toContain("jj-octo");
    }),
  );

  itEffect("keeps a `jj gh` alias that runs another build", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* clone.jj("git", "init", "--colocate");
      yield* clone.jj(
        "config",
        "set",
        "--repo",
        "aliases.gh",
        '["util", "exec", "--", "bun", "main.ts"]',
      );
      yield* init.pipe(provideSetup(clone.layer));
      const alias = yield* clone.jj("config", "get", "aliases.gh");
      expect(alias).toBe('["util", "exec", "--", "bun", "main.ts"]\n');
    }),
  );

  itEffect("sets the repository's `jj gh` alias where only the user's config has one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* fs.writeFileString(clone.jjConfigFile, 'aliases.gh = ["gh"]\n');
      yield* init.pipe(provideSetup(clone.layer));
      const alias = yield* clone.jj("config", "list", "--repo", "aliases.gh");
      expect(alias).toBe('aliases.gh = ["util","exec","--","jj-octo"]\n');
    }),
  );

  itEffect("copies a name that isn't a bare TOML value, such as a bot's", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository, "renovate[bot]");
      yield* init.pipe(provideSetup(clone.layer));
      const name = yield* clone.jj("config", "get", "user.name");
      expect(name).toBe("renovate[bot]\n");
    }),
  );

  itEffect(
    "sets up the rest, and then fails on the part of an identity that neither jj nor git has",
    () =>
      Effect.gen(function* () {
        const repository = yield* scratchRepository;
        const clone = yield* gitClone(repository);
        yield* clone.git("config", "--unset", "user.email");
        const failure = yield* Effect.flip(init.pipe(provideSetup(clone.layer)));
        expect(failure).toStrictEqual(
          NotSetUp.make({
            message:
              "neither jj nor git has user.email; set it with `jj config set --user user.email`",
          }),
        );
        const name = yield* clone.jj("config", "get", "user.name");
        const alias = yield* clone.jj("config", "list", "--repo", "aliases.gh");
        expect([name, alias]).toStrictEqual([
          "Cloner\n",
          'aliases.gh = ["util","exec","--","jj-octo"]\n',
        ]);
      }),
  );

  itEffect("sets up the rest where origin can't be read, and then fails with git's error", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* clone.git("remote", "set-url", "origin", "/nonexistent");
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
      const alias = yield* clone.jj("config", "list", "--repo", "aliases.gh");
      expect(alias).toBe('aliases.gh = ["util","exec","--","jj-octo"]\n');
    }),
  );

  itEffect("fails where a config that overrides the repository's undoes a fix", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* init.pipe(provideSetup(clone.layer));
      yield* clone.jj("config", "set", "--workspace", 'revset-aliases."trunk()"', "root()");
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      const directory = yield* scratchDirectory("worktree-");
      const worktree = path.join(directory, "checkout");
      yield* clone.git("worktree", "add", "--detach", worktree);
      const failure = yield* Effect.flip(init.pipe(provideSetup(clone.layerAt(worktree))));
      expect(failure).toStrictEqual(
        NotSetUp.make({
          message:
            "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
        }),
      );
      const hasJj = yield* fs.exists(path.join(worktree, ".jj"));
      expect(hasJj).toBe(false);
    }),
  );

  itEffect("gives an author to the working copy of a repository colocated without one", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* clone.jj("git", "init", "--colocate");
      yield* clone.jj("commit", "-m", "work");
      yield* init.pipe(provideSetup(clone.layer));
      const authors = yield* clone.jj(
        "log",
        "--no-graph",
        "-r",
        "@ | @-",
        "-T",
        String.raw`author.email() ++ "\n"`,
      );
      expect(authors).toBe("cloner@example.com\ncloner@example.com\n");
    }),
  );

  itEffect("makes trunk() the default branch, fetching and tracking it", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      // Jj makes `trunk()` the default branch it finds when it colocates.
      yield* clone.jj("git", "init", "--colocate");
      yield* defaultToDevelop(repository);
      yield* init.pipe(provideSetup(clone.layer));
      const trunk = yield* clone.jj("config", "get", 'revset-aliases."trunk()"');
      const tracked = yield* clone.jj(
        "bookmark",
        "list",
        "--tracked",
        "-T",
        String.raw`name ++ "\n"`,
      );
      expect(trunk).toBe('"develop"@origin\n');
      expect(tracked).toContain("develop");
    }),
  );

  itEffect("makes trunk() a new default branch on the same commit as the old one", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* clone.jj("git", "init", "--colocate");
      yield* repository.jj("bookmark", "create", "develop", "-r", "main");
      yield* repository.jj("git", "push", "--bookmark", "develop");
      const url = yield* repository.git("remote", "get-url", "origin");
      const origin = EffectString.trim(url);
      yield* repository.git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/develop");
      yield* init.pipe(provideSetup(clone.layer));
      const trunk = yield* clone.jj("config", "get", 'revset-aliases."trunk()"');
      expect(trunk).toBe('"develop"@origin\n');
    }),
  );

  itEffect("changes nothing when run again", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      const clone = yield* gitClone(repository);
      yield* init.pipe(provideSetup(clone.layer));
      const operations = yield* clone.jj(
        "operation",
        "log",
        "--no-graph",
        "-T",
        String.raw`id ++ "\n"`,
      );
      yield* init.pipe(provideSetup(clone.layer));
      const after = yield* clone.jj("operation", "log", "--no-graph", "-T", String.raw`id ++ "\n"`);
      expect(after).toBe(operations);
    }),
  );
});

describe("checkTrunk", () => {
  itEffect("fails where trunk() isn't the default branch, until init sets it", () =>
    Effect.gen(function* () {
      const repository = yield* scratchRepository;
      yield* defaultToDevelop(repository);
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
