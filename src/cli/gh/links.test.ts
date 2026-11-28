import { afterAll, describe, expect } from "bun:test";

import { Array as EffectArray, Effect, Exit, Layer } from "effect";
import { TestConsole } from "effect/testing";

import {
  Clipboard,
  ClipboardFailed,
  type ClipboardWrite,
  type RichText,
} from "../../clients/clipboard";
import type { ListedPullRequest } from "../../clients/github/types";
import { conflictWithTrunk } from "../../testing/conflicts";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { itEffect } from "../../testing/it-effect";
import { inStack, linked } from "../../testing/links";
import { pullRequest } from "../../testing/pull-requests";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { htmlLinks, links, markdownLinks, NoPullRequests, stackPullRequests } from "./links";

afterAll(removeScratchRepositories);

// A clipboard that keeps what is written to it, and reports the given outcome.
const fakeClipboard = (outcome: ClipboardWrite = "copied") => {
  const copied: RichText[] = [];
  const layer = Layer.succeed(Clipboard, {
    write: (content) =>
      Effect.sync(() => {
        copied.push(content);
        return outcome;
      }),
  });
  return { copied, layer };
};

describe("stackPullRequests", () => {
  itEffect("finds each change's pull request, top first", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a", "b", "c", "d", "e", "f");
      repository.jj("git", "push", "--bookmark", "a");
      const pushedA = repository.commitOf("a");
      repository.jj("describe", "-r", "a", "-m", "a, reworded");
      repository.write("a.txt", "a, rewritten\n");
      repository.write("d.txt", "d\nmore\nlines\n");
      repository.jj("squash", "--into", "d");
      const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
        a: [pullRequest(1, "merged", pushedA)],
        b: [pullRequest(6, "closed", "an earlier head"), pullRequest(2, "ready", "anything")],
        c: [pullRequest(3, "draft", "anything")],
        d: [pullRequest(4, "closed", repository.commitOf("d"))],
        e: [pullRequest(5, "merged", "a head from an earlier branch named e")],
      };
      const github = fakeGitHub({}, [], {
        pullRequestsFrom: (branch) => byBranch[branch] ?? [],
      });
      const found = yield* stackPullRequests("@").pipe(inRepository(repository, github));
      expect(found).toStrictEqual([
        linked(pullRequest(4, "closed", repository.commitOf("d")), 4, 1),
        linked(pullRequest(3, "draft", "anything")),
        linked(pullRequest(2, "ready", "anything")),
        linked(pullRequest(1, "merged", pushedA)),
      ]);
    }),
  );

  itEffect("finds the pull requests of changes with conflicts, and says they have them", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a", "b", "c");
      repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      const pushedB = repository.branches()["b"] ?? "";
      conflictWithTrunk(repository, "b", { pushed: ["a"] });
      const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
        a: [pullRequest(1, "ready", "anything")],
        b: [pullRequest(2, "draft", pushedB)],
      };
      const github = fakeGitHub({}, [], {
        pullRequestsFrom: (branch) => byBranch[branch] ?? [],
      });
      const count = (bookmark: string, total: string) =>
        Number(repository.jj("log", "--no-graph", "-r", bookmark, "-T", `diff.stat().${total}()`));
      const found = yield* stackPullRequests("@").pipe(inRepository(repository, github));
      expect(found).toStrictEqual([
        {
          ...linked(
            pullRequest(2, "draft", pushedB),
            count("b", "total_added"),
            count("b", "total_removed"),
          ),
          conflict: true,
        },
        linked(pullRequest(1, "ready", "anything")),
      ]);
    }),
  );
});

describe("links", () => {
  const draft = linked(pullRequest(1, "draft", "anything"));

  itEffect.each([
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
        const repository = scratchRepository();
        repository.stack("a");
        const listed = pullRequest(1, "draft", "anything");
        const github = fakeGitHub({}, [], {
          pullRequestsFrom: (branch) => (branch === "a" ? [listed] : []),
        });
        const clipboard = fakeClipboard(outcome);
        yield* links({ copy: true, revision: "@" }).pipe(
          Effect.provide(clipboard.layer),
          inRepository(repository, github),
        );
        expect({
          copied: clipboard.copied,
          stderr: yield* TestConsole.errorLines,
          stdout: yield* TestConsole.logLines,
        }).toStrictEqual({
          copied: [{ html: htmlLinks([linked(listed)]), text: markdownLinks([linked(listed)]) }],
          stderr: [report],
          stdout: [stdout],
        });
      }),
  );

  itEffect("prints the links where the clipboard fails", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a");
      const listed = pullRequest(1, "draft", "anything");
      const github = fakeGitHub({}, [], {
        pullRequestsFrom: (branch) => (branch === "a" ? [listed] : []),
      });
      const failure = ClipboardFailed.make({ message: "xclip exited with 1" });
      const exit = yield* Effect.exit(
        links({ copy: true, revision: "@" }).pipe(
          Effect.provideService(Clipboard, { write: () => Effect.fail(failure) }),
          inRepository(repository, github),
        ),
      );
      expect({
        exit,
        stderr: yield* TestConsole.errorLines,
        stdout: yield* TestConsole.logLines,
      }).toStrictEqual({
        exit: Exit.fail(failure),
        stderr: [],
        stdout: [markdownLinks([linked(listed)])],
      });
    }),
  );

  itEffect("fails, copying nothing, where no change has a pull request", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a");
      const clipboard = fakeClipboard();
      const failure = yield* Effect.flip(links({ copy: true, revision: "@" })).pipe(
        Effect.provide(clipboard.layer),
        inRepository(repository, fakeGitHub({}, [])),
      );
      expect({ copied: clipboard.copied, failure }).toStrictEqual({
        copied: [],
        failure: NoPullRequests.make({ message: "no change of the stack has a pull request" }),
      });
    }),
  );

  itEffect("prints the GitHub stack the pull requests are in above them", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a", "b");
      const github = fakeGitHub({}, [], {
        pullRequestsFrom: (branch) => [
          inStack(pullRequest(branch === "a" ? 1 : 2, "ready", "anything"), 5),
        ],
      });
      yield* links({ copy: false, revision: "@" }).pipe(
        Effect.provide(fakeClipboard().layer),
        inRepository(repository, github),
      );
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
    }),
  );

  itEffect("copies nothing unless asked", () =>
    Effect.gen(function* () {
      const repository = scratchRepository();
      repository.stack("a");
      const listed = pullRequest(1, "draft", "anything");
      const github = fakeGitHub({}, [], { pullRequestsFrom: () => [listed] });
      const clipboard = fakeClipboard();
      yield* links({ copy: false, revision: "@" }).pipe(
        Effect.provide(clipboard.layer),
        inRepository(repository, github),
      );
      expect({
        copied: clipboard.copied,
        stderr: yield* TestConsole.errorLines,
        stdout: yield* TestConsole.logLines,
      }).toStrictEqual({
        copied: [],
        stderr: [],
        stdout: [markdownLinks([linked(listed)])],
      });
    }),
  );
});
