import {
  Array as EffectArray,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  Option,
  Redacted,
  String as EffectString,
} from "effect";
import { FetchHttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import { GitHub, GitHubLive } from "../clients/github/client";
import {
  type InterceptedRequest,
  InterceptingProxy,
  interceptingProxy,
} from "./intercepting-proxy";

/**
 * The real client for the repository `owner/name`, sending its requests through an intercepting
 * proxy for `api.github.com`, which answers as `callGitHub` tells it.
 */
export const gitHubThroughProxy: Layer.Layer<
  GitHub | InterceptingProxy,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.unwrap(
  Effect.map(InterceptingProxy, ({ ca, url }) =>
    GitHubLive(
      { name: "name", owner: "owner" },
      { proxy: Option.some({ ca: Option.some(ca), url }), token: Redacted.make("test-token") },
    ),
  ),
).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(interceptingProxy("api.github.com")),
);

/**
 * Answers GitHub's requests as `respond` does, and runs `use` with the client. Returns what it
 * produced and the requests GitHub received, without the proxy's CONNECTs.
 */
export const callGitHub = <A, E>(
  respond: (request: InterceptedRequest) => unknown,
  use: (github: GitHub["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<
  { readonly requests: readonly string[]; readonly result: A },
  E,
  GitHub | InterceptingProxy
> =>
  Effect.gen(function* () {
    const proxy = yield* InterceptingProxy;
    yield* proxy.answer(respond);
    const result = yield* GitHub.use(use);
    const log = yield* proxy.log;
    return {
      requests: EffectArray.filter(log, (line) => !EffectString.startsWith("CONNECT ")(line)),
      result,
    };
  });

// The search for open and approved pull requests with the terms, and the page it reads.
export const searchPath = (terms: string, page = 1): string =>
  `/search/issues?${new URLSearchParams([
    ["order", "asc"],
    ["q", `repo:owner/name is:pr is:open review:approved ${terms}`],
    ["sort", "created"],
    ["per_page", "100"],
    ["page", String(page)],
  ]).toString()}`;
