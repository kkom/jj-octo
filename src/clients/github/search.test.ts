import { expect } from "bun:test";

import { Array as EffectArray, Effect, Option, Order, String as EffectString } from "effect";

import { callGitHub, gitHubThroughProxy, searchPath } from "../../testing/github-client";
import { type InterceptedRequest, Reply } from "../../testing/intercepting-proxy";
import { layer } from "../../testing/it-effect";
import { pullRequests } from "../../testing/pull-requests";
import { GitHubFailed } from "./failure";

const CREATED = "2026-01-01T00:00:00Z";
const LATER = "2026-02-02T00:00:00Z";

/** An open and approved pull request in the fake search's index, with the numbers it mentions. */
interface Indexed {
  readonly createdAt: string;
  readonly mentions: readonly number[];
  readonly number: number;
}

const indexed = (
  number: number,
  mentions: readonly number[] = [],
  createdAt = CREATED,
): Indexed => ({
  createdAt,
  mentions,
  number,
});

// A GitHub whose search lists the open and approved pull requests of the index, as GitHub's does: a
// number matches the pull request with it and any that mention it, `created:` matches a range of
// creation times, and no page lists results beyond the first 1000. A search whose text, without
// its qualifiers, is longer than 256 characters fails. A search that timed out sets
// `incomplete_results`.
const searchOf =
  (index: readonly Indexed[], timedOut = false) =>
  ({ path }: InterceptedRequest): unknown => {
    const url = new URL(path, "https://api.github.com");
    const terms = EffectString.split(url.searchParams.get("q") ?? "", " ");
    const text = EffectArray.filter(terms, (term) => !EffectString.includes(":")(term));
    if (EffectArray.join(text, " ").length > 256) {
      return new Reply(422, { message: "The search is longer than 256 characters." });
    }
    const numbers = EffectArray.map(
      EffectArray.filter(text, (term) => /^\d+$/u.test(term)),
      Number,
    );
    // Without `created:`, any creation time matches.
    const [from = "", to = "~"] = Option.match(
      EffectArray.findFirst(terms, (term) => EffectString.startsWith("created:")(term)),
      {
        onNone: () => [],
        onSome: (term) => EffectString.split(EffectString.slice("created:".length)(term), ".."),
      },
    );
    const found = EffectArray.filter(
      index,
      ({ createdAt, mentions, number }) =>
        createdAt >= from &&
        createdAt <= to &&
        EffectArray.some(numbers, (wanted) => wanted === number || mentions.includes(wanted)),
    );
    // Without `sort=created&order=asc`, the index's order stands in for GitHub's best match.
    const byCreation =
      url.searchParams.get("sort") === "created" && url.searchParams.get("order") === "asc";
    const matches = byCreation
      ? EffectArray.sort(
          found,
          Order.mapInput(Order.String, ({ createdAt }: Indexed) => createdAt),
        )
      : found;
    const page = Number(url.searchParams.get("page"));
    const perPage = Number(url.searchParams.get("per_page"));
    if (page * perPage > 1000) {
      return new Reply(422, { message: "Only the first 1000 search results are available" });
    }
    return {
      incomplete_results: timedOut,
      items: EffectArray.map(matches.slice((page - 1) * perPage, page * perPage), ({ number }) => ({
        number,
      })),
      total_count: matches.length,
    };
  };

// The pull requests asked about, by number, each created at the time given or `CREATED`.
const asked = (numbers: readonly number[], createdAt: Readonly<Record<number, string>> = {}) =>
  EffectArray.map(pullRequests(...numbers), (number) => ({
    createdAt: createdAt[number] ?? CREATED,
    number,
  }));

const setOf = (numbers: readonly number[]) => new Set(pullRequests(...numbers));

// Pull requests, from #2000 on, that mention the number, each created at the time given.
const mentioning = (number: number, count: number, createdAt = CREATED) =>
  Array.from({ length: count }, (_, offset) => indexed(2000 + offset, [number], createdAt));

