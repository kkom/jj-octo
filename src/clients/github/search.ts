import { Array as EffectArray, Effect, Order, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { GitHubFailed, urlOf } from "./failure";
import { everyPage } from "./pages";
import type { Repository } from "./repository";
import type { Requests } from "./requests";
import { FoundPullRequests } from "./responses";
import type { ListedPullRequest, PullRequestNumber } from "./types";

// GitHub's search fails on query text longer than this, qualifiers excluded.
const MAX_SEARCH_TEXT = 256;

// GitHub's search lists at most this many results, and fails on a page beyond them.
const MAX_SEARCH_RESULTS = 1000;

export type SearchedPullRequest = Pick<ListedPullRequest, "createdAt" | "number">;

class TooManyResults extends Schema.TaggedError<
  TooManyResults,
  { readonly brand: unique symbol }
>()("TooManyResults", {
  count: Schema.Finite,
  url: Schema.String,
}) {}

/** Batches whose space-separated numbers fit in one search's text. */
const splitIntoBatches = (
  pullRequests: readonly SearchedPullRequest[],
): readonly (readonly SearchedPullRequest[])[] => {
  const batches: { pullRequests: SearchedPullRequest[]; textLength: number }[] = [];
  for (const pullRequest of pullRequests) {
    const digits = String(pullRequest.number).length;
    const batch = batches.at(-1);
    if (batch !== undefined && batch.textLength + 1 + digits <= MAX_SEARCH_TEXT) {
      batch.pullRequests.push(pullRequest);
      batch.textLength += 1 + digits;
    } else {
      batches.push({ pullRequests: [pullRequest], textLength: digits });
    }
  }
  return EffectArray.map(batches, ({ pullRequests: batch }) => batch);
};

const search = (
  { json }: Requests,
  { name, owner }: Repository,
  terms: readonly string[],
): Effect.Effect<readonly PullRequestNumber[], GitHubFailed | TooManyResults> =>
  everyPage(
    // Without `sort`, search ranks by best match, which can change between pages.
    HttpClientRequest.get("/search/issues", {
      urlParams: {
        order: "asc",
        q: EffectArray.join(
          [`repo:${owner}/${name}`, "is:pr", "is:open", "review:approved", ...terms],
          " ",
        ),
        sort: "created",
      },
    }),
    (request) =>
      json(FoundPullRequests)(request).pipe(
        Effect.flatMap(
          ({
            incomplete_results,
            items,
            total_count,
          }): Effect.Effect<readonly PullRequestNumber[], GitHubFailed | TooManyResults> => {
            // At exactly the limit, the last page is full, so the next page's request fails.
            if (total_count >= MAX_SEARCH_RESULTS) {
              return Effect.fail(TooManyResults.make({ count: total_count, url: urlOf(request) }));
            }
            // A search that timed out returns what it found so far.
            if (incomplete_results) {
              return Effect.fail(
                GitHubFailed.make({
                  message: `GET ${urlOf(request)} timed out with partial results`,
                }),
              );
            }
            return Effect.succeed(EffectArray.map(items, ({ number }) => number));
          },
        ),
      ),
  );

// The creation time range excludes most pull requests that only mention a number.
const searchBatch = (
  requests: Requests,
  repository: Repository,
  batch: readonly SearchedPullRequest[],
): Effect.Effect<readonly PullRequestNumber[], GitHubFailed> =>
  search(requests, repository, [
    ...EffectArray.map(batch, ({ number }) => String(number)),
    `created:${batch.at(0)?.createdAt}..${batch.at(-1)?.createdAt}`,
  ]).pipe(
    Effect.catchTag("TooManyResults", ({ count, url }) => {
      const [only, ...others] = batch;
      if (only !== undefined && others.length === 0) {
        return Effect.fail(
          GitHubFailed.make({
            message: `GET ${url} matched ${count} pull requests, too many to list, so whether #${only.number} is approved is unknown`,
          }),
        );
      }
      const half = Math.ceil(batch.length / 2);
      return Effect.forEach(
        [batch.slice(0, half), batch.slice(half)],
        (part) => searchBatch(requests, repository, part),
        { concurrency: 1 },
      ).pipe(Effect.map((found) => found.flat()));
    }),
  );

/**
 * The pull requests GitHub's search lists as open and `review:approved`. Undocumented, but seen on
 * github.com: a bare number matches the pull request with that number, and several numbers match
 * any of them. A number also matches pull requests that mention it, so only those asked about
 * count. Searches run one at a time, under GitHub's secondary rate limits.
 *
 * Where reviews are required, `review:approved` is GitHub's review decision, so a change request
 * still counts after another approval. Where none are, search lists a pull request with any
 * approval as approved; how a change request counts there is unchecked. Search reads an index,
 * which on github.com showed a title edit 6 seconds late.
 */
export const approvedPullRequests = (
  requests: Requests,
  repository: Repository,
  pullRequests: readonly SearchedPullRequest[],
): Effect.Effect<ReadonlySet<PullRequestNumber>, GitHubFailed> =>
  // Sorted by creation, each batch's time range is narrowest. GitHub writes times in UTC in one
  // format, so they sort as text.
  Effect.forEach(
    splitIntoBatches(
      EffectArray.sort(
        pullRequests,
        Order.mapInput(Order.String, ({ createdAt }: SearchedPullRequest) => createdAt),
      ),
    ),
    (batch) => searchBatch(requests, repository, batch),
    { concurrency: 1 },
  ).pipe(
    Effect.map((found) => {
      const asked = new Set(EffectArray.map(pullRequests, ({ number }) => number));
      return new Set(EffectArray.filter(found.flat(), (number) => asked.has(number)));
    }),
  );
