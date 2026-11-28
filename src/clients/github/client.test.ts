import { expect } from "bun:test";

import { Array as EffectArray, Effect, Result, Schema } from "effect";

import { withEnvironment } from "../../testing/environment";
import { callGitHub, failureOf, gitHubThroughProxy } from "../../testing/github-client";
import { InterceptingProxy, Reply } from "../../testing/intercepting-proxy";
import { layer } from "../../testing/it-effect";
import { pullRequest } from "../../testing/pull-requests";
import { MarkReadyForReview } from "./documents";
import { PullRequestNumberSchema, WorkflowRunIdSchema } from "./types";

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const runsPath = (page: number) =>
  `/repos/owner/name/actions/runs?branch=claude%2Fa&head_sha=abc&per_page=100&page=${page}`;

layer(gitHubThroughProxy)("unfinishedRuns", (it) => {
  it("lists the runs that haven't completed from every page, until one comes back short", () =>
    Effect.gen(function* () {
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
      const outcome = yield* callGitHub(
        ({ path }) => pages[path],
        (github) => github.unfinishedRuns({ branch: "claude/a", commit: "abc" }),
      );
      expect(outcome).toStrictEqual({
        requests: [`GET api.github.com${runsPath(1)}`, `GET api.github.com${runsPath(2)}`],
        result: [WorkflowRunIdSchema.make("100"), WorkflowRunIdSchema.make("101")],
      });
    }));

  it("fails with the page it read, for an error response", () =>
    Effect.gen(function* () {
      const outcome = yield* callGitHub(
        () => new Reply(500, { message: "answered 500" }),
        (github) => failureOf(github.unfinishedRuns({ branch: "claude/a", commit: "abc" })),
      );
      expect(outcome).toStrictEqual({
        requests: [`GET api.github.com${runsPath(1)}`],
        result: {
          message: `GET ${runsPath(1)} returned 500: {"message":"answered 500"}`,
          status: 500,
        },
      });
    }));
});

const pullsPath = (page: number) =>
  `/repos/owner/name/pulls?head=owner%3Aclaude%2Fa&state=all&per_page=100&page=${page}`;

// Pull request `number` from branch `claude/a`, as GitHub lists it, and as `pullRequestsFrom` reads it.
const listed = (number: number, state: "closed" | "open") => ({
  github: {
    created_at: "2026-01-01T00:00:00Z",
    head: { sha: `head-${number}` },
    html_url: `https://github.com/kkom/jj-octo/pull/${number}`,
    merged_at: null,
    number,
    state,
    title: `Pull request ${number}`,
  },
  read: pullRequest(number, state === "open" ? "ready" : "closed", `head-${number}`),
});

layer(gitHubThroughProxy)("pullRequestsFrom", (it) => {
  it("lists the pull requests from every page, until one comes back short", () =>
    Effect.gen(function* () {
      // A full first page, then a short one.
      const all = [
        listed(101, "open"),
        ...Array.from({ length: 100 }, (_, index) => listed(100 - index, "closed")),
      ];
      const pages: Readonly<Record<string, unknown>> = {
        [pullsPath(1)]: EffectArray.map(all.slice(0, 100), ({ github }) => github),
        [pullsPath(2)]: EffectArray.map(all.slice(100), ({ github }) => github),
      };
      const outcome = yield* callGitHub(
        ({ path }) => pages[path],
        (github) => github.pullRequestsFrom("claude/a"),
      );
      expect(outcome).toStrictEqual({
        requests: [`GET api.github.com${pullsPath(1)}`, `GET api.github.com${pullsPath(2)}`],
        result: EffectArray.map(all, ({ read }) => read),
      });
    }));
});

// Cancels run 7 where GitHub answers the cancel with the status, and returns the outcome or how it
// failed, with the requests GitHub received.
const cancel = (status: number) =>
  callGitHub(
    () => new Reply(status, { message: `answered ${status}` }),
    (github) =>
      github.cancelRun(WorkflowRunIdSchema.make("7")).pipe(
        Effect.map((outcome) => ({ outcome })),
        Effect.catchTag("GitHubFailed", ({ message, status: failed }) =>
          Effect.succeed({ failed: { message, status: failed } }),
        ),
      ),
  );

