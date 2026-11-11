import { Effect, Layer, Option } from "effect";

import type { Git } from "../clients/git";
import { GitHub } from "../clients/github/client";
import { GitHubFailed } from "../clients/github/failure";
import {
  type Check,
  type PullRequest,
  type ListedPullRequest,
  type PullRequestNumber,
  PullRequestNumberSchema,
  type PullRequestState,
  type RemoteStack,
  type RequiredChecks,
  StackNumberSchema,
  WorkflowRunIdSchema,
} from "../clients/github/types";
import type { Jj } from "../clients/jj";
import type { PrDescriptions } from "../clients/pr-descriptions";
import { environment } from "./environment";
import type { ScratchRepository } from "./scratch-repository";

/** A workflow run, by its id and whether it has completed. */
export interface FakeRun {
  /** GitHub answers 403 to a cancel where the token can't write to Actions. */
  readonly cancelForbidden?: boolean;
  readonly completed: boolean;
  readonly id: string;
}

export interface FakeGitHubOptions {
  /** The open pull requests GitHub's search lists as approved. None by default. */
  readonly approved?: readonly PullRequestNumber[];
  /** The latest result of each check of each commit. None by default. */
  readonly checks?: Readonly<Record<string, readonly Check[]>>;
  /** What GitHub does to the repository when it merges, which the fake has no repository to do. */
  readonly onMerge?: (pullRequest: PullRequestNumber) => void;
  /** The pull requests from the branch in any state, newest first. None by default. */
  readonly pullRequestsFrom?: (branch: string) => readonly ListedPullRequest[];
  /** The checks each branch requires. A branch not named here doesn't exist. */
  readonly required?: Readonly<Record<string, RequiredChecks>>;
  /** Each commit's workflow runs. None by default. */
  readonly runs?: Readonly<Record<string, readonly FakeRun[]>>;
}

