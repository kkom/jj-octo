import type { Effect, Schema } from "effect";
import type { HttpClientRequest, HttpClientResponse } from "effect/http";

import type { GitHubFailed } from "./failure";

/** Both fail on an error status, and `json` also decodes the body. */
export interface Requests {
  readonly json: <S extends Schema.Top>(
    schema: S,
  ) => (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<S["Type"], GitHubFailed, S["DecodingServices"]>;
  readonly send: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, GitHubFailed>;
}
