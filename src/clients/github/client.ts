import {
  Array as EffectArray,
  Context,
  Effect,
  Layer,
  Option,
  Schedule,
  type Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { type CheckReads, checkReads } from "./checks";
import type { Connection } from "./connection";
import { failWith, GitHubFailed, urlOf } from "./failure";
import { bodyOf } from "./openapi";
import { everyPage } from "./pages";
import { type PullRequestWrites, pullRequestWrites } from "./pull-request-writes";
import { markReadyForReview } from "./ready-for-review";
import type { Repository } from "./repository";
import {
  AnyPullRequests,
  CreatedPullRequest,
  CreatedStack,
  listedPullRequest,
  remoteStack,
  MergeResult,
  PullRequests,
  RepositoryDetails,
  Stacks,
  StartedMerge,
  WorkflowRuns,
} from "./responses";
import { approvedPullRequests, type SearchedPullRequest } from "./search";
import {
  type PullRequest,
  type ListedPullRequest,
  type PullRequestNumber,
  type RemoteStack,
  type StackNumber,
  type WorkflowRunId,
  WorkflowRunIdSchema,
} from "./types";

export type MergeOutcome = "enqueued" | "merged";

/** `finished` means the run completed before GitHub received the cancel. */
export type CancelOutcome = "cancelled" | "finished";

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly addToStack: (
      stack: StackNumber,
      pullRequests: readonly PullRequestNumber[],
    ) => Effect.Effect<void, GitHubFailed>;
    readonly approvedPullRequests: (
      pullRequests: readonly SearchedPullRequest[],
    ) => Effect.Effect<ReadonlySet<PullRequestNumber>, GitHubFailed>;
    readonly cancelRun: (run: WorkflowRunId) => Effect.Effect<CancelOutcome, GitHubFailed>;
    readonly createPullRequest: (pullRequest: {
      readonly base: string;
      readonly body: string;
      readonly draft: boolean;
      readonly head: string;
      readonly title: string;
    }) => Effect.Effect<PullRequestNumber, GitHubFailed>;
    readonly createStack: (
      pullRequests: readonly PullRequestNumber[],
    ) => Effect.Effect<StackNumber, GitHubFailed>;
    readonly defaultBranch: Effect.Effect<string, GitHubFailed>;
    readonly markReadyForReview: (
      pullRequest: PullRequestNumber,
    ) => Effect.Effect<void, GitHubFailed>;
    /** Merges the pull request and everything below it through its stack. */
    readonly mergeStack: (
      pullRequest: PullRequestNumber,
    ) => Effect.Effect<MergeOutcome, GitHubFailed>;
    readonly mergePullRequest: (
      pullRequest: PullRequestNumber,
    ) => Effect.Effect<void, GitHubFailed>;
    readonly openPullRequest: (
      branch: string,
    ) => Effect.Effect<Option.Option<PullRequest>, GitHubFailed>;
    /** In any state, newest first. */
    readonly pullRequestsFrom: (
      branch: string,
    ) => Effect.Effect<readonly ListedPullRequest[], GitHubFailed>;
    readonly stackOf: (
      pullRequest: PullRequestNumber,
    ) => Effect.Effect<Option.Option<RemoteStack>, GitHubFailed>;
    /**
     * Excludes runs on other branches with that head commit, such as the trunk's push run after a
     * fast-forward merge.
     */
    readonly unfinishedRuns: (head: {
      readonly branch: string;
      readonly commit: string;
    }) => Effect.Effect<readonly WorkflowRunId[], GitHubFailed>;
    /** The stack's pull requests stay open. */
    readonly unstack: (stack: StackNumber) => Effect.Effect<void, GitHubFailed>;
  } & CheckReads &
    PullRequestWrites
>()("jj-octo/clients/github/client/GitHub") {}

