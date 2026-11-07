import { Option, Schema } from "effect";

import { responseOf } from "./openapi";
import {
  type ListedPullRequest,
  PullRequestNumberSchema,
  type RemoteStack,
  StackNumberSchema,
} from "./types";

// The fields read from each GitHub response the client decodes.

export const CreatedPullRequest = responseOf<"pulls/create">()(
  Schema.Struct({ number: PullRequestNumberSchema }),
);
export const CreatedStack = responseOf<"pull-request-stacks/create">()(
  Schema.Struct({ number: StackNumberSchema }),
);
export const PullRequests = responseOf<"pulls/list">()(
  Schema.Array(
    Schema.Struct({
      base: Schema.Struct({ ref: Schema.String }),
      body: Schema.NullOr(Schema.String),
      draft: Schema.optionalKey(Schema.Boolean),
      number: PullRequestNumberSchema,
      title: Schema.String,
    }),
  ),
);
const StackOfPullRequest = Schema.Struct({ number: Schema.optionalKey(StackNumberSchema) });
export const AnyPullRequests = responseOf<"pulls/list">()(
  Schema.Array(
    Schema.Struct({
      created_at: Schema.String,
      draft: Schema.optionalKey(Schema.Boolean),
      head: Schema.Struct({ sha: Schema.String }),
      html_url: Schema.String,
      merged_at: Schema.NullOr(Schema.String),
      number: PullRequestNumberSchema,
      stack: Schema.optionalKey(Schema.NullOr(StackOfPullRequest)),
      state: Schema.String,
      title: Schema.String,
    }),
  ),
);
const StackedPullRequest = Schema.Struct({
  merged_at: Schema.NullOr(Schema.String),
  number: PullRequestNumberSchema,
});
export const Stacks = responseOf<"pull-request-stacks/list">()(
  Schema.Array(
    Schema.Struct({ number: StackNumberSchema, pull_requests: Schema.Array(StackedPullRequest) }),
  ),
);
export const PullRequestNodeId = responseOf<"pulls/get">()(
  Schema.Struct({ node_id: Schema.String }),
);
export const FoundPullRequests = responseOf<"search/issues-and-pull-requests">()(
  Schema.Struct({
    incomplete_results: Schema.Boolean,
    items: Schema.Array(Schema.Struct({ number: PullRequestNumberSchema })),
    total_count: Schema.Number,
  }),
);
export const RepositoryDetails = responseOf<"repos/get">()(
  Schema.Struct({ default_branch: Schema.String }),
);
const MergeRequest = Schema.Struct({
  details: Schema.Struct({
    message: Schema.String,
    uuid: Schema.optionalKey(Schema.String),
  }),
  status: Schema.Literals(["enqueued", "failed", "merged", "pending"]),
});
export const StartedMerge = responseOf<"pulls/merge-async">()(MergeRequest);
export const MergeResult = responseOf<"pulls/get-merge-async-result">()(MergeRequest);
// GitHub describes a run's id, an int64, as `number | bigint`, though JSON parses only to a number.
export const WorkflowRuns = responseOf<"actions/list-workflow-runs-for-repo">()(
  Schema.Struct({
    workflow_runs: Schema.Array(
      Schema.Struct({
        id: Schema.Union([Schema.Number, Schema.BigInt]),
        status: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

const GraphqlErrors = Schema.Array(Schema.Struct({ message: Schema.String }));

/** A GraphQL response: the fields read from its `data`, and the `errors` sent beside or in place of it. */
export type GraphqlResponse<S extends Schema.Top> = Schema.Struct<{
  readonly data: Schema.optionalKey<Schema.NullOr<S>>;
  readonly errors: Schema.optionalKey<typeof GraphqlErrors>;
}>;

/** A schema for `data`, provided the type GraphQL Code Generator wrote for the document decodes with it. */
type GraphqlDataSchema<Data, S extends Schema.Top> = S &
  ([Data] extends [S["Encoded"]] ? unknown : { readonly mismatch: "the generated type" });

/**
 * A schema for a GraphQL response: the fields read from its `data`, which doesn't compile unless
 * `Data`, the type GraphQL Code Generator wrote for the document, decodes with it, and the `errors`
 * GitHub sends beside or in place of `data`.
 */
export const graphqlResponseOf =
  <Data>() =>
  <S extends Schema.Top>(data: GraphqlDataSchema<Data, S>): GraphqlResponse<S> =>
    Schema.Struct({
      data: Schema.optionalKey(Schema.NullOr(data)),
      errors: Schema.optionalKey(GraphqlErrors),
    });

/** One pull request of an `AnyPullRequests` listing, with its state in one value. */
export const listedPullRequest = ({
  created_at,
  draft,
  head,
  html_url,
  merged_at,
  number,
  stack,
  state,
  title,
}: (typeof AnyPullRequests.Type)[number]): ListedPullRequest => {
  const open = draft === true ? "draft" : "ready";
  const closed = merged_at === null ? "closed" : "merged";
  return {
    createdAt: created_at,
    head: head.sha,
    number,
    // The stack's page is beside the pull request's: `…/pull/2` and `…/stack/7`.
    stack: Option.map(Option.fromNullishOr(stack?.number), (stackNumber) => ({
      number: stackNumber,
      url: new URL(`../stack/${stackNumber}`, html_url).href,
    })),
    state: state === "open" ? open : closed,
    title,
    url: html_url,
  };
};

/** One stack of a `Stacks` listing, with the pull requests that haven't merged, bottom to top. */
export const remoteStack = ({
  number,
  pull_requests,
}: (typeof Stacks.Type)[number]): RemoteStack => ({
  number,
  unmerged: pull_requests
    .filter(({ merged_at }) => merged_at === null)
    .map((pullRequest) => pullRequest.number),
});
