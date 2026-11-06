import type { Effect, Schema } from "effect";
import type { HttpClientRequest, HttpClientResponse } from "effect/http";

import type { GitHubFailed } from "./failure";

/** The client's requests: one that fails on an error status, and one that also decodes the body. */
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
