import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";

import type { GitHubFailed } from "./failure";
import { bodyOf } from "./openapi";
import type { Requests } from "./requests";
import type { PullRequestNumber } from "./types";

export interface PullRequestWrites {
  readonly closePullRequest: (pullRequest: PullRequestNumber) => Effect.Effect<void, GitHubFailed>;
  readonly commentOnPullRequest: (
    pullRequest: PullRequestNumber,
    body: string,
  ) => Effect.Effect<void, GitHubFailed>;
  readonly setBase: (
    pullRequest: PullRequestNumber,
    base: string,
  ) => Effect.Effect<void, GitHubFailed>;
  readonly setDescription: (
    pullRequest: PullRequestNumber,
    description: { readonly body: string; readonly title: string },
  ) => Effect.Effect<void, GitHubFailed>;
}

export const pullRequestWrites = (
  { send }: Requests,
  repo: (path: string) => string,
): PullRequestWrites => {
  const update = (
    pullRequest: PullRequestNumber,
    changes: {
      readonly base?: string;
      readonly body?: string;
      readonly state?: "closed";
      readonly title?: string;
    },
  ) =>
    send(
      HttpClientRequest.patch(repo(`/pulls/${pullRequest}`)).pipe(bodyOf<"pulls/update">(changes)),
    ).pipe(Effect.asVoid);
  return {
    closePullRequest: (pullRequest) => update(pullRequest, { state: "closed" }),
    // GitHub keeps a pull request's own comments with its issue.
    commentOnPullRequest: (pullRequest, body) =>
      send(
        HttpClientRequest.post(repo(`/issues/${pullRequest}/comments`)).pipe(
          bodyOf<"issues/create-comment">({ body }),
        ),
      ).pipe(Effect.asVoid),
    setBase: (pullRequest, base) => update(pullRequest, { base }),
    setDescription: (pullRequest, { body, title }) => update(pullRequest, { body, title }),
  };
};
