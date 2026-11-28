import { Array as EffectArray, Effect, String as EffectString } from "effect";

import { FakeGitHub } from "./fake-github";
import { ScratchRepository } from "./scratch-repository";

// What GitHub does to branches by itself, done in the worktree of `origin`.

/**
 * Detaches `HEAD` at a branch, runs `work`, then points the branch at `HEAD`. `HEAD` stays
 * detached, since git rejects a push to a branch that a worktree has checked out.
 */
export const changeOnGitHub = <A, E, R>(
  branch: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* repository.git("checkout", "--quiet", "--detach", branch);
    const result = yield* work;
    yield* repository.git("update-ref", `refs/heads/${branch}`, "HEAD");
    return result;
  });

/** Adds a commit with the file to a branch, as applying a review suggestion does. */
export const addCommitOnGitHub = (
  branch: string,
  file = "suggestion.txt",
): Effect.Effect<void, never, ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* changeOnGitHub(
      branch,
      Effect.gen(function* () {
        yield* repository.writeOnGitHub(file, `${file}\n`);
        yield* repository.git("add", ".");
        yield* repository.git("commit", "--quiet", "-m", `add ${file}`);
      }),
    );
  });

/** Adds a commit with the file to `main`. */
export const moveTrunkOnGitHub = (
  file = "trunk.txt",
): Effect.Effect<void, never, ScratchRepository> => addCommitOnGitHub("main", file);

/**
 * Moves `main`, then rebases a branch onto it, as the "Update branch" button does. With `extra`,
 * also adds a new file to the rewritten commit.
 */
export const rebaseOnGitHub = (
  branch: string,
  { extra = false }: { readonly extra?: boolean } = {},
): Effect.Effect<void, never, ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* moveTrunkOnGitHub();
    yield* changeOnGitHub(
      branch,
      Effect.gen(function* () {
        yield* repository.git("rebase", "--quiet", "main");
        if (extra) {
          yield* repository.writeOnGitHub("extra.txt", "extra\n");
          yield* repository.git("add", ".");
          yield* repository.git("commit", "--quiet", "--amend", "--no-edit");
        }
      }),
    );
  });

/**
 * Adds a file to each branch's change in another jj checkout, and force-pushes them. Unlike a
 * rewrite by GitHub, the commits keep the local changes' ids.
 */
export const rewriteElsewhere = (
  ...branches: readonly string[]
): Effect.Effect<void, never, ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* repository.elsewhere("git", "fetch");
    yield* Effect.forEach(
      branches,
      (branch) => repository.elsewhere("bookmark", "track", `${branch}@origin`),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      branches,
      (branch) =>
        repository
          .elsewhere("edit", branch)
          .pipe(
            Effect.andThen(repository.writeElsewhere(`${branch}-elsewhere.txt`, "elsewhere\n")),
          ),
      { concurrency: 1, discard: true },
    );
    yield* repository.elsewhere(
      "git",
      "push",
      ...EffectArray.flatMap(branches, (branch) => ["--bookmark", branch]),
    );
  });

/**
 * Squash-merges a branch and the branches `below` it into `into` as one commit, as GitHub's stack
 * merge does, and records their pull requests as merged. With `deleted`, deletes the branches.
 * Rebases the branches `above` onto the new `into` in order, as GitHub does for the rest.
 */
export const squashMergeOnGitHub = (
  branch: string,
  {
    above = [],
    below = [],
    deleted = true,
    into = "main",
  }: {
    readonly above?: readonly string[];
    readonly below?: readonly string[];
    readonly deleted?: boolean;
    readonly into?: string;
  } = {},
): Effect.Effect<void, never, FakeGitHub | ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    const github = yield* FakeGitHub;
    const headOf = (name: string) =>
      Effect.map(repository.git("rev-parse", name), EffectString.trim);
    const record = (name: string) =>
      Effect.flatMap(headOf(name), (head) =>
        github.recordMerge({ branch: name, deleted, head, into }),
      );
    yield* Effect.forEach(below, record, { concurrency: 1, discard: true });
    // GitHub titles the squash commit with the pull request's title and number.
    const pullRequest = yield* record(branch);
    yield* changeOnGitHub(
      into,
      Effect.gen(function* () {
        yield* repository.git("merge", "--quiet", "--squash", branch);
        yield* repository.git(
          "commit",
          "--quiet",
          "-m",
          `${pullRequest.title} (#${pullRequest.number})`,
        );
      }),
    );
    // Each branch above moves onto the one rebased before it, leaving the old commits of the
    // branch below behind.
    const top = yield* headOf(branch);
    yield* Effect.reduce(
      above,
      () => ({ base: into, previous: top }),
      ({ base, previous }, name) =>
        Effect.gen(function* () {
          const pushed = yield* headOf(name);
          yield* changeOnGitHub(
            name,
            repository.git("rebase", "--quiet", "--onto", base, previous),
          );
          return { base: name, previous: pushed };
        }),
    );
    if (deleted) {
      yield* repository.git("branch", "--quiet", "--delete", "--force", ...below, branch);
    }
  });
