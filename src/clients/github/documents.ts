import { graphql } from "./graphql";

// The GraphQL documents jj-octo sends, which GraphQL Code Generator types (`codegen.ts`).

// GitHub's REST API can open a pull request ready for review, but can't make a draft ready. Only
// its GraphQL API can, with this mutation, which names the pull request by its node id.
export const MarkReadyForReview = graphql(`
  mutation MarkReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        isDraft
      }
    }
  }
`);
