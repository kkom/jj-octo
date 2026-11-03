import { describe, expect, it } from "bun:test";

import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { type InterceptedRequest, Reply, throughProxy } from "../../testing/intercepting-proxy";
import { GitHub, GitHubLive } from "./client";
import { WorkflowRunIdSchema } from "./types";

// Runs `use` with the real client, against a GitHub that answers as `respond` does. Returns what
// it produced and the requests GitHub received, without the proxy's CONNECTs.
const withGitHub = async <A>(
  respond: (request: InterceptedRequest) => unknown,
  use: (github: GitHub["Service"]) => Effect.Effect<A, unknown>,
) => {
  const { log, result } = await throughProxy("api.github.com", respond, ({ ca, url }) => {
    const live = GitHubLive(
      { name: "name", owner: "owner" },
      { proxy: Option.some({ ca: Option.some(ca), url }), token: Redacted.make("test-token") },
    );
    return Effect.runPromise(
      GitHub.use(use).pipe(Effect.provide(live), Effect.provide(FetchHttpClient.layer)),
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
