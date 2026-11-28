import { afterAll, describe, expect } from "bun:test";

import { Effect } from "effect";

import { PullRequestNumberSchema } from "../../../clients/github/types";
import { itEffect } from "../../../testing/it-effect";
import { removeScratchRepositories } from "../../../testing/scratch-repository";
import { description, githubWith, pushed, submitIn } from "../../../testing/submit";

afterAll(removeScratchRepositories);

describe("submit, with the recorded descriptions", () => {
  itEffect(
    "merges a GitHub edit with a local edit pushed without submit, from the recorded description",
    () =>
      Effect.gen(function* () {
        const repository = pushed();
        yield* submitIn(repository, githubWith("a", "first\n\nsecond"));
        repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        repository.jj("git", "push", "--bookmark", "a");
        const github = githubWith("a", "first\n\nsecond, reworded");
        yield* submitIn(repository, github);
        expect(description(repository, "a")).toBe("a better\n\nfirst\n\nsecond, reworded");
        expect(github.calls).toEqual(["describe #1 as a better"]);
      }),
  );

  itEffect(
    "merges edits on both sides against the record of the commit the change was made from",
    () =>
      Effect.gen(function* () {
        const repository = pushed();
        const commit = repository.commitOf("a");
        const pullRequest = PullRequestNumberSchema.make(1);
        const agreed = { bookmark: "a", commit, description: "a\n\nfirst\n\nsecond", pullRequest };
        yield* repository.records((store) => store.write(agreed));
        repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        repository.jj("git", "push", "--bookmark", "a");
        const github = githubWith("a", "first\n\nsecond, reworded");
        yield* submitIn(repository, github);
        expect(description(repository, "a")).toBe("a better\n\nfirst\n\nsecond, reworded");
        expect(github.calls).toEqual(["describe #1 as a better"]);
      }),
  );

  itEffect("ignores a record of a commit that another clone's push replaced", () =>
    Effect.gen(function* () {
      const repository = pushed();
      const commit = repository.commitOf("a");
      const pullRequest = PullRequestNumberSchema.make(1);
      const agreed = { bookmark: "a", commit, description: "a\n\nfirst\n\nsecond", pullRequest };
      yield* repository.records((store) => store.write(agreed));
      repository.elsewhere("git", "fetch");
      repository.elsewhere("bookmark", "track", "a@origin", "b@origin");
      repository.elsewhere("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, elsewhere");
      repository.elsewhere("git", "push", "--bookmark", "a");
      repository.jj("git", "fetch");
      repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, here");
      const github = githubWith("a", "first\n\nsecond, elsewhere");
      yield* submitIn(repository, github, { revision: "b" });
      expect(github.calls).toEqual(["describe #1 as a"]);
    }),
  );

  itEffect("reads against a pushed description that GitHub took after the record", () =>
    Effect.gen(function* () {
      const repository = pushed();
      const commit = repository.commitOf("a");
      const pullRequest = PullRequestNumberSchema.make(1);
      const agreed = { bookmark: "a", commit, description: "a\n\nfirst\n\nsecond", pullRequest };
      yield* repository.records((store) => store.write(agreed));
      repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, two");
      repository.jj("git", "push", "--bookmark", "a");
      // Another clone submitted the push, which sent its description to GitHub.
      repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, three");
      const github = githubWith("a", "first\n\nsecond, two");
      yield* submitIn(repository, github);
      expect(github.calls).toEqual(["describe #1 as a"]);
    }),
  );

  itEffect("takes a description set back on GitHub to one the change had", () =>
    Effect.gen(function* () {
      const repository = pushed();
      repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
      yield* submitIn(repository, githubWith("a", "first\n\nsecond"));
      const github = githubWith("a", "first\n\nsecond");
      yield* submitIn(repository, github);
      expect(description(repository, "a")).toBe("a\n\nfirst\n\nsecond");
      expect(github.calls).toEqual([]);
    }),
  );
});
