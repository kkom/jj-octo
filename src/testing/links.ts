import { Option } from "effect";

import type { LinkedPullRequest } from "../cli/gh/links";
import { type ListedPullRequest, StackNumberSchema } from "../clients/github/types";

/**
 * A pull request with the lines its change adds and removes, by default the one line of `stack`,
 * from a change with no conflicts.
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
