import type { LinkedPullRequest } from "../cli/gh/links";
import type { ListedPullRequest } from "../clients/github/types";

/** A pull request with the lines its change adds and removes, by default the one line of `stack`. */
export const linked = (listed: ListedPullRequest, added = 1, removed = 0): LinkedPullRequest => ({
  ...listed,
  added,
  removed,
});
