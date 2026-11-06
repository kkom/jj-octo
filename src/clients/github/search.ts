import { Data, Effect, Order } from "effect";
import { HttpClientRequest } from "effect/http";

import { GitHubFailed, urlOf } from "./failure";
import { everyPage } from "./pages";
import type { Repository } from "./repository";
import type { Requests } from "./requests";
import { FoundPullRequests } from "./responses";
import type { ListedPullRequest, PullRequestNumber } from "./types";

// GitHub's search fails on a query whose text is longer than this, not counting its qualifiers.
const MAX_SEARCH_TEXT = 256;

// GitHub's search lists at most this many results, and fails on a request for a page beyond them.
const MAX_SEARCH_RESULTS = 1000;

/** A pull request to search for, by its number and the time GitHub created it. */
export type SearchedPullRequest = Pick<ListedPullRequest, "createdAt" | "number">;

/** A search that matched more pull requests than it can list. */
class TooManyResults extends Data.TaggedError("TooManyResults")<{
  readonly count: number;
  readonly url: string;
}> {}

/**
 * Splits the pull requests into batches whose numbers, separated by spaces, fit in one search's
 * text.
 */
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
  return batches.map(({ pullRequests: batch }) => batch);
};

/** The open and approved pull requests that a search with the terms lists, from every page. */
const search = (
  { json }: Requests,
  { name, owner }: Repository,
  terms: readonly string[],
): Effect.Effect<readonly PullRequestNumber[], GitHubFailed | TooManyResults> =>
  everyPage(
    // Search ranks by best match without a `sort`, and the ranking can change between pages.
    HttpClientRequest.get("/search/issues", {
      urlParams: {
        order: "asc",
        q: [`repo:${owner}/${name}`, "is:pr", "is:open", "review:approved", ...terms].join(" "),
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
            // Exactly as many results as the limit fill the last page, so a request follows for
            // the one after it, which fails.
            if (total_count >= MAX_SEARCH_RESULTS) {
              return Effect.fail(new TooManyResults({ count: total_count, url: urlOf(request) }));
            }
            // GitHub answers a search that timed out with what it found so far.
            if (incomplete_results) {
              return Effect.fail(
                new GitHubFailed({
                  message: `GET ${urlOf(request)} timed out, and listed only some pull requests`,
                }),
              );
            }
            return Effect.succeed(items.map(({ number }) => number));
          },
        ),
      ),
  );

/**
 * The approved pull requests that a search for the batch lists. It searches by their numbers and by
 * the range of times they were created in. The range keeps out most pull requests that only
 * mention a number. Where the search matches too many, `searchBatch` searches for each half of the
 * batch, down to one pull request.
 */
const searchBatch = (
  requests: Requests,
  repository: Repository,
  batch: readonly SearchedPullRequest[],
): Effect.Effect<readonly PullRequestNumber[], GitHubFailed> =>
  search(requests, repository, [
    ...batch.map(({ number }) => String(number)),
    `created:${batch.at(0)?.createdAt}..${batch.at(-1)?.createdAt}`,
  ]).pipe(
    Effect.catchTag("TooManyResults", ({ count, url }) => {
      const [only, ...others] = batch;
      if (only !== undefined && others.length === 0) {
        return Effect.fail(
          new GitHubFailed({
            message: `GET ${url} matched ${count} pull requests, at least the ${MAX_SEARCH_RESULTS} that search lists, so whether #${only.number} is approved is unknown`,
          }),
        );
      }
      const half = Math.ceil(batch.length / 2);
      return Effect.forEach([batch.slice(0, half), batch.slice(half)], (part) =>
        searchBatch(requests, repository, part),
      ).pipe(Effect.map((found) => found.flat()));
    }),
  );

/**
 * Those of the pull requests that GitHub's search lists as open and approved, with
 * `review:approved`. A bare number in a search matches the pull request with that number. Several
 * numbers match any of them. GitHub documents neither; requests to github.com showed both. A
 * number also matches a pull request that mentions it, so only the numbers asked about count.
 * The searches run one after another, as GitHub asks of search requests to stay under its
 * secondary rate limits.
 *
 * In a repository that requires reviews, `review:approved` is GitHub's own review decision, so a
 * request for changes still counts after another reviewer approves. In a repository that requires
 * none, search still lists a pull request with an approval as approved. How it treats a request
 * for changes there is unchecked. Search answers from an index. In a request to github.com, the
 * index listed an edit to a pull request's title 6 seconds after the edit.
 */
export const approvedPullRequests = (
  requests: Requests,
  repository: Repository,
  pullRequests: readonly SearchedPullRequest[],
): Effect.Effect<ReadonlySet<PullRequestNumber>, GitHubFailed> =>
  // In order of creation, each batch's range of creation times is as narrow as it can be. GitHub
  // writes each time in UTC in one format, so it sorts as text.
  Effect.forEach(
    splitIntoBatches(
      pullRequests.toSorted(Order.mapInput(Order.String, ({ createdAt }) => createdAt)),
    ),
    (batch) => searchBatch(requests, repository, batch),
  ).pipe(
    Effect.map((found) => {
      const asked = new Set(pullRequests.map(({ number }) => number));
      return new Set(found.flat().filter((number) => asked.has(number)));
    }),
  );
