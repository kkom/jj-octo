import { graphql } from "./graphql";

// The GraphQL documents jj-octo sends, typed by GraphQL Code Generator (`codegen.ts`).

// Only GitHub's GraphQL API can make a draft ready for review.
export const MarkReadyForReview = graphql(`
  mutation MarkReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        isDraft
      }
    }
  }
`);
