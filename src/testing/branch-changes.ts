import { Array as EffectArray, Effect, String as EffectString } from "effect";

import type { ScratchRepository } from "./scratch-repository";

// What GitHub does to branches by itself, done in the clone and pushed to `origin`.

/** Adds a commit to a branch, as applying a review suggestion does. */
export const addCommitOnGitHub = (
  repository: ScratchRepository,
  branch: string,
  file = "suggestion.txt",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* repository.git("fetch", "--quiet");
    yield* repository.git("checkout", "--quiet", "-B", branch, `origin/${branch}`);
    yield* repository.writeOnGitHub(file, "suggestion\n");
    yield* repository.git("add", ".");
    yield* repository.git("commit", "--quiet", "-m", "apply a suggestion");
    yield* repository.git("push", "--quiet", "origin", branch);
  });

/** Adds a commit to `main`. */
export const moveTrunkOnGitHub = (
  repository: ScratchRepository,
  file = "trunk.txt",
): Effect.Effect<void> =>
  Effect.gen(function* () {
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
  repository: ScratchRepository,
  branch: string,
  { extra = false }: { readonly extra?: boolean } = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* moveTrunkOnGitHub(repository);
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
  repository: ScratchRepository,
  ...branches: readonly string[]
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* repository.elsewhere("git", "fetch");
    for (const branch of branches) {
      yield* repository.elsewhere("bookmark", "track", `${branch}@origin`);
    }
    for (const branch of branches) {
      yield* repository.elsewhere("edit", branch);
      yield* repository.writeElsewhere(`${branch}-elsewhere.txt`, "elsewhere\n");
    }
    yield* repository.elsewhere(
      "git",
      "push",
      ...EffectArray.flatMap(branches, (branch) => ["--bookmark", branch]),
    );
  });

/**
 * Squash-merges a branch into `into`, `main` by default, as one commit, together with the
 * branches `below` it, as GitHub's stack merge does. Records each one's pull request as merged, and with `deleted` also
 * deletes the branches. Rebases the branches `above` it onto the new `into` in order, as GitHub
 * does for the rest of a stack.
 */
export const squashMergeOnGitHub = (
  repository: ScratchRepository,
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
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* repository.git("fetch", "--quiet");
    yield* repository.git("checkout", "--quiet", "-B", into, `origin/${into}`);
    yield* repository.git("merge", "--quiet", "--squash", `origin/${branch}`);
    yield* repository.git("commit", "--quiet", "-m", `${branch} (#1)`);
    yield* repository.git("push", "--quiet", "origin", into);
    for (const name of [...below, branch]) {
      const head = yield* repository.git("rev-parse", `origin/${name}`);
      repository.mergedOnGitHub(name, EffectString.trim(head));
    }
    const top = yield* repository.git("rev-parse", `origin/${branch}`);
    let previous = EffectString.trim(top);
    let base = into;
    for (const name of above) {
      const head = yield* repository.git("rev-parse", `origin/${name}`);
      const pushed = EffectString.trim(head);
      yield* repository.git("checkout", "--quiet", "-B", name, pushed);
      yield* repository.git("rebase", "--quiet", "--onto", base, previous, name);
      yield* repository.git("push", "--quiet", "--force", "origin", name);
      previous = pushed;
      base = name;
    }
    if (deleted) {
      yield* repository.git("push", "--quiet", "origin", "--delete", ...below, branch);
    }
  });