layer(gitHubThroughProxy)("cancelRun", (it) => {
  const request = "POST api.github.com/repos/owner/name/actions/runs/7/cancel";

  it("cancels a run GitHub accepts the cancel of", () =>
    Effect.gen(function* () {
      const outcome = yield* cancel(202);
      expect(outcome).toStrictEqual({
        requests: [request],
        result: { outcome: "cancelled" },
      });
    }));

  it("reads GitHub's 409 as a run that had finished", () =>
    Effect.gen(function* () {
      const outcome = yield* cancel(409);
      expect(outcome).toStrictEqual({
        requests: [request],
        result: { outcome: "finished" },
      });
    }));

  it("fails with GitHub's own words for any other error", () =>
    Effect.gen(function* () {
      const outcome = yield* cancel(403);
      expect(outcome).toStrictEqual({
        requests: [request],
        result: {
          failed: {
            message:
              'POST /repos/owner/name/actions/runs/7/cancel returned 403: {"message":"answered 403"}',
            status: 403,
          },
        },
      });
    }));
});

// The bodies of the requests GitHub received at the path, or at every path, as JSON.
const bodiesSent = (path?: string) =>
  InterceptingProxy.use(({ requests }) => requests).pipe(
    Effect.map((requests) =>
      EffectArray.map(
        EffectArray.filter(requests, (request) => path === undefined || request.path === path),
        ({ body }) => Result.getOrThrow(decodeJson(body)),
      ),
    ),
  );

layer(gitHubThroughProxy)("closing a pull request", (it) => {
  it("sets the pull request's state to closed, then comments on the pull request's issue", () =>
    Effect.gen(function* () {
      const { requests } = yield* callGitHub(
        () => ({}),
        (github) =>
          github
            .closePullRequest(PullRequestNumberSchema.make(7))
            .pipe(
              Effect.andThen(github.commentOnPullRequest(PullRequestNumberSchema.make(7), "why")),
            ),
      );
      expect({ bodies: yield* bodiesSent(), requests }).toStrictEqual({
        bodies: [{ state: "closed" }, { body: "why" }],
        requests: [
          "PATCH api.github.com/repos/owner/name/pulls/7",
          "POST api.github.com/repos/owner/name/issues/7/comments",
        ],
      });
    }));
});

// Marks #7 ready for review, against a GitHub whose GraphQL API answers with `graphql`, and returns
// the outcome or how it failed, with the body of each GraphQL request and the requests GitHub
// received.
const markReady = (graphql: unknown, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const outcome = yield* callGitHub(
      ({ path }) => {
        if (path === "/graphql") {
          return graphql;
        }
        return path === "/repos/owner/name/pulls/7" ? { node_id: "PR_seven" } : {};
      },
      (github) =>
        github.markReadyForReview(PullRequestNumberSchema.make(7)).pipe(
          Effect.as({ marked: true }),
          Effect.catchTag("GitHubFailed", ({ message }) => Effect.succeed({ failed: message })),
          withEnvironment(env),
        ),
    );
    return { ...outcome, bodies: yield* bodiesSent("/graphql") };
  });

layer(gitHubThroughProxy)("markReadyForReview", (it) => {
  const graphqlRequests = [
    "GET api.github.com/repos/owner/name/pulls/7",
    "POST api.github.com/graphql",
  ];
  const graphqlBody = {
    query: MarkReadyForReview.toString(),
    variables: { pullRequestId: "PR_seven" },
  };

  it("sends GraphQL's mutation for the pull request's node id", () =>
    Effect.gen(function* () {
      const outcome = yield* markReady({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      });
      expect(outcome).toStrictEqual({
        bodies: [graphqlBody],
        requests: graphqlRequests,
        result: { marked: true },
      });
    }));

  it("fails with the errors GitHub returns beside a 200", () =>
    Effect.gen(function* () {
      const outcome = yield* markReady({
        data: { markPullRequestReadyForReview: null },
        errors: [{ message: "Resource not accessible by integration" }],
      });
      expect(outcome).toStrictEqual({
        bodies: [graphqlBody],
        requests: graphqlRequests,
        result: {
          failed: "marking #7 ready for review failed: Resource not accessible by integration",
        },
      });
    }));

  it("uses the GitHub proxy's own route in a Claude Code cloud session", () =>
    Effect.gen(function* () {
      const outcome = yield* markReady({}, { CLAUDE_CODE_REMOTE: "true" });
      expect(outcome).toStrictEqual({
        bodies: [],
        requests: ["POST api.github.com/repos/owner/name/pulls/7/ccr/ready_for_review"],
        result: { marked: true },
      });
    }));
});
