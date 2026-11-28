import { type Option, Schema } from "effect";

export const PullRequestNumberSchema = Schema.Finite.pipe(Schema.brand("PullRequestNumber"));
export type PullRequestNumber = typeof PullRequestNumberSchema.Type;

export const StackNumberSchema = Schema.Finite.pipe(Schema.brand("StackNumber"));
export type StackNumber = typeof StackNumberSchema.Type;

/** A workflow run's id, as its endpoints' URLs write it. */
export const WorkflowRunIdSchema = Schema.String.pipe(Schema.brand("WorkflowRunId"));
export type WorkflowRunId = typeof WorkflowRunIdSchema.Type;

export interface PullRequest {
  readonly base: string;
  readonly body: string;
  readonly draft: boolean;
  readonly number: PullRequestNumber;
  readonly title: string;
}

/** `ready` is open and not a draft, and `closed` is closed unmerged. */
export type PullRequestState = "closed" | "draft" | "merged" | "ready";

const OPEN: Readonly<Record<PullRequestState, boolean>> = {
  closed: false,
  draft: true,
  merged: false,
  ready: true,
};

export const isOpen = (state: PullRequestState): boolean => OPEN[state];

/** A stack registered on GitHub. */
export interface StackLink {
  readonly number: StackNumber;
  readonly url: string;
}

/** A pull request from a branch, in any state. */
export interface ListedPullRequest {
  /** As GitHub writes it, such as `2026-10-04T16:40:29Z`. */
  readonly createdAt: string;
  readonly head: string;
  readonly number: PullRequestNumber;
  readonly stack: Option.Option<StackLink>;
  readonly state: PullRequestState;
  readonly title: string;
  readonly url: string;
}

/** GitHub counts a `skipped` required check as passed, though nothing ran. */
export type CheckState = "failed" | "passed" | "pending" | "skipped";

/** The latest result of one check of a commit: a check run or a commit status. */
export interface Check {
  /**
   * The id of the GitHub App that sent a check run. A commit status has none, as GitHub doesn't
   * name its app.
   */
  readonly app: Option.Option<number>;
  readonly name: string;
  /**
   * GitHub's word for the result, such as `success`: a check run's conclusion, or its status
   * before it has one, or a commit status's state.
   */
  readonly outcome: string;
  readonly state: CheckState;
}

/** A check a branch requires, and the GitHub App that must send it, if any. */
export interface RequiredCheck {
  readonly app: Option.Option<number>;
  readonly name: string;
}

export type RequiredChecks =
  | { readonly _tag: "Known"; readonly checks: readonly RequiredCheck[] }
  | { readonly _tag: "Unknown"; readonly reason: string };

/**
 * A stack registered on GitHub. `unmerged` runs bottom to top, and includes pull requests closed
 * without merging, which stay in the stack.
 */
export interface RemoteStack {
  readonly number: StackNumber;
  readonly unmerged: readonly PullRequestNumber[];
}