layer(gitHubThroughProxy)("approvedPullRequests", (it) => {
  it("lists those of the pull requests the search lists, from every page", () =>
    Effect.gen(function* () {
      const outcome = yield* callGitHub(searchOf([indexed(7), ...mentioning(7, 100)]), (github) =>
        github.approvedPullRequests(asked([7])),
      );
      expect(outcome).toStrictEqual({
        requests: [
          `GET api.github.com${searchPath(`7 created:${CREATED}..${CREATED}`, 1)}`,
          `GET api.github.com${searchPath(`7 created:${CREATED}..${CREATED}`, 2)}`,
        ],
        result: setOf([7]),
      });
    }));

  it("searches for more pull requests than one search's text fits in several searches", () =>
    Effect.gen(function* () {
      // 42 five-digit numbers and the spaces between them are 251 characters, and 43 are 257.
      const numbers = Array.from({ length: 50 }, (_, offset) => 10_000 + offset);
      const terms = EffectArray.map(numbers, String);
      const outcome = yield* callGitHub(
        searchOf([indexed(10_001), indexed(10_040), indexed(10_049)]),
        (github) => github.approvedPullRequests(asked(numbers)),
      );
      expect(outcome).toStrictEqual({
        requests: [
          `GET api.github.com${searchPath(`${EffectArray.join(terms.slice(0, 42), " ")} created:${CREATED}..${CREATED}`)}`,
          `GET api.github.com${searchPath(`${EffectArray.join(terms.slice(42), " ")} created:${CREATED}..${CREATED}`)}`,
        ],
        result: setOf([10_001, 10_040, 10_049]),
      });
    }));

  it("splits a search that matches too many, down to one pull request", () =>
    Effect.gen(function* () {
      // Search lists in order of creation, and #5's range keeps out what only mentions #5.
      const index = [indexed(5, [], LATER), indexed(6), ...mentioning(5, 1200)];
      const outcome = yield* callGitHub(searchOf(index), (github) =>
        github.approvedPullRequests(asked([5, 6], { 5: LATER })),
      );
      expect(outcome).toStrictEqual({
        requests: [
          `GET api.github.com${searchPath(`6 5 created:${CREATED}..${LATER}`)}`,
          `GET api.github.com${searchPath(`6 created:${CREATED}..${CREATED}`)}`,
          `GET api.github.com${searchPath(`5 created:${LATER}..${LATER}`)}`,
        ],
        result: setOf([5, 6]),
      });
    }));

  it("fails where one pull request's search matches too many", () =>
    Effect.gen(function* () {
      const path = searchPath(`5 created:${CREATED}..${CREATED}`);
      const outcome = yield* callGitHub(searchOf([indexed(5), ...mentioning(5, 1200)]), (github) =>
        Effect.flip(github.approvedPullRequests(asked([5]))),
      );
      expect(outcome).toStrictEqual({
        requests: [`GET api.github.com${path}`],
        result: GitHubFailed.make({
          message: `GET ${path} matched 1201 pull requests, too many to list, so whether #5 is approved is unknown`,
        }),
      });
    }));

  it("fails where the search timed out and listed only some pull requests", () =>
    Effect.gen(function* () {
      const path = searchPath(`7 created:${CREATED}..${CREATED}`);
      const outcome = yield* callGitHub(searchOf([indexed(7)], true), (github) =>
        Effect.flip(github.approvedPullRequests(asked([7]))),
      );
      expect(outcome).toStrictEqual({
        requests: [`GET api.github.com${path}`],
        result: GitHubFailed.make({
          message: `GET ${path} timed out with partial results`,
        }),
      });
    }));

  it("sends no search for no pull requests", () =>
    Effect.gen(function* () {
      const outcome = yield* callGitHub(searchOf([]), (github) => github.approvedPullRequests([]));
      expect(outcome).toStrictEqual({ requests: [], result: new Set() });
    }));
});
