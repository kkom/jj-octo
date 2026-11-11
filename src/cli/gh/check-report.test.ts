import { describe, expect, it } from "bun:test";

import { Option } from "effect";

import { ACTIONS, requiring, run, status } from "../../testing/checks";
import { checkReport } from "./checks";

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
