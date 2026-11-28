import { expect } from "bun:test";

import { Array as EffectArray, Context, Effect, Exit, Layer, Ref } from "effect";
import { TestConsole } from "effect/testing";

import {
  Clipboard,
  ClipboardFailed,
  type ClipboardWrite,
  type RichText,
} from "../../clients/clipboard";
import type { ListedPullRequest } from "../../clients/github/types";
import { conflictWithTrunk } from "../../testing/conflicts";
import { fakeGitHub, setUpGitHub } from "../../testing/fake-github";
import { layer } from "../../testing/it-effect";
import { inStack, linked } from "../../testing/links";
import { pullRequest } from "../../testing/pull-requests";
import { ScratchRepository, scratchRepository } from "../../testing/scratch-repository";
import { htmlLinks, links, markdownLinks, NoPullRequests, stackPullRequests } from "./links";

// A clipboard that keeps the content of each write, and answers it as `answer` last set, `copied`
// by default.
class FakeClipboard extends Context.Service<
  FakeClipboard,
  {
    readonly answer: (write: Effect.Effect<ClipboardWrite, ClipboardFailed>) => Effect.Effect<void>;
    readonly written: Effect.Effect<readonly RichText[]>;
  }
>()("jj-octo/cli/gh/links.test/FakeClipboard") {}

const fakeClipboard: Layer.Layer<Clipboard | FakeClipboard> = Layer.unwrap(
  Effect.gen(function* () {
    const answer = yield* Ref.make<Effect.Effect<ClipboardWrite, ClipboardFailed>>(
      Effect.succeed("copied"),
    );
    const written = yield* Ref.make<readonly RichText[]>([]);
    return Layer.mergeAll(
      Layer.succeed(FakeClipboard, {
        answer: (write) => Ref.set(answer, write),
        written: Ref.get(written),
      }),
      Layer.succeed(Clipboard, {
        write: (content) =>
          Ref.update(written, (before) => [...before, content]).pipe(
            Effect.andThen(Effect.flatten(Ref.get(answer))),
          ),
      }),
    );
  }),
);

layer(Layer.merge(scratchRepository, fakeGitHub))("stackPullRequests", (it) => {
  it("finds each change's pull request, top first", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c", "d", "e", "f");
      yield* repository.jj("git", "push", "--bookmark", "a");
      const pushedA = yield* repository.commitOf("a");
      yield* repository.jj("describe", "-r", "a", "-m", "a, reworded");
      yield* repository.write("a.txt", "a, rewritten\n");
      yield* repository.write("d.txt", "d\nmore\nlines\n");
      yield* repository.jj("squash", "--into", "d");
      const commitD = yield* repository.commitOf("d");
      const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
        a: [pullRequest(1, "merged", pushedA)],
        b: [pullRequest(6, "closed", "an earlier head"), pullRequest(2, "ready", "anything")],
        c: [pullRequest(3, "draft", "anything")],
        d: [pullRequest(4, "closed", commitD)],
        e: [pullRequest(5, "merged", "a head from an earlier branch named e")],
      };
      yield* setUpGitHub({ pullRequestsFrom: (branch) => byBranch[branch] ?? [] });
      const found = yield* stackPullRequests("@");
      expect(found).toStrictEqual([
        linked(pullRequest(4, "closed", commitD), 4, 1),
        linked(pullRequest(3, "draft", "anything")),
        linked(pullRequest(2, "ready", "anything")),
        linked(pullRequest(1, "merged", pushedA)),
      ]);
    }));

  it("finds the pull requests of changes with conflicts, and says they have them", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b", "c");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      const pushedBranches = yield* repository.branches;
      const pushedB = pushedBranches["b"] ?? "";
      yield* conflictWithTrunk("b", { pushed: ["a"] });
      const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
        a: [pullRequest(1, "ready", "anything")],
        b: [pullRequest(2, "draft", pushedB)],
      };
      yield* setUpGitHub({ pullRequestsFrom: (branch) => byBranch[branch] ?? [] });
      const count = (bookmark: string, total: string) =>
        repository
          .jj("log", "--no-graph", "-r", bookmark, "-T", `diff.stat().${total}()`)
          .pipe(Effect.map(Number));
      const found = yield* stackPullRequests("@");
      const added = yield* count("b", "total_added");
      const removed = yield* count("b", "total_removed");
      expect(found).toStrictEqual([
        {
          ...linked(pullRequest(2, "draft", pushedB), added, removed),
          conflict: true,
        },
        linked(pullRequest(1, "ready", "anything")),
      ]);
    }));
});

