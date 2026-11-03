import { Data, Effect } from "effect";
import type { HttpClientRequest, HttpClientResponse } from "effect/http";

export class GitHubFailed extends Data.TaggedError("GitHubFailed")<{
  readonly message: string;
  /** The status of GitHub's error response, where it sent one. */
  readonly status?: number;
}> {}

// An error response keeps GitHub's own words, since they say what to change: a 422 naming the field
// it rejected, or the proxy naming a route a cloud session can't use.
export const failWith = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, GitHubFailed> =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((text) =>
      Effect.fail(
        new GitHubFailed({
          message: `${request.method} ${request.url} returned ${response.status}: ${text}`,
          status: response.status,
        }),
      ),
    ),
  );
