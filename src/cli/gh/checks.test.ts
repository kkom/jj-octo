import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import type { Check, ListedPullRequest, RequiredChecks } from "../../clients/github/types";
import { fakeGitHub, inRepository, pullRequest } from "../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { checkLines, checks } from "./checks";

afterAll(removeScratchRepositories);

const ACTIONS = 15_368;

// A check run's result from GitHub Actions.
const run = (name: string, outcome: string, state: Check["state"]): Check => ({
  app: Option.some(ACTIONS),
  name,
  outcome,
  state,
});

const status = (name: string, outcome: string, state: Check["state"]): Check => ({
  app: Option.none(),
  name,
  outcome,
  state,
});

const requiring = (...names: readonly string[]): RequiredChecks => ({
  _tag: "Known",
  checks: names.map((name) => ({ app: Option.none(), name })),
});

describe("checkLines", () => {
  it("names the required checks that failed, whatever the others are", () => {
    expect(
      checkLines(
        requiring("Merge Gate", "CI", "Lint"),
        [
          run("Merge Gate", "cancelled", "failed"),
          run("CI", "in_progress", "pending"),
          run("Lint", "success", "passed"),
          run("Cleanup", "failure", "failed"),
        ],
        "main",
      ),
    ).toStrictEqual([
      "required checks failed: Merge Gate",
      "required      CI          in_progress",
      "required      Lint        success",
      "required      Merge Gate  cancelled",
      "not required  Cleanup     failure",
    ]);
  });

  it("names the required checks pending where none failed, including one with no result", () => {
    expect(
      checkLines(
        requiring("CI", "Lint", "Docs"),
        [run("CI", "queued", "pending"), run("Lint", "skipped", "passed")],
        "main",
      ),
    ).toStrictEqual([
      "required checks pending: CI, Docs",
      "required  CI    queued",
      "required  Docs  expected",
      "required  Lint  skipped",
    ]);
  });

  it("names every required check where all passed", () => {
    expect(
      checkLines(
        requiring("CI", "ci/legacy"),
        [run("CI", "success", "passed"), status("ci/legacy", "success", "passed")],
        "main",
      ),
    ).toStrictEqual([
      "required checks passed: CI, ci/legacy",
      "required  CI         success",
      "required  ci/legacy  success",
    ]);
  });

  it("counts only the app's run where the requirement names an app", () => {
    expect(
      checkLines(
        { _tag: "Known", checks: [{ app: Option.some(ACTIONS), name: "CI" }] },
        [
          run("CI", "success", "passed"),
          { ...run("CI", "failure", "failed"), app: Option.some(9) },
        ],
        "main",
      ),
    ).toStrictEqual([
      "required checks passed: CI",
      "required      CI  success",
      "not required  CI  failure",
    ]);
  });

  it("reads a required check that names an app as unknown where only a status may be its result", () => {
    expect(
      checkLines(
        {
          _tag: "Known",
          checks: [
            { app: Option.some(ACTIONS), name: "codecov" },
            { app: Option.some(ACTIONS), name: "Lint" },
          ],
        },
        [
          status("codecov", "success", "passed"),
          run("Lint", "failure", "failed"),
          status("Lint", "success", "passed"),
        ],
        "main",
      ),
    ).toStrictEqual([
      "required checks failed: Lint",
      "required        Lint     failure",
      "maybe required  Lint     success",
      "maybe required  codecov  success",
    ]);
    expect(
      checkLines(
        { _tag: "Known", checks: [{ app: Option.some(ACTIONS), name: "codecov" }] },
        [status("codecov", "success", "passed")],
        "main",
      ),
    ).toStrictEqual(["required checks unknown: codecov", "maybe required  codecov  success"]);
  });

  it("reads a required check that names an app by its runs where a status wouldn't change it", () => {
    expect(
      checkLines(
        { _tag: "Known", checks: [{ app: Option.some(ACTIONS), name: "CI" }] },
        [run("CI", "success", "passed"), status("CI", "success", "passed")],
        "main",
      ),
    ).toStrictEqual([
      "required checks passed: CI",
      "required        CI  success",
      "maybe required  CI  success",
    ]);
  });

  it("prints a check once where two requirements of its name name different apps", () => {
    expect(
      checkLines(
        {
          _tag: "Known",
          checks: [
            { app: Option.some(ACTIONS), name: "CI" },
            { app: Option.none(), name: "CI" },
          ],
        },
        [run("CI", "success", "passed")],
        "main",
      ),
    ).toStrictEqual(["required checks passed: CI", "required  CI  success"]);
  });

  it("counts a required check sent by several sources in the state furthest from passing", () => {
    expect(
      checkLines(
        requiring("CI"),
        [run("CI", "success", "passed"), status("CI", "pending", "pending")],
        "main",
      ),
    ).toStrictEqual([
      "required checks pending: CI",
      "required  CI  success",
      "required  CI  pending",
    ]);
  });

  it("says where the branch requires no checks", () => {
    expect(checkLines(requiring(), [run("CI", "failure", "failed")], "trunk")).toStrictEqual([
      "no required checks: trunk requires none",
      "not required  CI  failure",
    ]);
  });

  it("says where the required checks couldn't be read, and guesses none", () => {
    expect(
      checkLines(
        {
          _tag: "Unknown",
          reason: "couldn't read the rules of main: GET /repos/o/r/branches/main returned 403: {}",
        },
        [run("CI", "failure", "failed")],
        "main",
      ),
    ).toStrictEqual([
      "required checks unknown: couldn't read the rules of main: GET /repos/o/r/branches/main returned 403: {}",
      "maybe required  CI  failure",
    ]);
  });
});

describe("checks", () => {
  it("prints each change top first, with its open pull request's checks", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    const commitOf = (bookmark: string) =>
      repository.jj("log", "--no-graph", "-r", bookmark, "-T", "commit_id");
    const pushedEarlier = "0123456789abcdef0123456789abcdef01234567";
    const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
      a: [pullRequest(1, "ready", commitOf("a"))],
      b: [pullRequest(2, "draft", pushedEarlier), pullRequest(3, "merged", "x")],
      c: [pullRequest(4, "closed", commitOf("c"))],
    };
    const github = fakeGitHub({}, [], {
      checks: {
        [commitOf("a")]: [run("CI", "success", "passed"), run("Cleanup", "skipped", "passed")],
        [pushedEarlier]: [run("CI", "cancelled", "failed")],
      },
      pullRequestsFrom: (branch) => byBranch[branch] ?? [],
      required: { main: requiring("CI") },
    });
    expect(
      await Effect.runPromise(checks("@").pipe(inRepository(repository, github))),
    ).toStrictEqual([
      "c: no open pull request",
      "",
      "b: #2 Pull request 2",
      "  checks of 0123456789ab, the pull request's head on GitHub, which differs from the change",
      "  required checks failed: CI",
      "  required  CI  cancelled",
      "",
      "a: #1 Pull request 1",
      "  required checks passed: CI",
      "  required      CI       success",
      "  not required  Cleanup  skipped",
    ]);
  });
});
