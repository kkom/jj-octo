import { afterAll, beforeEach, describe, expect } from "bun:test";

import { Effect, String as EffectString } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  rebaseOnGitHub,
  rewriteElsewhere,
} from "../../testing/branch-changes";
import { itEffect, provideSetup } from "../../testing/it-effect";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { editLocally, syncing } from "../../testing/sync";
import { stackChanges } from "./stack/changes";

afterAll(removeScratchRepositories);

// Rebases `a` onto a moved trunk on GitHub, and `b` onto the new `a`, with `b` edited locally.
const rebaseBoth = (repository: ScratchRepository): void => {
  repository.jj("edit", "b");
  repository.write("b-local.txt", "b, locally\n");
  repository.jj("new");
  repository.git("fetch", "--quiet");
  const pushedA = EffectString.trim(repository.git("rev-parse", "origin/a"));
  rebaseOnGitHub(repository, "a");
  repository.git("checkout", "--quiet", "-B", "b", "origin/b");
  repository.git("rebase", "--quiet", "--onto", "a", pushedA, "b");
  repository.git("push", "--quiet", "--force", "origin", "b");
};

describe("sync", () => {
  let repository: ScratchRepository;

  beforeEach(() => {
    repository = pushedStack("a", "b");
  });

  describe("when a branch changed on GitHub", () => {
    itEffect("folds a commit GitHub added into an untouched local change", () =>
      Effect.gen(function* () {
        addCommitOnGitHub(repository, "a");
        yield* syncing(repository);
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        expect(repository.files("a")).toEqual(["a.txt", "base.txt", "suggestion.txt"]);
      }),
    );

    itEffect("folds a commit GitHub added into a local change that was edited too", () =>
      Effect.gen(function* () {
        editLocally(repository);
        addCommitOnGitHub(repository, "a");
        yield* syncing(repository);
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        expect(repository.files("a")).toEqual(["a.txt", "base.txt", "local.txt", "suggestion.txt"]);
      }),
    );

    itEffect("folds commits GitHub added to two branches of one stack", () =>
      Effect.gen(function* () {
        addCommitOnGitHub(repository, "a", "for-a.txt");
        addCommitOnGitHub(repository, "b", "for-b.txt");
        yield* syncing(repository);
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        expect(repository.files("a")).toEqual(["a.txt", "base.txt", "for-a.txt"]);
        expect(repository.files("b")).toEqual([
          "a.txt",
          "b.txt",
          "base.txt",
          "for-a.txt",
          "for-b.txt",
        ]);
      }),
    );

    itEffect("takes a branch GitHub rebased where the local change is untouched", () =>
      Effect.gen(function* () {
        rebaseOnGitHub(repository, "a");
        yield* syncing(repository);
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        expect(repository.files("b")).toEqual(["a.txt", "b.txt", "base.txt", "trunk.txt"]);
      }),
    );

    // GitHub's copy of `b` sits on its copy of `a`, which must not go with the copies of `b`.
    describe("where GitHub rebased two branches", () => {
      itEffect("keeps the bookmark below", () =>
        Effect.gen(function* () {
          rebaseBoth(repository);
          yield* syncing(repository);
          expect(repository.log()).toEqual(["a [a]", "b [b]"]);
          expect(repository.files("b")).toEqual([
            "a.txt",
            "b-local.txt",
            "b.txt",
            "base.txt",
            "trunk.txt",
          ]);
        }),
      );

      itEffect("leaves no copy of GitHub's commits where both were edited locally", () =>
        Effect.gen(function* () {
          repository.jj("edit", "a");
          repository.write("a-local.txt", "a, locally\n");
          rebaseBoth(repository);
          yield* syncing(repository);
          expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        }),
      );
    });

    itEffect("keeps an edited local change where GitHub only rebased the branch", () =>
      Effect.gen(function* () {
        editLocally(repository);
        rebaseOnGitHub(repository, "a");
        yield* syncing(repository);
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        expect(repository.files("a")).toEqual(["a.txt", "base.txt", "local.txt", "trunk.txt"]);
      }),
    );

    // Another checkout's commits keep the ids of the local changes, so a change that isn't
    // combined has two commits with one id while its stack is rebased. A sync rebases a stack
    // and pushes nothing, so the local changes differ from the pushed ones without being edited.
    itEffect("fails after rebasing where another checkout rewrote changes a sync had rebased", () =>
      Effect.gen(function* () {
        moveTrunkOnGitHub(repository);
        yield* syncing(repository);
        rewriteElsewhere(repository, "a", "b");
        moveTrunkOnGitHub(repository, "later.txt");
        const failure = yield* Effect.flip(syncing(repository));
        expect(failure.message).toContain("weren't combined:\nb\na\n");
        expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "change_id")).toBe("");
        expect(repository.files("@")).toEqual([
          "a.txt",
          "b.txt",
          "base.txt",
          "later.txt",
          "trunk.txt",
        ]);
      }),
    );

    itEffect("fails after rebasing where both sides changed and GitHub rewrote the branch", () =>
      Effect.gen(function* () {
        editLocally(repository);
        rebaseOnGitHub(repository, "a", { extra: true });
        const failure = yield* Effect.flip(syncing(repository));
        expect(failure.message).toContain("weren't combined:\na\n");
        expect(repository.files("b")).toContain("trunk.txt");
        const check = yield* Effect.flip(stackChanges("@")).pipe(provideSetup(repository.layer));
        expect(check.message).toContain("point at two changes");
      }),
    );
  });
});
