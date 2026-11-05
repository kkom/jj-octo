import { describe, expect, it } from "bun:test";

import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { environment } from "../../testing/environment";
import { pullRequest } from "../../testing/fake-github";
import { type InterceptedRequest, Reply, throughProxy } from "../../testing/intercepting-proxy";
import { GitHub, GitHubLive } from "./client";
import { MarkReadyForReview } from "./documents";
import { PullRequestNumberSchema, WorkflowRunIdSchema } from "./types";

// Runs `use` with the real client, against a GitHub that answers as `respond` does, with `env` as
// the environment. Returns what it produced and the requests GitHub received, without the proxy's
// CONNECTs.
const withGitHub = async <A>(
  respond: (request: InterceptedRequest) => unknown,
  use: (github: GitHub["Service"]) => Effect.Effect<A, unknown>,
  env: Readonly<Record<string, string>> = {},
) => {
  const { log, result } = await throughProxy("api.github.com", respond, ({ ca, url }) => {
    const live = GitHubLive(
      { name: "name", owner: "owner" },
      { proxy: Option.some({ ca: Option.some(ca), url }), token: Redacted.make("test-token") },
    );
    return Effect.runPromise(
      GitHub.use(use).pipe(
        Effect.provide(live),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(environment(env)),
      ),
    );
  });
  return { requests: log.filter((line) => !line.startsWith("CONNECT ")), result };
};

const runsPath = (page: number) =>
  `/repos/owner/name/actions/runs?head_sha=abc&per_page=100&page=${page}`;

describe("unfinishedRuns", () => {
  it("lists the runs that haven't completed from every page, until one comes back short", async () => {
    // A full first page, of which only run 100 is unfinished, then a short one with run 101.
    const pages: Readonly<Record<string, unknown>> = {
      [runsPath(1)]: {
        workflow_runs: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          status: index === 99 ? "in_progress" : "completed",
        })),
      },
      [runsPath(2)]: { workflow_runs: [{ id: 101, status: "queued" }] },
    };
    expect(
      await withGitHub(
        ({ path }) => pages[path],
        (github) => github.unfinishedRuns("abc"),
      ),
    ).toStrictEqual({
      requests: [`GET api.github.com${runsPath(1)}`, `GET api.github.com${runsPath(2)}`],
      result: [WorkflowRunIdSchema.make("100"), WorkflowRunIdSchema.make("101")],
    });
  });

  it("fails with the page it read, for an error response", async () => {
    expect(
      await withGitHub(
        () => new Reply(500, { message: "answered 500" }),
        (github) =>
          github
            .unfinishedRuns("abc")
            .pipe(
              Effect.catchTag("GitHubFailed", ({ message, status }) =>
                Effect.succeed({ message, status }),
              ),
            ),
      ),
    ).toStrictEqual({
      requests: [`GET api.github.com${runsPath(1)}`],
      result: {
        message: `GET ${runsPath(1)} returned 500: {"message":"answered 500"}`,
        status: 500,
      },
    });
  });
});

const pullsPath = (page: number) =>
  `/repos/owner/name/pulls?head=owner%3Aclaude%2Fa&state=all&per_page=100&page=${page}`;

// Pull request `number` from branch `claude/a`, as GitHub lists it, and as `pullRequestsFrom` reads it.
const listed = (number: number, state: "closed" | "open") => ({
  github: {
    head: { sha: `head-${number}` },
    html_url: `https://github.com/kkom/jj-octo/pull/${number}`,
    merged_at: null,
    number,
    state,
    title: `Pull request ${number}`,
  },
  read: pullRequest(number, state === "open" ? "ready" : "closed", `head-${number}`),
});

