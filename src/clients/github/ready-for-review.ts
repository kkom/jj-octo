import { Array as EffectArray, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { claudeCodeCloudSession } from "../../settings";
import { MarkReadyForReview } from "./documents";
import { GitHubFailed } from "./failure";
import type {
  MarkReadyForReviewMutation,
  MarkReadyForReviewMutationVariables,
} from "./graphql/graphql";
import type { Requests } from "./requests";
import { graphqlResponseOf, PullRequestNodeId } from "./responses";
import type { PullRequestNumber } from "./types";

const MarkedPullRequest = Schema.Struct({
  pullRequest: Schema.NullOr(Schema.Struct({ isDraft: Schema.Boolean })),
});

const MarkedReadyForReview = graphqlResponseOf<MarkReadyForReviewMutation>()(
  Schema.Struct({ markPullRequestReadyForReview: Schema.NullOr(MarkedPullRequest) }),
);

const markReadyRequest = (pullRequestId: string): HttpClientRequest.HttpClientRequest => {
  const variables: MarkReadyForReviewMutationVariables = { pullRequestId };
  return HttpClientRequest.post("/graphql").pipe(
    HttpClientRequest.bodyJsonUnsafe({ query: MarkReadyForReview.toString(), variables }),
  );
};

// GitHub sends GraphQL errors with a 200.
const checkMarkedReady = (
  pullRequest: PullRequestNumber,
  { data, errors = [] }: typeof MarkedReadyForReview.Type,
): Effect.Effect<void, GitHubFailed> => {
  if (errors.length > 0) {
    return Effect.fail(
      GitHubFailed.make({
        message: `marking #${pullRequest} ready for review failed: ${EffectArray.join(
          EffectArray.map(errors, ({ message }) => message),
          "; ",
        )}`,
      }),
    );
  }
  return data?.markPullRequestReadyForReview?.pullRequest?.isDraft === false
    ? Effect.void
    : Effect.fail(
        GitHubFailed.make({ message: `marking #${pullRequest} ready for review left it a draft` }),
      );
};

/**
 * Marks the draft ready for review through GraphQL. In a Claude Code cloud session, whose GitHub
 * proxy rejects GraphQL, it uses the proxy's own route.
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
