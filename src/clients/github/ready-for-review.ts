import { Effect, Schema } from "effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";

import { claudeCodeCloudSession } from "../../settings";
import { MarkReadyForReview } from "./documents";
import { GitHubFailed } from "./failure";
import type {
  MarkReadyForReviewMutation,
  MarkReadyForReviewMutationVariables,
} from "./graphql/graphql";
import { graphqlResponseOf, PullRequestNodeId } from "./responses";
import type { PullRequestNumber } from "./types";

// Marking a draft ready for review, which GitHub's REST API can't do.

/** The client's requests: one that fails on an error status, and one that also decodes the body. */
interface Requests {
  readonly json: <S extends Schema.Top>(
    schema: S,
  ) => (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<S["Type"], GitHubFailed, S["DecodingServices"]>;
  readonly send: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, GitHubFailed>;
}

const MarkedPullRequest = Schema.Struct({
  pullRequest: Schema.NullOr(Schema.Struct({ isDraft: Schema.Boolean })),
});

const MarkedReadyForReview = graphqlResponseOf<MarkReadyForReviewMutation>()(
  Schema.Struct({ markPullRequestReadyForReview: Schema.NullOr(MarkedPullRequest) }),
);

/** The GraphQL request that marks the pull request with the node id ready for review. */
const markReadyRequest = (pullRequestId: string): HttpClientRequest.HttpClientRequest => {
  const variables: MarkReadyForReviewMutationVariables = { pullRequestId };
  return HttpClientRequest.post("/graphql").pipe(
    HttpClientRequest.bodyJsonUnsafe({ query: MarkReadyForReview.toString(), variables }),
  );
};

/**
 * Fails where GitHub's answer to `markReadyRequest` has errors, which it sends with a 200, or
 * leaves the pull request a draft.
 */
const checkMarkedReady = (
  pullRequest: PullRequestNumber,
  { data, errors = [] }: typeof MarkedReadyForReview.Type,
): Effect.Effect<void, GitHubFailed> => {
  if (errors.length > 0) {
    return Effect.fail(
      new GitHubFailed({
        message: `marking #${pullRequest} ready for review failed: ${errors.map(({ message }) => message).join("; ")}`,
      }),
    );
  }
  return data?.markPullRequestReadyForReview?.pullRequest?.isDraft === false
    ? Effect.void
    : Effect.fail(
        new GitHubFailed({ message: `marking #${pullRequest} ready for review left it a draft` }),
      );
};

/**
 * Marks the draft pull request at `pullPath` ready for review: through GraphQL's
 * `markPullRequestReadyForReview`, or in a Claude Code cloud session, whose GitHub proxy rejects
 * GraphQL, through the proxy's own route for it.
 */
export const markReadyForReview = (
  { json, send }: Requests,
  pullPath: string,
  pullRequest: PullRequestNumber,
): Effect.Effect<void, GitHubFailed> =>
  Effect.flatMap(claudeCodeCloudSession, (cloudSession) =>
    cloudSession
      ? Effect.asVoid(send(HttpClientRequest.post(`${pullPath}/ccr/ready_for_review`)))
      : json(PullRequestNodeId)(HttpClientRequest.get(pullPath)).pipe(
          Effect.flatMap(({ node_id }) => json(MarkedReadyForReview)(markReadyRequest(node_id))),
          Effect.flatMap((response) => checkMarkedReady(pullRequest, response)),
        ),
  );