layer(Layer.mergeAll(scratchRepository, fakeGitHub, fakeClipboard))("links", (it) => {
  const draft = linked(pullRequest(1, "draft", "anything"));

  it.each([
    {
      outcome: "copied",
      report: "copied the links to the clipboard",
      stdout: markdownLinks([draft]),
    },
    {
      outcome: "unreachable",
      report:
        "This Claude Code cloud session can't reach the user's clipboard. Copy the lines between the markers into your reply verbatim: without the markers, a code block or added backticks. They then show as links that paste into Slack.",
      stdout: EffectArray.join(
        [
          "-----BEGIN TEXT TO PASTE VERBATIM-----",
          markdownLinks([draft]),
          "-----END TEXT TO PASTE VERBATIM-----",
        ],
        "\n",
      ),
    },
  ] as const)(
    "writes the links to the clipboard as HTML and Markdown when asked, and reports $outcome",
    ({ outcome, report, stdout }) =>
      Effect.gen(function* () {
        const repository = yield* ScratchRepository;
        const clipboard = yield* FakeClipboard;
        yield* repository.stack("a");
        const listed = pullRequest(1, "draft", "anything");
        yield* setUpGitHub({
          pullRequestsFrom: (branch) => (branch === "a" ? [listed] : []),
        });
        yield* clipboard.answer(Effect.succeed(outcome));
        yield* links({ copy: true, revision: "@" });
        expect({
          copied: yield* clipboard.written,
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          copied: [{ html: htmlLinks([linked(listed)]), text: markdownLinks([linked(listed)]) }],
          stderr: [report],
          stdout: [stdout],
        });
      }),
  );

  it("prints the links where the clipboard fails", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      const clipboard = yield* FakeClipboard;
      yield* repository.stack("a");
      const listed = pullRequest(1, "draft", "anything");
      yield* setUpGitHub({
        pullRequestsFrom: (branch) => (branch === "a" ? [listed] : []),
      });
      const failure = ClipboardFailed.make({ message: "xclip exited with 1" });
      yield* clipboard.answer(Effect.fail(failure));
      const exit = yield* Effect.exit(links({ copy: true, revision: "@" }));
      expect({
        exit,
        stderr: yield* TestConsole.errorLines,
        stdout: yield* TestConsole.logLines,
      }).toStrictEqual({
        exit: Exit.fail(failure),
        stderr: [],
        stdout: [markdownLinks([linked(listed)])],
      });
    }));

  it("fails, copying nothing, where no change has a pull request", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      const clipboard = yield* FakeClipboard;
      yield* repository.stack("a");
      const failure = yield* Effect.flip(links({ copy: true, revision: "@" }));
      expect({ copied: yield* clipboard.written, failure }).toStrictEqual({
        copied: [],
        failure: NoPullRequests.make({ message: "no change of the stack has a pull request" }),
      });
    }));

  it("prints the GitHub stack the pull requests are in above them", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      yield* repository.stack("a", "b");
      yield* setUpGitHub({
        pullRequestsFrom: (branch) => [
          inStack(pullRequest(branch === "a" ? 1 : 2, "ready", "anything"), 5),
        ],
      });
      yield* links({ copy: false, revision: "@" });
      expect({
        stderr: yield* TestConsole.errorLines,
        stdout: yield* TestConsole.logLines,
      }).toStrictEqual({
        stderr: [],
        stdout: [
          EffectArray.join(
            [
              "📚 Current stack: [#5](https://github.com/kkom/jj-octo/stack/5)",
              "👀 [#2 Pull request 2](https://github.com/kkom/jj-octo/pull/2) `+1/-0`",
              "👀 [#1 Pull request 1](https://github.com/kkom/jj-octo/pull/1) `+1/-0`",
            ],
            "\n",
          ),
        ],
      });
    }));

  it("copies nothing unless asked", () =>
    Effect.gen(function* () {
      const repository = yield* ScratchRepository;
      const clipboard = yield* FakeClipboard;
      yield* repository.stack("a");
      const listed = pullRequest(1, "draft", "anything");
      yield* setUpGitHub({ pullRequestsFrom: () => [listed] });
      yield* links({ copy: false, revision: "@" });
      expect({
        copied: yield* clipboard.written,
        stderr: yield* TestConsole.errorLines,
        stdout: yield* TestConsole.logLines,
      }).toStrictEqual({
        copied: [],
        stderr: [],
        stdout: [markdownLinks([linked(listed)])],
      });
    }));
});
