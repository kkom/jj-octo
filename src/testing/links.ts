import { Option } from "effect";

import type { LinkedPullRequest } from "../cli/gh/links";
import { type ListedPullRequest, StackNumberSchema } from "../clients/github/types";

/**
 * A pull request of a change with no conflicts, which adds and removes the lines given, by default
 * the one line of `stack`.
 */
export const linked = (listed: ListedPullRequest, added = 1, removed = 0): LinkedPullRequest => ({
  ...listed,
  added,
  conflict: false,
  removed,
});

/** The pull request in GitHub stack `number`. */
export const inStack = <P extends ListedPullRequest | LinkedPullRequest>(
  listed: P,
  number: number,
): P => ({
  ...listed,
  stack: Option.some({
    number: StackNumberSchema.make(number),
    url: `https://github.com/kkom/jj-octo/stack/${number}`,
  }),
});
