import { Array as EffectArray, Effect, String as EffectString } from "effect";

import { FakeGitHub } from "./fake-github";
import { ScratchRepository } from "./scratch-repository";

// What GitHub does to branches by itself, done in the clone and pushed to `origin`.

/** Adds a commit to a branch, as applying a review suggestion does. */
export const addCommitOnGitHub = (
  branch: string,
  file = "suggestion.txt",
): Effect.Effect<void, never, ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* repository.git("fetch", "--quiet");
    yield* repository.git("checkout", "--quiet", "-B", branch, `origin/${branch}`);
    yield* repository.writeOnGitHub(file, "suggestion\n");
    yield* repository.git("add", ".");
    yield* repository.git("commit", "--quiet", "-m", "apply a suggestion");
    yield* repository.git("push", "--quiet", "origin", branch);
  });

/** Adds a commit to `main`. */
export const moveTrunkOnGitHub = (
  file = "trunk.txt",
): Effect.Effect<void, never, ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* repository.git("fetch", "--quiet");
    yield* repository.git("checkout", "--quiet", "-B", "main", "origin/main");
    yield* repository.writeOnGitHub(file, "trunk\n");
    yield* repository.git("add", ".");
    yield* repository.git("commit", "--quiet", "-m", "trunk moves");
    yield* repository.git("push", "--quiet", "origin", "main");
  });

/**
 * Moves `main`, then rebases a branch onto it and force-pushes it, as the "Update branch" button
 * does. With `extra`, the rewritten commit also gets a file the branch didn't have.
 */
export const rebaseOnGitHub = (
  branch: string,
  { extra = false }: { readonly extra?: boolean } = {},
): Effect.Effect<void, never, ScratchRepository> =>
  Effect.gen(function* () {
    const repository = yield* ScratchRepository;
    yield* moveTrunkOnGitHub();
    yield* repository.git("checkout", "--quiet", "-B", branch, `origin/${branch}`);
    yield* repository.git("rebase", "--quiet", "main");
    if (extra) {
      yield* repository.writeOnGitHub("extra.txt", "extra\n");
      yield* repository.git("add", ".");
      yield* repository.git("commit", "--quiet", "--amend", "--no-edit");
    }
    yield* repository.git("push", "--quiet", "--force", "origin", branch);
  });

/**
 * Adds a file to the change of each branch in another jj checkout, and force-pushes them. Unlike
 * a rewrite by GitHub, the rewritten commits keep the ids of the local changes.
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
 * Squash-merges a branch into `into`, `main` by default, as one commit, together with the
 * branches `below` it, as GitHub's stack merge does. Records each one's pull request as merged on
 * the fake GitHub, and dies where one has none. With `deleted`, also deletes the branches. Rebases
 * the branches `above` it onto the new `into` in order, as GitHub does for the rest of a stack.
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
      Effect.map(repository.git("rev-parse", `origin/${name}`), EffectString.trim);
    yield* repository.git("fetch", "--quiet");
    const record = (name: string) =>
      Effect.flatMap(headOf(name), (head) =>
        github.recordMerge({ branch: name, deleted, head, into }),
      );
    yield* Effect.forEach(below, record, { concurrency: 1, discard: true });
    // GitHub titles the squash commit with the pull request's title and number.
    const pullRequest = yield* record(branch);
    yield* repository.git("checkout", "--quiet", "-B", into, `origin/${into}`);
    yield* repository.git("merge", "--quiet", "--squash", `origin/${branch}`);
    yield* repository.git(
      "commit",
      "--quiet",
      "-m",
      `${pullRequest.title} (#${pullRequest.number})`,
    );
    yield* repository.git("push", "--quiet", "origin", into);
    // Each branch above moves onto the one rebased before it, and leaves the commits of the
    // branch below it behind.
    const top = yield* headOf(branch);
    yield* Effect.reduce(
      above,
      () => ({ base: into, previous: top }),
      ({ base, previous }, name) =>
        Effect.gen(function* () {
          const pushed = yield* headOf(name);
          yield* repository.git("checkout", "--quiet", "-B", name, pushed);
          yield* repository.git("rebase", "--quiet", "--onto", base, previous, name);
          yield* repository.git("push", "--quiet", "--force", "origin", name);
          return { base: name, previous: pushed };
        }),
    );
    if (deleted) {
      yield* repository.git("push", "--quiet", "origin", "--delete", ...below, branch);
    }
  });
