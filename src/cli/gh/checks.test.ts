import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import type { Check, ListedPullRequest, RequiredChecks } from "../../clients/github/types";
import { fakeGitHub, inRepository, pullRequest } from "../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { checkReport, checks } from "./checks";

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

describe("checkReport", () => {
  it("names the required checks that failed, whatever the others are", () => {
    expect(
      checkReport(requiring("Merge Gate", "CI", "Lint"), [
        run("Merge Gate", "cancelled", "failed"),
        run("CI", "in_progress", "pending"),
        run("Lint", "success", "passed"),
        run("Cleanup", "failure", "failed"),
      ]),
    ).toStrictEqual({
      rows: [
        "required      CI          in_progress",
        "required      Lint        success",
        "required      Merge Gate  cancelled",
        "not required  Cleanup     failure",
      ],
      state: "failed: Merge Gate",
    });
  });

  it("names the required checks pending where none failed, including one with no result", () => {
    expect(
      checkReport(requiring("CI", "Lint", "Docs"), [
        run("CI", "queued", "pending"),
        run("Lint", "skipped", "passed"),
      ]),
    ).toStrictEqual({
      rows: ["required  CI    queued", "required  Docs  expected", "required  Lint  skipped"],
      state: "pending: CI, Docs",
    });
  });

  it("says passed, without names, where every required check passed", () => {
    expect(
      checkReport(requiring("CI", "ci/legacy"), [
        run("CI", "success", "passed"),
        status("ci/legacy", "success", "passed"),
      ]),
    ).toStrictEqual({
      rows: ["required  CI         success", "required  ci/legacy  success"],
      state: "passed",
    });
  });

  it("counts only the app's run where the requirement names an app", () => {
    expect(
      checkReport({ _tag: "Known", checks: [{ app: Option.some(ACTIONS), name: "CI" }] }, [
        run("CI", "success", "passed"),
        { ...run("CI", "failure", "failed"), app: Option.some(9) },
      ]),
    ).toStrictEqual({
      rows: ["required      CI  success", "not required  CI  failure"],
      state: "passed",
    });
  });

  it("reads a required check that names an app as unknown where only a status may be its result", () => {
    expect(
      checkReport(
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
      ),
    ).toStrictEqual({
      rows: [
        "required        Lint     failure",
        "maybe required  Lint     success",
        "maybe required  codecov  success",
      ],
      state: "failed: Lint",
    });
    expect(
      checkReport({ _tag: "Known", checks: [{ app: Option.some(ACTIONS), name: "codecov" }] }, [
        status("codecov", "success", "passed"),
      ]),
    ).toStrictEqual({ rows: ["maybe required  codecov  success"], state: "unknown: codecov" });
  });

  it("reads a required check that names an app by its runs where a status wouldn't change it", () => {
    expect(
      checkReport({ _tag: "Known", checks: [{ app: Option.some(ACTIONS), name: "CI" }] }, [
        run("CI", "success", "passed"),
        status("CI", "success", "passed"),
      ]),
    ).toStrictEqual({
      rows: ["required        CI  success", "maybe required  CI  success"],
      state: "passed",
    });
  });

  it("prints a check once where two requirements of its name name different apps", () => {
    expect(
      checkReport(
        {
          _tag: "Known",
          checks: [
            { app: Option.some(ACTIONS), name: "CI" },
            { app: Option.none(), name: "CI" },
          ],
        },
        [run("CI", "success", "passed")],
      ),
    ).toStrictEqual({ rows: ["required  CI  success"], state: "passed" });
  });

  it("counts a required check sent by several sources in the state furthest from passing", () => {
    expect(
      checkReport(requiring("CI"), [
        run("CI", "success", "passed"),
        status("CI", "pending", "pending"),
      ]),
    ).toStrictEqual({
      rows: ["required  CI  success", "required  CI  pending"],
      state: "pending: CI",
    });
  });

  it("says where the branch requires no checks", () => {
    expect(checkReport(requiring(), [run("CI", "failure", "failed")])).toStrictEqual({
      rows: ["not required  CI  failure"],
      state: "no required checks",
    });
  });

  it("says where the required checks couldn't be read, and guesses none", () => {
    expect(
      checkReport(
        {
          _tag: "Unknown",
          reason: "couldn't read the rules of main: GET /repos/o/r/branches/main returned 403: {}",
        },
        [run("CI", "failure", "failed")],
      ),
    ).toStrictEqual({
      rows: ["maybe required  CI  failure"],
      state: "unknown",
    });
  });
});

// A stack of three changes: `a` with checks, `b` whose pull request's head is a commit pushed
// earlier, and `c` with no open pull request.
const checkedStack = (required: RequiredChecks = requiring("CI")) => {
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
    required: { main: required },
  });
  return inRepository(repository, github);
};

describe("checks", () => {
  it("prints one line per change top first, with the state of its required checks", async () => {
    expect(
      await Effect.runPromise(checks("@", { verbose: false }).pipe(checkedStack())),
    ).toStrictEqual([
      "c  no open pull request",
      "b  #2 failed: CI         head 0123456789ab differs from the change",
      "a  #1 passed",
    ]);
  });

  it("follows each line with its pull request's check rows, with --verbose", async () => {
    expect(
      await Effect.runPromise(checks("@", { verbose: true }).pipe(checkedStack())),
    ).toStrictEqual([
      "c  no open pull request",
      "",
      "b  #2 failed: CI         head 0123456789ab differs from the change",
      "  required  CI  cancelled",
      "",
      "a  #1 passed",
      "  required      CI       success",
      "  not required  Cleanup  skipped",
    ]);
  });

  it("says once why the required checks are unknown", async () => {
    expect(
      await Effect.runPromise(
        checks("@", { verbose: false }).pipe(
          checkedStack({ _tag: "Unknown", reason: "couldn't read the rules of main" }),
        ),
      ),
    ).toStrictEqual([
      "required checks unknown: couldn't read the rules of main",
      "c  no open pull request",
      "b  #2 unknown            head 0123456789ab differs from the change",
      "a  #1 unknown",
    ]);
  });

  it("separates the reason the required checks are unknown from the pull requests, with --verbose", async () => {
    expect(
      await Effect.runPromise(
        checks("@", { verbose: true }).pipe(
          checkedStack({ _tag: "Unknown", reason: "couldn't read the rules of main" }),
        ),
      ),
    ).toStrictEqual([
      "required checks unknown: couldn't read the rules of main",
      "",
      "c  no open pull request",
      "",
      "b  #2 unknown            head 0123456789ab differs from the change",
      "  maybe required  CI  cancelled",
      "",
      "a  #1 unknown",
      "  maybe required  CI       success",
      "  maybe required  Cleanup  skipped",
    ]);
  });

  it("says where the default branch requires no checks", async () => {
    expect(
      await Effect.runPromise(checks("@", { verbose: false }).pipe(checkedStack(requiring()))),
    ).toStrictEqual([
      "c  no open pull request",
      "b  #2 no required checks  head 0123456789ab differs from the change",
      "a  #1 no required checks",
    ]);
  });
});
