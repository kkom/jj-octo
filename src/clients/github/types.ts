import { type Option, Schema } from "effect";

export const PullRequestNumberSchema = Schema.Number.pipe(Schema.brand("PullRequestNumber"));
export type PullRequestNumber = typeof PullRequestNumberSchema.Type;

export const StackNumberSchema = Schema.Number.pipe(Schema.brand("StackNumber"));
export type StackNumber = typeof StackNumberSchema.Type;

/** A workflow run's id, as the URLs of the run's endpoints write it. */
export const WorkflowRunIdSchema = Schema.String.pipe(Schema.brand("WorkflowRunId"));
export type WorkflowRunId = typeof WorkflowRunIdSchema.Type;

export interface PullRequest {
  readonly base: string;
  readonly body: string;
  readonly draft: boolean;
  readonly number: PullRequestNumber;
  readonly title: string;
}

/** Where a pull request is: open as a draft or ready for review, merged, or closed unmerged. */
export type PullRequestState = "closed" | "draft" | "merged" | "ready";

const OPEN: Readonly<Record<PullRequestState, boolean>> = {
  closed: false,
  draft: true,
  merged: false,
  ready: true,
};

/** Whether a pull request in the state is open. */
export const isOpen = (state: PullRequestState): boolean => OPEN[state];

/** A stack registered on GitHub, with the address of its page. */
export interface StackLink {
  readonly number: StackNumber;
  readonly url: string;
}

/**
 * A pull request from a branch, in any state, with when GitHub created it, its head commit, title
 * and address, and the stack it is in, where it is in one.
 */
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

/**
 * Where a check is, as GitHub counts it for a required check: not finished, or finished as a pass
 * or a failure.
 */
export type CheckState = "failed" | "passed" | "pending";

/** The latest result of one check of a commit: a check run, or a commit status. */
export interface Check {
  /**
   * The id of the GitHub App that sent a check run. A commit status has none, since GitHub doesn't
   * say which app sent it.
   */
  readonly app: Option.Option<number>;
  readonly name: string;
  /**
   * GitHub's own word for the result: a check run's conclusion, or its status before it has one,
   * or a commit status's state. Such as `success`, `cancelled` or `in_progress`.
   */
  readonly outcome: string;
  readonly state: CheckState;
}

/** A check that a branch requires, by name, with the GitHub App that must send it, where one must. */
export interface RequiredCheck {
  readonly app: Option.Option<number>;
  readonly name: string;
}

/** The checks that a branch requires, or why they couldn't be read. */
export type RequiredChecks =
  | { readonly _tag: "Known"; readonly checks: readonly RequiredCheck[] }
  | { readonly _tag: "Unknown"; readonly reason: string };

/**
 * A stack registered on GitHub, with its pull requests that haven't merged bottom to top. One closed
 * without merging stays in the stack, so it is among them.
 */
export interface RemoteStack {
  readonly number: StackNumber;
  readonly unmerged: readonly PullRequestNumber[];
}