describe("pullRequestsFrom", () => {
  it("lists the pull requests from every page, until one comes back short", async () => {
    // A full first page, then a short one.
    const all = [
      listed(101, "open"),
      ...Array.from({ length: 100 }, (_, index) => listed(100 - index, "closed")),
    ];
    const pages: Readonly<Record<string, unknown>> = {
      [pullsPath(1)]: all.slice(0, 100).map(({ github }) => github),
      [pullsPath(2)]: all.slice(100).map(({ github }) => github),
    };
    expect(
      await withGitHub(
        ({ path }) => pages[path],
        (github) => github.pullRequestsFrom("claude/a"),
      ),
    ).toStrictEqual({
      requests: [`GET api.github.com${pullsPath(1)}`, `GET api.github.com${pullsPath(2)}`],
      result: all.map(({ read }) => read),
    });
  });
});

// Cancels run 7 where GitHub answers the cancel with the status, and returns the outcome or how it
// failed.
const cancel = (status: number) =>
  withGitHub(
    () => new Reply(status, { message: `answered ${status}` }),
    (github) =>
      github.cancelRun(WorkflowRunIdSchema.make("7")).pipe(
        Effect.map((outcome) => ({ outcome })),
        Effect.catchTag("GitHubFailed", ({ message, status: failed }) =>
          Effect.succeed({ failed: { message, status: failed } }),
        ),
      ),
  );

describe("cancelRun", () => {
  const request = "POST api.github.com/repos/owner/name/actions/runs/7/cancel";

  it("cancels a run GitHub accepts the cancel of", async () => {
    expect(await cancel(202)).toStrictEqual({
      requests: [request],
      result: { outcome: "cancelled" },
    });
  });

  it("reads GitHub's 409 as a run that had finished", async () => {
    expect(await cancel(409)).toStrictEqual({
      requests: [request],
      result: { outcome: "finished" },
    });
  });

  it("fails with GitHub's own words for any other error", async () => {
    expect(await cancel(403)).toStrictEqual({
      requests: [request],
      result: {
        failed: {
          message:
            'POST /repos/owner/name/actions/runs/7/cancel returned 403: {"message":"answered 403"}',
          status: 403,
        },
      },
    });
  });
});

// Marks #7 ready for review, against a GitHub whose GraphQL API answers with `graphql`, and returns
// the outcome or how it failed, with the body of each GraphQL request.
const markReady = async (graphql: unknown, env: Readonly<Record<string, string>> = {}) => {
  const bodies: unknown[] = [];
  const outcome = await withGitHub(
    ({ body, path }) => {
      if (path === "/graphql") {
        bodies.push(JSON.parse(body));
        return graphql;
      }
      return path === "/repos/owner/name/pulls/7" ? { node_id: "PR_seven" } : {};
    },
    (github) =>
      github.markReadyForReview(PullRequestNumberSchema.make(7)).pipe(
        Effect.as({ marked: true }),
        Effect.catchTag("GitHubFailed", ({ message }) => Effect.succeed({ failed: message })),
      ),
    env,
  );
  return { ...outcome, bodies };
};

describe("markReadyForReview", () => {
  const graphqlRequests = [
    "GET api.github.com/repos/owner/name/pulls/7",
    "POST api.github.com/graphql",
  ];
  const graphqlBody = {
    query: MarkReadyForReview.toString(),
    variables: { pullRequestId: "PR_seven" },
  };

  it("sends GraphQL's mutation for the pull request's node id", async () => {
    expect(
      await markReady({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      }),
    ).toStrictEqual({
      bodies: [graphqlBody],
      requests: graphqlRequests,
      result: { marked: true },
    });
  });

  it("fails with the errors GitHub returns beside a 200", async () => {
    expect(
      await markReady({
        data: { markPullRequestReadyForReview: null },
        errors: [{ message: "Resource not accessible by integration" }],
      }),
    ).toStrictEqual({
      bodies: [graphqlBody],
      requests: graphqlRequests,
      result: {
        failed: "marking #7 ready for review failed: Resource not accessible by integration",
      },
    });
  });

  it("uses the GitHub proxy's own route in a Claude Code cloud session", async () => {
    expect(await markReady({}, { CLAUDE_CODE_REMOTE: "true" })).toStrictEqual({
      bodies: [],
      requests: ["POST api.github.com/repos/owner/name/pulls/7/ccr/ready_for_review"],
      result: { marked: true },
    });
  });
});
