import { describe, expect } from "bun:test";

import { Array as EffectArray, Effect, Layer, String as EffectString } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  rebaseOnGitHub,
  rewriteElsewhere,
} from "../../testing/branch-changes";
import { fakeGitHub } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { pushedStack, ScratchRepository } from "../../testing/scratch-repository";
import { editLocally, syncing } from "../../testing/sync";
import { stackChanges } from "./stack/changes";

// Rebases `a` onto a moved trunk on GitHub, and `b` onto the new `a`, with `b` edited locally.
const rebaseBoth: Effect.Effect<void, never, ScratchRepository> = Effect.gen(function* () {
  const repository = yield* ScratchRepository;
  yield* repository.jj("edit", "b");
  yield* repository.write("b-local.txt", "b, locally\n");
  yield* repository.jj("new");
  yield* repository.git("fetch", "--quiet");
  const revision = yield* repository.git("rev-parse", "origin/a");
  const pushedA = EffectString.trim(revision);
  yield* rebaseOnGitHub("a");
  yield* repository.git("checkout", "--quiet", "-B", "b", "origin/b");
  yield* repository.git("rebase", "--quiet", "--onto", "a", pushedA, "b");
  yield* repository.git("push", "--quiet", "--force", "origin", "b");
});

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))("sync", (it) => {
  describe("when a branch changed on GitHub", () => {
    it("folds a commit GitHub added into an untouched local change", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addCommitOnGitHub("a");
        yield* syncing();
        expect({ files: yield* repository.files("a"), log: yield* repository.log }).toStrictEqual({
          files: ["a.txt", "base.txt", "suggestion.txt"],
          log: ["a [a]", "b [b]"],
        });
      }));

    it("folds a commit GitHub added into a local change that was edited too", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* editLocally;
        yield* addCommitOnGitHub("a");
        yield* syncing();
        expect({ files: yield* repository.files("a"), log: yield* repository.log }).toStrictEqual({
          files: ["a.txt", "base.txt", "local.txt", "suggestion.txt"],
          log: ["a [a]", "b [b]"],
        });
      }));

    it("folds commits GitHub added to two branches of one stack", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* addCommitOnGitHub("a", "for-a.txt");
        yield* addCommitOnGitHub("b", "for-b.txt");
        yield* syncing();
        expect({
          filesOfA: yield* repository.files("a"),
          filesOfB: yield* repository.files("b"),
          log: yield* repository.log,
        }).toStrictEqual({
          filesOfA: ["a.txt", "base.txt", "for-a.txt"],
          filesOfB: ["a.txt", "b.txt", "base.txt", "for-a.txt", "for-b.txt"],
          log: ["a [a]", "b [b]"],
        });
      }));

    it("takes a branch GitHub rebased where the local change is untouched", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* rebaseOnGitHub("a");
        yield* syncing();
        expect({ files: yield* repository.files("b"), log: yield* repository.log }).toStrictEqual({
          files: ["a.txt", "b.txt", "base.txt", "trunk.txt"],
          log: ["a [a]", "b [b]"],
        });
      }));

    // GitHub's copy of `b` sits on its copy of `a`, which must not go with the copies of `b`.
    describe("where GitHub rebased two branches", () => {
      it("keeps the bookmark below", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* rebaseBoth;
          yield* syncing();
          expect({ files: yield* repository.files("b"), log: yield* repository.log }).toStrictEqual(
            {
              files: ["a.txt", "b-local.txt", "b.txt", "base.txt", "trunk.txt"],
              log: ["a [a]", "b [b]"],
            },
          );
        }));

      it("leaves no copy of GitHub's commits where both were edited locally", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* repository.jj("edit", "a");
          yield* repository.write("a-local.txt", "a, locally\n");
          yield* rebaseBoth;
          yield* syncing();
          const log = yield* repository.log;
          expect(log).toStrictEqual(["a [a]", "b [b]"]);
        }));
    });

    it("keeps an edited local change where GitHub only rebased the branch", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* editLocally;
        yield* rebaseOnGitHub("a");
        yield* syncing();
        expect({ files: yield* repository.files("a"), log: yield* repository.log }).toStrictEqual({
          files: ["a.txt", "base.txt", "local.txt", "trunk.txt"],
          log: ["a [a]", "b [b]"],
        });
      }));

    // Another checkout's commits keep the ids of the local changes, so a change that isn't
    // combined has two commits with one id while its stack is rebased. A sync rebases a stack
    // and pushes nothing, so the local changes differ from the pushed ones without being edited.
    it("fails after rebasing where another checkout rewrote changes a sync had rebased", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* moveTrunkOnGitHub();
        yield* syncing();
        yield* rewriteElsewhere("a", "b");
        yield* moveTrunkOnGitHub("later.txt");
        const failure = yield* Effect.flip(syncing());
        expect({
          conflicted: yield* repository.conflicted,
          files: yield* repository.files("@"),
          message: failure.message,
        }).toStrictEqual({
          conflicted: "",
          files: ["a.txt", "b.txt", "base.txt", "later.txt", "trunk.txt"],
          message: EffectArray.join(
            [
              "these bookmarks changed locally and were rewritten on GitHub with different content, so they weren't combined:",
              "b",
              "a",
              "`jj bookmark list <name>` shows both sides, and `jj bookmark set <name> -r <revision>` keeps one",
            ],
            "\n",
          ),
        });
      }));

    it("fails after rebasing where both sides changed and GitHub rewrote the branch", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* editLocally;
        yield* rebaseOnGitHub("a", { extra: true });
        const failure = yield* Effect.flip(syncing());
        const check = yield* Effect.flip(stackChanges("@"));
        expect({
          check: check.message,
          files: yield* repository.files("b"),
          message: failure.message,
        }).toStrictEqual({
          check: EffectArray.join(
            [
              "these bookmarks point at two changes, one local and one from GitHub; keep one with `jj bookmark set <name> -r <revision>`:",
              "a",
            ],
            "\n",
          ),
          files: ["a.txt", "b.txt", "base.txt", "local.txt", "trunk.txt"],
          message: EffectArray.join(
            [
              "these bookmarks changed locally and were rewritten on GitHub with different content, so they weren't combined:",
              "a",
              "`jj bookmark list <name>` shows both sides, and `jj bookmark set <name> -r <revision>` keeps one",
            ],
            "\n",
          ),
        });
      }));
  });
});
