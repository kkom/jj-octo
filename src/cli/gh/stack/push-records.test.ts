import { expect } from "bun:test";

import { Effect, Layer } from "effect";

import { PullRequestNumberSchema } from "../../../clients/github/types";
import { PrDescriptions } from "../../../clients/pr-descriptions";
import { fakeGitHub, gitHubCalls, setUpPullRequestsABWithA } from "../../../testing/fake-github";
import { layer } from "../../../testing/it-effect";
import { pushedStack, ScratchRepository } from "../../../testing/scratch-repository";
import { describeAInParagraphs, submitting } from "../../../testing/submit";

// Records that GitHub and the change agreed on `a`'s description in paragraphs.
const recordAgreed = Effect.gen(function* () {
  const repository = yield* ScratchRepository;
  const store = yield* PrDescriptions;
  const commit = yield* repository.commitOf("a");
  const pullRequest = PullRequestNumberSchema.make(1);
  yield* store.write({ bookmark: "a", commit, description: "a\n\nfirst\n\nsecond", pullRequest });
});

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))(
  "submit, with the recorded descriptions",
  (it) => {
    // The calls hold the first submit's too, which sends nothing.
    it("merges a GitHub edit with a local edit pushed without submit, from the recorded description", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond");
        yield* submitting();
        yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        yield* repository.jj("git", "push", "--bookmark", "a");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond, reworded");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          described: yield* repository.description("a"),
        }).toStrictEqual({
          calls: ["describe #1 as a better"],
          described: "a better\n\nfirst\n\nsecond, reworded",
        });
      }));

    it("merges edits on both sides against the record of the commit the change was made from", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* recordAgreed;
        yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        yield* repository.jj("git", "push", "--bookmark", "a");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond, reworded");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          described: yield* repository.description("a"),
        }).toStrictEqual({
          calls: ["describe #1 as a better"],
          described: "a better\n\nfirst\n\nsecond, reworded",
        });
      }));

    it("ignores a record of a commit that another clone's push replaced", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* recordAgreed;
        yield* repository.elsewhere("git", "fetch");
        yield* repository.elsewhere("bookmark", "track", "a@origin", "b@origin");
        yield* repository.elsewhere("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, elsewhere");
        yield* repository.elsewhere("git", "push", "--bookmark", "a");
        yield* repository.jj("git", "fetch");
        yield* repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, here");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond, elsewhere");
        yield* submitting({ revision: "b" });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual(["describe #1 as a"]);
      }));

    it("reads against a pushed description that GitHub took after the record", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* recordAgreed;
        yield* repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, two");
        yield* repository.jj("git", "push", "--bookmark", "a");
        // Another clone submitted the push, which sent its description to GitHub.
        yield* repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, three");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond, two");
        yield* submitting();
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual(["describe #1 as a"]);
      }));

    // The calls hold the first submit's too, which sends the local description.
    it("takes a description set back on GitHub to one the change had", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond");
        yield* submitting();
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          described: yield* repository.description("a"),
        }).toStrictEqual({ calls: ["describe #1 as a better"], described: "a\n\nfirst\n\nsecond" });
      }));
  },
);
