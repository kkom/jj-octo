import { Array as EffectArray, Option } from "effect";

import {
  type ListedPullRequest,
  type PullRequest,
  type PullRequestNumber,
  PullRequestNumberSchema,
  type PullRequestState,
  type RemoteStack,
  StackNumberSchema,
} from "../clients/github/types";

export const pullRequests = (...numbers: readonly number[]): readonly PullRequestNumber[] =>
  EffectArray.map(numbers, (number) => PullRequestNumberSchema.make(number));

/** A stack, with the given pull requests that haven't merged. */
export const stackNumbered = (number: number, ...unmerged: readonly number[]): RemoteStack => ({
  number: StackNumberSchema.make(number),
  unmerged: pullRequests(...unmerged),
});

/** Stack #7 alone, with the given pull requests that haven't merged. */
export const stackOf = (...unmerged: readonly number[]): readonly RemoteStack[] => [
  stackNumbered(7, ...unmerged),
];

/** An open draft pull request with a title and no body. */
export const openPullRequest = (base: string, number: number, title: string): PullRequest => ({
  base,
  body: "",
  draft: true,
  number: PullRequestNumberSchema.make(number),
  title,
});

/**
 * The open pull requests of the stack `a`, `b`: #1 for `a` against `main`, and #2 for `b` against
 * `a`.
 */
export const openPullRequestsAB: Readonly<Record<"a" | "b", PullRequest>> = {
  a: openPullRequest("main", 1, "a"),
  b: openPullRequest("a", 2, "b"),
};

/**
 * The open pull requests of the stack `a`, `b`, `c`: those of `a` and `b`, and #3 for `c` against
 * `b`.
 */
export const openPullRequestsABC: Readonly<Record<"a" | "b" | "c", PullRequest>> = {
  ...openPullRequestsAB,
  c: openPullRequest("b", 3, "c"),
};

/**
 * Pull request `number` of this repository as a listing shows it, in the state and with the head
 * given.
 */
export const pullRequest = (
  number: number,
  state: PullRequestState,
  head: string,
): ListedPullRequest => ({
  createdAt: "2026-01-01T00:00:00Z",
  head,
  number: PullRequestNumberSchema.make(number),
  stack: Option.none(),
  state,
  title: `Pull request ${number}`,
  url: `https://github.com/kkom/jj-octo/pull/${number}`,
});
