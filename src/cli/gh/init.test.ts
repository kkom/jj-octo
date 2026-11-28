import { expect } from "bun:test";

import { Array as EffectArray, Effect, FileSystem, Path } from "effect";

import { addWorktree, GitClone, gitClone } from "../../testing/git-clone";
import { layer } from "../../testing/it-effect";
import { ScratchRepository, scratchRepository } from "../../testing/scratch-repository";
import { init } from "./init";
import { NotSetUp } from "./setup";
import { checkTrunk } from "./stack/trunk";

/** Pushes a `develop` branch, and makes it `origin`'s default branch. */
const defaultToDevelop: Effect.Effect<void, never, ScratchRepository> = Effect.gen(function* () {
  const repository = yield* ScratchRepository;
  yield* repository.jj("new", "main", "-m", "develop");
  yield* repository.write("develop.txt", "develop\n");
  yield* repository.jj("bookmark", "create", "develop", "-r", "@");
  yield* repository.jj("git", "push", "--bookmark", "develop");
  yield* repository.git(
    "--git-dir",
    repository.origin,
    "symbolic-ref",
    "HEAD",
    "refs/heads/develop",
  );
});

layer(gitClone())("init", (it) => {
  it("colocates a git clone, and copies git's identity into jj", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* init;
      const name = yield* clone.jj("config", "get", "user.name");
      const email = yield* clone.jj("config", "get", "user.email");
      const author = yield* clone.jj("log", "--no-graph", "-r", "@", "-T", "author.email()");
      const alias = yield* clone.jj("config", "get", "aliases.gh");
      expect(name).toBe("Cloner\n");
      expect(email).toBe("cloner@example.com\n");
      expect(author).toBe("cloner@example.com");
      expect(alias).toContain("jj-octo");
    }));

  it("keeps a `jj gh` alias that runs another build", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* clone.jj("git", "init", "--colocate");
      yield* clone.jj(
        "config",
        "set",
        "--repo",
        "aliases.gh",
        '["util", "exec", "--", "bun", "main.ts"]',
      );
      yield* init;
      const alias = yield* clone.jj("config", "get", "aliases.gh");
      expect(alias).toBe('["util", "exec", "--", "bun", "main.ts"]\n');
    }));

  it("sets the repository's `jj gh` alias where only the user's config has one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clone = yield* GitClone;
      yield* fs.writeFileString(clone.jjConfigFile, 'aliases.gh = ["gh"]\n');
      yield* init;
      const alias = yield* clone.jj("config", "list", "--repo", "aliases.gh");
      expect(alias).toBe('aliases.gh = ["util","exec","--","jj-octo"]\n');
    }));

  it("sets up the rest, and then fails on the part of an identity that neither jj nor git has", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* clone.git("config", "--unset", "user.email");
      const failure = yield* Effect.flip(init);
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
    }));

  it("sets up the rest where origin can't be read, and then fails with git's error", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* clone.git("remote", "set-url", "origin", "/nonexistent");
      const failure = yield* Effect.flip(init);
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
    }));

  it("fails where a config that overrides the repository's undoes a fix", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* init;
      yield* clone.jj("config", "set", "--workspace", 'revset-aliases."trunk()"', "root()");
      const failure = yield* Effect.flip(init);
      expect(failure).toStrictEqual(
        NotSetUp.make({
          message:
            "trunk() isn't main@origin, GitHub's default branch, fetched and tracked, though init set it up",
        }),
      );
    }));

  it("leaves a git worktree as it is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const clone = yield* GitClone;
      const worktree = yield* addWorktree;
      const clients = yield* clone.clientsIn(worktree);
      const failure = yield* Effect.flip(init.pipe(Effect.provide(clients)));
      expect(failure).toStrictEqual(
        NotSetUp.make({
          message:
            "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
        }),
      );
      const hasJj = yield* fs.exists(path.join(worktree, ".jj"));
      expect(hasJj).toBe(false);
    }));

  it("gives an author to the working copy of a repository colocated without one", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* clone.jj("git", "init", "--colocate");
      yield* clone.jj("commit", "-m", "work");
      yield* init;
      const authors = yield* clone.jj(
        "log",
        "--no-graph",
        "-r",
        "@ | @-",
        "-T",
        String.raw`author.email() ++ "\n"`,
      );
      expect(authors).toBe("cloner@example.com\ncloner@example.com\n");
    }));

  it("makes trunk() the default branch, fetching and tracking it", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      // Jj makes `trunk()` the default branch it finds when it colocates.
      yield* clone.jj("git", "init", "--colocate");
      yield* defaultToDevelop;
      yield* init;
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
    }));

  it("makes trunk() a new default branch on the same commit as the old one", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      const clone = yield* GitClone;
      yield* clone.jj("git", "init", "--colocate");
      yield* repository.jj("bookmark", "create", "develop", "-r", "main");
      yield* repository.jj("git", "push", "--bookmark", "develop");
      yield* repository.git(
        "--git-dir",
        repository.origin,
        "symbolic-ref",
        "HEAD",
        "refs/heads/develop",
      );
      yield* init;
      const trunk = yield* clone.jj("config", "get", 'revset-aliases."trunk()"');
      expect(trunk).toBe('"develop"@origin\n');
    }));

  it("changes nothing when run again", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* init;
      const operations = yield* clone.jj(
        "operation",
        "log",
        "--no-graph",
        "-T",
        String.raw`id ++ "\n"`,
      );
      yield* init;
      const after = yield* clone.jj("operation", "log", "--no-graph", "-T", String.raw`id ++ "\n"`);
      expect(after).toBe(operations);
    }));
});

layer(gitClone("renovate[bot]"))("init, with a bot's name", (it) => {
  it("copies a name that isn't a bare TOML value, such as a bot's", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* init;
      const name = yield* clone.jj("config", "get", "user.name");
      expect(name).toBe("renovate[bot]\n");
    }));
});

layer(scratchRepository)("checkTrunk", (it) => {
  it("fails where trunk() isn't the default branch, until init sets it", () =>
    Effect.gen(function* () {
      yield* defaultToDevelop;
      const check = checkTrunk("develop");
      const failure = yield* Effect.flip(check);
      expect(failure.message).toBe(
        "trunk() isn't develop@origin, GitHub's default branch; run `jj-octo init`",
      );
      yield* init;
      yield* check;
    }));
});