// A GitHub with the given open pull requests and stacks, recording every call that changes
// something.
export const fakeGitHub = (
  open: Readonly<Record<string, PullRequest>>,
  stacks: readonly RemoteStack[],
  {
    approved = [],
    checks = {},
    onMerge,
    pullRequestsFrom = () => [],
    required = {},
    runs = {},
  }: FakeGitHubOptions = {},
): { readonly calls: readonly string[]; readonly layer: Layer.Layer<GitHub> } => {
  const calls: string[] = [];
  // Marking a pull request ready changes what `openPullRequest` returns afterwards.
  const opened = new Map(Object.entries(open));
  let registered = stacks;
  const record = (call: string) =>
    Effect.sync(() => {
      calls.push(call);
    });
  const layer = Layer.succeed(GitHub, {
    // GitHub rejects adding to a stack that doesn't exist, or a pull request in another stack.
    addToStack: (number, pullRequests) => {
      if (!registered.some((stack) => stack.number === number)) {
        return Effect.fail(
          new GitHubFailed({ message: `POST /stacks/${number}/add returned 404`, status: 404 }),
        );
      }
      if (registered.some(({ unmerged }) => unmerged.some((pr) => pullRequests.includes(pr)))) {
        return Effect.fail(
          new GitHubFailed({ message: `POST /stacks/${number}/add returned 422`, status: 422 }),
        );
      }
      return record(`add ${pullRequests.join(",")} to #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registered = registered.map((stack) =>
              stack.number === number
                ? { ...stack, unmerged: [...stack.unmerged, ...pullRequests] }
                : stack,
            );
          }),
        ),
      );
    },
    approvedPullRequests: (pullRequests) =>
      Effect.succeed(
        new Set(
          pullRequests.map(({ number }) => number).filter((number) => approved.includes(number)),
        ),
      ),
    cancelRun: (run) => {
      const found = Object.values(runs)
        .flat()
        .find(({ id }) => id === run);
      const failed = (status: number) =>
        Effect.fail(new GitHubFailed({ message: `cancel run ${run} returned ${status}`, status }));
      if (found === undefined) {
        return failed(404);
      }
      if (found.cancelForbidden === true) {
        return failed(403);
      }
      return found.completed
        ? Effect.succeed("finished" as const)
        : record(`cancel run ${run}`).pipe(Effect.as("cancelled" as const));
    },
    createPullRequest: ({ base, draft, head }) =>
      record(`open ${head} on ${base}${draft ? " as a draft" : ""}`).pipe(
        Effect.as(PullRequestNumberSchema.make(99)),
      ),
    // GitHub rejects a stack with a pull request that is already in another.
    createStack: (pullRequests) => {
      if (registered.some(({ unmerged }) => unmerged.some((pr) => pullRequests.includes(pr)))) {
        return Effect.fail(new GitHubFailed({ message: "POST /stacks returned 422", status: 422 }));
      }
      const number = StackNumberSchema.make(
        Math.max(7, ...registered.map((stack) => stack.number)) + 1,
      );
      return record(`create stack ${pullRequests.join(",")}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registered = [...registered, { number, unmerged: pullRequests }];
          }),
        ),
        Effect.as(number),
      );
    },
    defaultBranch: Effect.succeed("main"),
    latestChecks: (commit) => Effect.succeed(checks[commit] ?? []),
    markReadyForReview: (number) => {
      const found = [...opened.entries()].find(([, pullRequest]) => pullRequest.number === number);
      if (found === undefined) {
        return Effect.fail(
          new GitHubFailed({ message: `GET /pulls/${number} returned 404`, status: 404 }),
        );
      }
      const [branch, pullRequest] = found;
      return record(`publish #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            opened.set(branch, { ...pullRequest, draft: false });
          }),
        ),
      );
    },
    mergePullRequest: (number) =>
      record(`merge #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            onMerge?.(number);
          }),
        ),
      ),
    mergeStack: (number) =>
      record(`merge the stack up to #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            onMerge?.(number);
          }),
        ),
        Effect.as("merged"),
      ),
    openPullRequest: (branch) => Effect.sync(() => Option.fromNullishOr(opened.get(branch))),
    pullRequestsFrom: (branch) => Effect.sync(() => pullRequestsFrom(branch)),
    // GitHub answers 404 for a branch it doesn't have, which the client reads as unknown.
    requiredChecks: (branch) =>
      Effect.succeed(
        required[branch] ?? {
          _tag: "Unknown" as const,
          reason: `couldn't read the rules of ${branch}: GET /branches/${branch} returned 404`,
        },
      ),
    setBase: (number, base) => record(`base #${number} → ${base}`),
    setDescription: (number, { title }) => record(`describe #${number} as ${title}`),
    stackOf: (pullRequest) =>
      Effect.sync(() =>
        Option.fromNullishOr(registered.find(({ unmerged }) => unmerged.includes(pullRequest))),
      ),
    unfinishedRuns: (commit) =>
      Effect.succeed(
        (runs[commit] ?? [])
          .filter((run) => !run.completed)
          .map(({ id }) => WorkflowRunIdSchema.make(id)),
      ),
    unstack: (number) =>
      registered.some((stack) => stack.number === number)
        ? record(`unstack #${number}`).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                registered = registered.filter((stack) => stack.number !== number);
              }),
            ),
          )
        : Effect.fail(
            new GitHubFailed({
              message: `POST /stacks/${number}/unstack returned 404`,
              status: 404,
            }),
          ),
  });
  return { calls, layer };
};

export const pullRequests = (...numbers: readonly number[]): readonly PullRequestNumber[] =>
  numbers.map((number) => PullRequestNumberSchema.make(number));

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

/** Pull request `number` of this repository as a listing shows it, in the state and with the head given. */
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

/** Runs a program against the scratch repository and the fake GitHub, with `env` as its environment. */
export const inRepository =
  (
    repository: ScratchRepository,
    github: { readonly layer: Layer.Layer<GitHub> },
    env: Readonly<Record<string, string>> = {},
  ) =>
  <A, E>(program: Effect.Effect<A, E, Git | GitHub | Jj | PrDescriptions>): Effect.Effect<A, E> =>
    program.pipe(Effect.provide(Layer.mergeAll(repository.layer, github.layer, environment(env))));
