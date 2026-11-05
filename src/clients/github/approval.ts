import type { Review } from "./types";

/**
 * Whether the reviews, in the order they were submitted, approve the pull request: a reviewer
 * approved it, and nobody requested changes after that approval. GitHub sets a dismissed review's
 * state to `DISMISSED`, so it neither approves nor requests changes.
 */
export const approvedBy = (reviews: readonly Review[]): boolean =>
  reviews.findLast(({ state }) => state === "APPROVED" || state === "CHANGES_REQUESTED")?.state ===
  "APPROVED";
