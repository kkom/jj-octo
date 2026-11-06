import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { GitHub, GitHubLive } from "../clients/github/client";
import type { GitHubFailed } from "../clients/github/failure";
import { environment } from "./environment";
import { type InterceptedRequest, throughProxy } from "./intercepting-proxy";

// Runs `use` with the real client, against a GitHub that answers as `respond` does, with `env` as
// the environment. Returns what it produced and the requests GitHub received, without the proxy's
// CONNECTs.
export const withGitHub = async <A>(
  respond: (request: InterceptedRequest) => unknown,
  use: (github: GitHub["Service"]) => Effect.Effect<A, unknown>,
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly requests: readonly string[]; readonly result: A }> => {
  const { log, result } = await throughProxy("api.github.com", respond, ({ ca, url }) => {
    const live = GitHubLive(
      { name: "name", owner: "owner" },
      { proxy: Option.some({ ca: Option.some(ca), url }), token: Redacted.make("test-token") },
    );
    return Effect.runPromise(
      GitHub.use(use).pipe(
        Effect.provide(live),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(environment(env)),
      ),
    );
  });
  return { requests: log.filter((line) => !line.startsWith("CONNECT ")), result };
};

// The effect's result, or the message and status it failed with.
export const failureOf = <A>(
  effect: Effect.Effect<A, GitHubFailed>,
): Effect.Effect<A | { readonly message: string; readonly status: number | undefined }> =>
  effect.pipe(
    Effect.catchTag("GitHubFailed", ({ message, status }) => Effect.succeed({ message, status })),
  );

// The search for open and approved pull requests with the terms, and the page it reads.
export const searchPath = (terms: string, page = 1): string =>
  `/search/issues?${new URLSearchParams([
    ["order", "asc"],
    ["q", `repo:owner/name is:pr is:open review:approved ${terms}`],
    ["sort", "created"],
    ["per_page", "100"],
    ["page", String(page)],
  ]).toString()}`;