export const GitHubLive = (
  repository: Repository,
  connection: Connection,
): Layer.Layer<GitHub, never, HttpClient.HttpClient> => {
  // A cloud session's proxy allows only paths under the repository and `/search/issues`, so other
  // REST calls go under the repository. Only `markReadyForReview` outside a cloud session calls
  // `/graphql`.
  const repo = (path: string): string => `/repos/${repository.owner}/${repository.name}${path}`;
  return Layer.effect(
    GitHub,
    Effect.gen(function* () {
      // Bun's fetch takes a proxy, and certificate authorities replacing its own.
      const requestInit: BunFetchRequestInit = Option.match(connection.proxy, {
        onNone: () => ({}),
        onSome: ({ ca, url }) =>
          Option.match(ca, {
            onNone: () => ({ proxy: url }),
            onSome: (certificates) => ({ proxy: url, tls: { ca: certificates } }),
          }),
      });
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl("https://api.github.com"),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(connection.token),
            HttpClientRequest.setHeaders({
              "user-agent": "jj-octo",
              "x-github-api-version": "2022-11-28",
            }),
          ),
        ),
      );

      const send = (request: HttpClientRequest.HttpClientRequest) =>
        client.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, requestInit),
          Effect.catchTag("HttpClientError", (error) =>
            Effect.fail(GitHubFailed.make({ message: error.message })),
          ),
          Effect.filterOrElse(
            (response) => response.status < 400,
            (response) => failWith(request, response),
          ),
        );

      const json =
        <S extends Schema.Top>(schema: S) =>
        (request: HttpClientRequest.HttpClientRequest) =>
          send(request).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.catchTags({
              HttpClientError: (error) =>
                Effect.fail(GitHubFailed.make({ message: error.message })),
              SchemaError: (error) =>
                Effect.fail(
                  GitHubFailed.make({
                    message: `unexpected response to ${urlOf(request)}: ${error.message}`,
                  }),
                ),
            }),
          );

      const stackOf = (pullRequest: PullRequestNumber) =>
        json(Stacks)(
          HttpClientRequest.get(repo("/stacks"), { urlParams: { pull_request: pullRequest } }),
        ).pipe(
          Effect.map((stacks) =>
            Option.map(Option.fromNullishOr(stacks[0]), (stack) => remoteStack(stack)),
          ),
        );

      const mergeRequest = (path: string) => json(MergeResult)(HttpClientRequest.get(repo(path)));

      const fromBranch = (branch: string, state: "all" | "open") =>
        HttpClientRequest.get(repo("/pulls"), {
          urlParams: { head: `${repository.owner}:${branch}`, state },
        });

      return {
        addToStack: (stack, pullRequests) =>
          send(
            HttpClientRequest.post(repo(`/stacks/${stack}/add`)).pipe(
              bodyOf<"pull-request-stacks/add">({ pull_requests: [...pullRequests] }),
            ),
          ).pipe(Effect.asVoid),
        approvedPullRequests: (pullRequests) =>
          approvedPullRequests({ json, send }, repository, pullRequests),
        ...checkReads({ json, send }, repo),
        ...pullRequestWrites({ json, send }, repo),
        // GitHub answers 409 for a run that completed after it was listed.
        cancelRun: (run) =>
          send(HttpClientRequest.post(repo(`/actions/runs/${run}/cancel`))).pipe(
            Effect.as<CancelOutcome>("cancelled"),
            Effect.catchIf(
              ({ status }) => status === 409,
              () => Effect.succeed<CancelOutcome>("finished"),
            ),
          ),
        createPullRequest: ({ base, body, draft, head, title }) =>
          json(CreatedPullRequest)(
            HttpClientRequest.post(repo("/pulls")).pipe(
              bodyOf<"pulls/create">({ base, body, draft, head, title }),
            ),
          ).pipe(Effect.map(({ number }) => number)),
        createStack: (pullRequests) =>
          json(CreatedStack)(
            HttpClientRequest.post(repo("/stacks")).pipe(
              bodyOf<"pull-request-stacks/create">({ pull_requests: [...pullRequests] }),
            ),
          ).pipe(Effect.map(({ number }) => number)),
        defaultBranch: json(RepositoryDetails)(HttpClientRequest.get(repo(""))).pipe(
          Effect.map(({ default_branch }) => default_branch),
        ),
        markReadyForReview: (pullRequest) =>
          markReadyForReview({ json, send }, repo(`/pulls/${pullRequest}`), pullRequest),
        mergePullRequest: (pullRequest) =>
          send(
            HttpClientRequest.put(repo(`/pulls/${pullRequest}/merge`)).pipe(
              bodyOf<"pulls/merge">({ merge_method: "squash" }),
            ),
          ).pipe(Effect.asVoid),
        mergeStack: (pullRequest) =>
          Effect.gen(function* () {
            const started = yield* json(StartedMerge)(
              HttpClientRequest.put(repo(`/pulls/${pullRequest}/merge-async`)).pipe(
                bodyOf<"pulls/merge-async">({
                  merge_action: "default",
                  merge_method: "squash",
                }),
              ),
            );
            const { uuid } = started.details;
            if (uuid === undefined) {
              return yield* GitHubFailed.make({
                message: `merging #${pullRequest} returned no request to follow`,
              });
            }
            const settled = yield* mergeRequest(`/pulls/${pullRequest}/merge-async/${uuid}`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: ({ status }) => status !== "pending",
              }),
            );
            if (settled.status === "merged" || settled.status === "enqueued") {
              return settled.status;
            }
            return yield* GitHubFailed.make({
              message: `merging #${pullRequest} ended ${settled.status}: ${settled.details.message}`,
            });
          }),
        openPullRequest: (branch) =>
          json(PullRequests)(fromBranch(branch, "open")).pipe(
            Effect.map((found) =>
              Option.map(
                Option.fromNullishOr(found[0]),
                ({ base, body, draft, number, title }) => ({
                  base: base.ref,
                  body: body ?? "",
                  draft: draft ?? false,
                  number,
                  title,
                }),
              ),
            ),
          ),
        pullRequestsFrom: (branch) =>
          everyPage(fromBranch(branch, "all"), json(AnyPullRequests)).pipe(
            Effect.map((found) => EffectArray.map(found, (listed) => listedPullRequest(listed))),
          ),
        stackOf,
        unfinishedRuns: ({ branch, commit }) =>
          everyPage(
            HttpClientRequest.get(repo("/actions/runs"), {
              urlParams: { branch, head_sha: commit },
            }),
            (request) =>
              json(WorkflowRuns)(request).pipe(Effect.map(({ workflow_runs }) => workflow_runs)),
          ).pipe(
            Effect.map((runs) =>
              EffectArray.map(
                EffectArray.filter(runs, ({ status }) => status !== "completed"),
                ({ id }) => WorkflowRunIdSchema.make(String(id)),
              ),
            ),
          ),
        unstack: (stack) =>
          send(HttpClientRequest.post(repo(`/stacks/${stack}/unstack`))).pipe(Effect.asVoid),
      };
    }),
  );
};
