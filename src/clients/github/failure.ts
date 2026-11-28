import { Effect, Schema } from "effect";
import { type HttpClientRequest, type HttpClientResponse, UrlParams } from "effect/http";

export class GitHubFailed extends Schema.TaggedError<
  GitHubFailed,
  { readonly brand: unique symbol }
>()("GitHubFailed", {
  message: Schema.String,
  /** The status of GitHub's error response, if it sent one. */
  status: Schema.optionalKey(Schema.Finite),
}) {}

/** The request's URL with its query, which `HttpClientRequest` keeps in `urlParams`. */
export const urlOf = ({ url, urlParams }: HttpClientRequest.HttpClientRequest): string =>
  urlParams.params.length === 0 ? url : `${url}?${UrlParams.toString(urlParams)}`;

// The message keeps GitHub's own words, which say what to change, such as the field a 422 rejected.
export const failWith = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, GitHubFailed> =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((text) =>
      Effect.fail(
        GitHubFailed.make({
          message: `${request.method} ${urlOf(request)} returned ${response.status}: ${text}`,
          status: response.status,
        }),
      ),
    ),
  );
