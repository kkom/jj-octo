import { describe, expect, it } from "bun:test";

import { Option } from "effect";

import { withGitHub } from "../../testing/github-client";
import { type InterceptedRequest, Reply } from "../../testing/intercepting-proxy";
import type { Check } from "./types";

const ACTIONS = 15_368;
const OTHER_APP = 9;

const checkRunsPath = (page: number) =>
  `/repos/owner/name/commits/abc/check-runs?filter=all&per_page=100&page=${page}`;
const statusPath = (page: number) =>
  `/repos/owner/name/commits/abc/status?per_page=100&page=${page}`;

// A check run as GitHub lists it, from GitHub Actions unless another app is given.
const checkRun = ({
  app = ACTIONS,
  conclusion = null,
  id,
  name,
  status = "completed",
}: {
  readonly app?: number;
  readonly conclusion?: string | null;
  readonly id: number;
  readonly name: string;
  readonly status?: string;
}) => ({ app: { id: app }, conclusion, id, name, status });

// A GitHub whose listings of commit `abc` hold the check runs and statuses, each on one page.
const listing =
  (runs: readonly unknown[], statuses: readonly unknown[]) =>
  ({ path }: InterceptedRequest): unknown => {
    if (path === checkRunsPath(1)) {
      return { check_runs: runs, total_count: runs.length };
    }
    if (path === statusPath(1)) {
      return { state: "pending", statuses, total_count: statuses.length };
    }
    return new Reply(404, { message: "Not Found" });
  };

// A check run's result from GitHub Actions.
const check = (name: string, outcome: string, state: Check["state"]): Check => ({
  app: Option.some(ACTIONS),
  name,
  outcome,
  state,
});

describe("latestChecks", () => {
  it("counts only the newest run of each check", async () => {
    expect(
      await withGitHub(
        listing(
          [
            // Listed newest first, as GitHub lists them, with a re-run of each check.
            checkRun({ conclusion: "success", id: 40, name: "Merge Gate" }),
            checkRun({ id: 30, name: "CI", status: "queued" }),
            checkRun({ conclusion: "success", id: 20, name: "CI" }),
            checkRun({ conclusion: "cancelled", id: 10, name: "Merge Gate" }),
            // The same name from another app is another check.
            checkRun({ app: OTHER_APP, conclusion: "failure", id: 5, name: "CI" }),
            { ...checkRun({ conclusion: "success", id: 3, name: "CI" }), app: null },
          ],
          [],
        ),
        (github) => github.latestChecks("abc"),
      ),
    ).toStrictEqual({
      requests: [`GET api.github.com${checkRunsPath(1)}`, `GET api.github.com${statusPath(1)}`],
      result: [
        check("Merge Gate", "success", "passed"),
        check("CI", "queued", "pending"),
        { ...check("CI", "failure", "failed"), app: Option.some(OTHER_APP) },
        { ...check("CI", "success", "passed"), app: Option.none() },
      ],
    });
  });

  it("counts a run as passed where GitHub counts it so for a required check", async () => {
    const conclusions = [
      "success",
      "neutral",
      "skipped",
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
    ];
    expect(
      await withGitHub(
        listing(
          conclusions.map((conclusion, index) =>
            checkRun({ conclusion, id: index, name: conclusion }),
          ),
          [],
        ),
        (github) => github.latestChecks("abc"),
      ),
    ).toStrictEqual({
      requests: [`GET api.github.com${checkRunsPath(1)}`, `GET api.github.com${statusPath(1)}`],
      result: [
        check("success", "success", "passed"),
        check("neutral", "neutral", "passed"),
        check("skipped", "skipped", "passed"),
        check("failure", "failure", "failed"),
        check("cancelled", "cancelled", "failed"),
        check("timed_out", "timed_out", "failed"),
        check("action_required", "action_required", "failed"),
        check("stale", "stale", "failed"),
      ],
    });
  });

  it("reads each commit status, with no app", async () => {
    expect(
      await withGitHub(
        listing(
          [],
          ["success", "pending", "failure", "error"].map((state) => ({
            context: `ci/${state}`,
            state,
          })),
        ),
        (github) => github.latestChecks("abc"),
      ),
    ).toStrictEqual({
      requests: [`GET api.github.com${checkRunsPath(1)}`, `GET api.github.com${statusPath(1)}`],
      result: [
        { ...check("ci/success", "success", "passed"), app: Option.none() },
        { ...check("ci/pending", "pending", "pending"), app: Option.none() },
        { ...check("ci/failure", "failure", "failed"), app: Option.none() },
        { ...check("ci/error", "error", "failed"), app: Option.none() },
      ],
    });
  });

  it("reads every page of check runs", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      checkRun({ conclusion: "success", id: index + 2, name: `check ${index + 2}` }),
    );
    const pages: Readonly<Record<string, unknown>> = {
      [checkRunsPath(1)]: { check_runs: firstPage, total_count: 101 },
      [checkRunsPath(2)]: {
        check_runs: [checkRun({ conclusion: "failure", id: 1, name: "check 2" })],
        total_count: 101,
      },
      [statusPath(1)]: { state: "pending", statuses: [], total_count: 0 },
    };
    const { requests, result } = await withGitHub(
      ({ path }) => pages[path] ?? new Reply(404, { message: "Not Found" }),
      (github) => github.latestChecks("abc"),
    );
    expect({ requests: requests.toSorted(), result }).toStrictEqual({
      requests: [
        `GET api.github.com${checkRunsPath(1)}`,
        `GET api.github.com${checkRunsPath(2)}`,
        `GET api.github.com${statusPath(1)}`,
      ],
      result: firstPage.map(({ name }) => check(name, "success", "passed")),
    });
  });
});
