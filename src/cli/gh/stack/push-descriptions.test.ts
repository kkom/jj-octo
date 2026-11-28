import { describe, expect } from "bun:test";

import { Array as EffectArray, Effect, Layer } from "effect";

import { withEnvironment } from "../../../testing/environment";
import { fakeGitHub, gitHubCalls, setUpPullRequestsABWithA } from "../../../testing/fake-github";
import { layer } from "../../../testing/it-effect";
import { pushedStack, ScratchRepository } from "../../../testing/scratch-repository";
import { describeAInParagraphs, submitting } from "../../../testing/submit";

layer(Layer.merge(pushedStack("a", "b"), fakeGitHub))("submit", (it) => {
  describe("descriptions", () => {
    it("sends a description changed locally to the pull request", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond");
        yield* submitting();
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual(["describe #1 as a better"]);
      }));

    it("sends a description changed locally and pushed without submit", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          describedA: yield* repository.description("a"),
        }).toStrictEqual({
          calls: ["describe #1 as a better"],
          describedA: "a better\n\nfirst\n\nsecond",
        });
      }));

    it("sends an upstack description pushed without submit, after taking a lower one from GitHub", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "b", "-m", "b better");
        yield* repository.jj("git", "push", "--bookmark", "b");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond, reworded");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          describedA: yield* repository.description("a"),
          describedB: yield* repository.description("b"),
        }).toStrictEqual({
          calls: ["describe #2 as b better"],
          describedA: "a\n\nfirst\n\nsecond, reworded",
          describedB: "b better",
        });
      }));

    it("sends a description changed again after a push without submit", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
        yield* repository.jj("describe", "-r", "a", "-m", "a best\n\nfirst\n\nsecond");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond");
        yield* submitting();
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual(["describe #1 as a best"]);
      }));

    it("takes GitHub's edit where its text came from a change squashed into this one", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("new", "main", "-m", "a\n\nfirst\n\nsecond, reworded");
        yield* repository.jj("squash", "--from", "@", "--into", "a", "--use-destination-message");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond, reworded");
        yield* submitting({ revision: "b" });
        expect({
          calls: yield* gitHubCalls,
          describedA: yield* repository.description("a"),
        }).toStrictEqual({ calls: [], describedA: "a\n\nfirst\n\nsecond, reworded" });
      }));

    it("writes a description changed on GitHub into the change", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* setUpPullRequestsABWithA("a", "first\r\n\r\nsecond, reworded");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          describedA: yield* repository.description("a"),
        }).toStrictEqual({ calls: [], describedA: "a\n\nfirst\n\nsecond, reworded" });
      }));

    it("writes the indent of a body's first line, set on GitHub, into the change", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* setUpPullRequestsABWithA("a", "    first\n\nsecond");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          describedA: yield* repository.description("a"),
        }).toStrictEqual({ calls: [], describedA: "a\n\n    first\n\nsecond" });
      }));

    describe("with the Claude Code proxy's footer on GitHub", () => {
      const footer = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_";

      it("takes the footer into the change by default", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* describeAInParagraphs;
          yield* setUpPullRequestsABWithA("a", `first\n\nsecond${footer}`);
          yield* submitting();
          expect({
            calls: yield* gitHubCalls,
            describedA: yield* repository.description("a"),
          }).toStrictEqual({ calls: [], describedA: `a\n\nfirst\n\nsecond${footer}` });
        }));

      it("leaves the change alone when told to ignore the footer", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* describeAInParagraphs;
          yield* repository.jj(
            "config",
            "set",
            "--repo",
            "jj-octo.ignore-claude-code-footer",
            "true",
          );
          yield* setUpPullRequestsABWithA("a", `first\n\nsecond${footer}`);
          yield* submitting();
          expect({
            calls: yield* gitHubCalls,
            describedA: yield* repository.description("a"),
          }).toStrictEqual({ calls: [], describedA: "a\n\nfirst\n\nsecond" });
        }));

      it("sends a description pushed without submit when told to ignore the footer", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* describeAInParagraphs;
          yield* repository.jj(
            "config",
            "set",
            "--repo",
            "jj-octo.ignore-claude-code-footer",
            "true",
          );
          yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
          yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
          yield* setUpPullRequestsABWithA("a", `first\n\nsecond${footer}`);
          yield* submitting();
          const calls = yield* gitHubCalls;
          expect(calls).toStrictEqual(["describe #1 as a better"]);
        }));

      it("leaves the change alone by default in a Claude Code cloud session", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* describeAInParagraphs;
          yield* setUpPullRequestsABWithA("a", `first\n\nsecond${footer}`);
          yield* submitting().pipe(withEnvironment({ CLAUDE_CODE_REMOTE: "true" }));
          expect({
            calls: yield* gitHubCalls,
            describedA: yield* repository.description("a"),
          }).toStrictEqual({ calls: [], describedA: "a\n\nfirst\n\nsecond" });
        }));

      it("takes the footer into the change in a cloud session when told not to ignore it", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* describeAInParagraphs;
          yield* repository.jj(
            "config",
            "set",
            "--repo",
            "jj-octo.ignore-claude-code-footer",
            "false",
          );
          yield* setUpPullRequestsABWithA("a", `first\n\nsecond${footer}`);
          yield* submitting().pipe(withEnvironment({ CLAUDE_CODE_REMOTE: "true" }));
          expect({
            calls: yield* gitHubCalls,
            describedA: yield* repository.description("a"),
          }).toStrictEqual({ calls: [], describedA: `a\n\nfirst\n\nsecond${footer}` });
        }));

      it("fails for a value of the setting other than true or false", () =>
        Effect.gen(function* () {
          const repository = yield* ScratchRepository;
          yield* describeAInParagraphs;
          yield* repository.jj(
            "config",
            "set",
            "--repo",
            "jj-octo.ignore-claude-code-footer",
            "yes",
          );
          yield* setUpPullRequestsABWithA("a", `first\n\nsecond${footer}`);
          const failure = yield* Effect.flip(submitting());
          expect({ calls: yield* gitHubCalls, message: failure.message }).toStrictEqual({
            calls: [],
            message: 'jj-octo.ignore-claude-code-footer is "yes"; set it to true or false',
          });
        }));
    });

    it("merges edits made to different lines on both sides", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        yield* setUpPullRequestsABWithA("a", "first\n\nsecond, reworded");
        yield* submitting();
        expect({
          calls: yield* gitHubCalls,
          describedA: yield* repository.description("a"),
        }).toStrictEqual({
          calls: ["describe #1 as a better"],
          describedA: "a better\n\nfirst\n\nsecond, reworded",
        });
      }));

    it("stops before changing GitHub where both sides edited the same line", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "a", "-m", "a, locally\n\nfirst\n\nsecond");
        yield* setUpPullRequestsABWithA("a, on GitHub", "first\n\nsecond");
        const branches = yield* repository.branches;
        const failure = yield* Effect.flip(submitting());
        expect({
          branches: yield* repository.branches,
          calls: yield* gitHubCalls,
          message: failure.message,
        }).toStrictEqual({
          branches,
          calls: [],
          message: EffectArray.join(
            [
              "the description of a changed here and in #1, in the same lines:",
              "",
              "<<<<<<< local",
              "a, locally",
              "=======",
              "a, on GitHub",
              ">>>>>>> GitHub",
              "",
              "first",
              "",
              "second",
              "",
              "Write the one to keep with `jj describe -r a`, then run `jj gh submit --overwrite-descriptions`.",
            ],
            "\n",
          ),
        });
      }));

    it("sends the local description over a conflicting one when told to", () =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        yield* describeAInParagraphs;
        yield* repository.jj("describe", "-r", "a", "-m", "a, locally\n\nfirst\n\nsecond");
        yield* setUpPullRequestsABWithA("a, on GitHub", "first\n\nsecond");
        yield* submitting({ overwriteDescriptions: true });
        const calls = yield* gitHubCalls;
        expect(calls).toStrictEqual(["describe #1 as a, locally"]);
      }));
  });
});
