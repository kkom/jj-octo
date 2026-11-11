import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import { GitHub } from "../../clients/github/client";
import { conflictWithTrunk, labelsOf } from "../../testing/conflicts";
import { fakeGitHub, inRepository, openPullRequest, stackOf } from "../../testing/fake-github";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { publish } from "./publish";

afterAll(removeScratchRepositories);

const publishIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  revision: string,
) => publish(revision).pipe(inRepository(repository, github));

// Whether each bookmark's open pull request is a draft, as the fake GitHub reports it afterwards.
const draftsIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  bookmarks: readonly string[],
) =>
  Effect.forEach(bookmarks, (bookmark) =>
    GitHub.use((client) => client.openPullRequest(bookmark)).pipe(
      Effect.map((found) => Option.map(found, ({ draft }) => draft)),
    ),
  ).pipe(inRepository(repository, github));

const threeDrafts = () =>
  fakeGitHub(
    {
      a: openPullRequest("main", 1, "a"),
      b: openPullRequest("a", 2, "b"),
      c: openPullRequest("b", 3, "c"),
    },
    stackOf(1, 2, 3),
  );

describe("publish", () => {
  it("publishes a change and the ones below it where a change above has conflicts", async () => {
    const repository = pushedStack("a", "b", "c");
    conflictWithTrunk(repository, "c", { pushed: ["a", "b"] });
    const github = threeDrafts();
    await Effect.runPromise(publishIn(repository, github, "b"));
    expect(github.calls).toStrictEqual(["publish #1", "publish #2"]);
  });

  it("fails before publishing any where the change named has conflicts", async () => {
    const repository = pushedStack("a", "b", "c");
    conflictWithTrunk(repository, "b", { pushed: ["a"] });
    const github = threeDrafts();
    const failure = await Effect.runPromise(Effect.flip(publishIn(repository, github, "b")));
    expect({ calls: github.calls, message: failure.message }).toStrictEqual({
      calls: [],
      message: `resolve the conflicts first:\n${labelsOf(repository, "b")}`,
    });
  });

  it("marks the drafts of a change and the ones below it ready, bottom to top", async () => {
    const repository = pushedStack("a", "b", "c");
    const github = fakeGitHub(
      {
        a: openPullRequest("main", 1, "a"),
        b: { ...openPullRequest("a", 2, "b"), draft: false },
        c: openPullRequest("b", 3, "c"),
      },
      stackOf(1, 2, 3),
    );
    await Effect.runPromise(publishIn(repository, github, "c"));
    expect({
      calls: github.calls,
      drafts: await Effect.runPromise(draftsIn(repository, github, ["a", "b", "c"])),
    }).toStrictEqual({
      calls: ["publish #1", "publish #3"],
      drafts: [Option.some(false), Option.some(false), Option.some(false)],
    });
  });

  it("leaves the changes above the one named as drafts", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub(
      { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
      stackOf(1, 2),
    );
    await Effect.runPromise(publishIn(repository, github, "a"));
    expect(github.calls).toStrictEqual(["publish #1"]);
  });

  it("publishes nothing where every pull request is ready", async () => {
    const repository = pushedStack("a");
    const github = fakeGitHub({ a: { ...openPullRequest("main", 1, "a"), draft: false } }, []);
    await Effect.runPromise(publishIn(repository, github, "a"));
    expect(github.calls).toStrictEqual([]);
  });

  it("publishes nothing while a change has edits that aren't pushed", async () => {
    const repository = pushedStack("a", "b");
    repository.jj("describe", "-r", "b", "-m", "b, reworded");
    const github = fakeGitHub(
      { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
      stackOf(1, 2),
    );
    const failure = await Effect.runPromise(Effect.flip(publishIn(repository, github, "b")));
    expect({ calls: github.calls, message: failure.message }).toStrictEqual({
      calls: [],
      message: "these changes aren't pushed: b; run `jj gh submit --publish` instead",
    });
  });

  it("publishes nothing where a change has no open pull request", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub({ b: openPullRequest("a", 2, "b") }, []);
    const failure = await Effect.runPromise(Effect.flip(publishIn(repository, github, "b")));
    expect({ calls: github.calls, message: failure.message }).toStrictEqual({
      calls: [],
      message: "no open pull request for a; run `jj gh submit --publish` instead",
    });
  });
});
