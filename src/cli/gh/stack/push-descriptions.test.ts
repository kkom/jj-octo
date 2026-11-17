import { afterAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { labelsOf } from "../../../testing/conflicts";
import { describeChanges } from "../../../testing/descriptions";
import { fakeConsole } from "../../../testing/fake-console";
import { fakeGitHub, openPullRequest } from "../../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../../testing/scratch-repository";
import { submitIn } from "../../../testing/submit";

afterAll(removeScratchRepositories);

const hint =
  "write each with `jj describe -r <change id>`, then run `jj gh submit` before publishing";

describe("submit checks the descriptions of the drafts", () => {
  it("pushes nothing when not drafts where a pull request to publish has no body", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    const github = fakeGitHub({ b: { ...openPullRequest("main", 2, "b"), draft: false } }, []);
    const failure = await Effect.runPromise(
      Effect.flip(submitIn(repository, github, { draft: false, revision: "c" })),
    );
    expect({
      branches: Object.keys(repository.branches()),
      calls: github.calls,
      message: failure.message,
    }).toStrictEqual({
      branches: ["main"],
      calls: [],
      message: [
        "these descriptions aren't ready for review:",
        `${labelsOf(repository, "a")}: has no body`,
        `${labelsOf(repository, "c")}: has no body`,
        hint,
      ].join("\n"),
    });
  });

  it("opens drafts without a body, and warns that publishing them fails", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    describeChanges(repository, { a: "Adds a." });
    const github = fakeGitHub({}, []);
    const console = fakeConsole();
    await Effect.runPromise(console.provide(submitIn(repository, github)));
    expect({ calls: github.calls, printed: console.printed }).toStrictEqual({
      calls: ["open a on main as a draft", "open b on a as a draft", "create stack 99,99"],
      printed: [
        { stream: "stderr", text: "opened #99 for a" },
        { stream: "stderr", text: "opened #99 for b" },
        { stream: "stderr", text: "registered stack #8" },
        {
          stream: "stderr",
          text: [
            "`jj gh publish` fails until these descriptions are ready for review:",
            `${labelsOf(repository, "b")}: has no body`,
            hint,
          ].join("\n"),
        },
      ],
    });
  });
});
