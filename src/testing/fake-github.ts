import { Array as EffectArray, Effect, Layer, Option, Record as EffectRecord } from "effect";

import type { Git } from "../clients/git";
import { GitHub } from "../clients/github/client";
import { GitHubFailed } from "../clients/github/failure";
import {
  type Check,
  type PullRequest,
  type ListedPullRequest,
  type PullRequestNumber,
  PullRequestNumberSchema,
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
  /** GitHub answers 403 to a comment where the token can't write to issues. */
  readonly commentForbidden?: boolean;
  /** What GitHub does to the repository when it merges, which the fake has no repository to do. */
  readonly onMerge?: (pullRequest: PullRequestNumber) => void;
  /** The pull requests from the branch in any state, newest first. None by default. */
  readonly pullRequestsFrom?: (branch: string) => readonly ListedPullRequest[];
  /** The checks each branch requires. A branch not named here doesn't exist. */
  readonly required?: Readonly<Record<string, RequiredChecks>>;
  /** Each commit's workflow runs. None by default. */
  readonly runs?: Readonly<Record<string, readonly FakeRun[]>>;
}

/** The number of the first pull request a fake GitHub opens. The next ones count up from it. */
const FIRST_CREATED = 99;

const rejected = (request: string, status: number) =>
  Effect.fail(GitHubFailed.make({ message: `${request} returned ${status}`, status }));

// A GitHub with the given open pull requests and stacks, recording every call that changes
// something.
export const fakeGitHub = (
  open: Readonly<Record<string, PullRequest>>,
  stacks: readonly RemoteStack[],
  {
    approved = [],
    checks = {},
    commentForbidden = false,
    onMerge,
    pullRequestsFrom = () => [],
    required = {},
    runs = {},
  }: FakeGitHubOptions = {},
): { readonly calls: readonly string[]; readonly layer: Layer.Layer<GitHub> } => {
  const calls: string[] = [];
  // Opening a pull request, marking one ready and setting a base change what `openPullRequest`
  // returns afterwards.
  const opened = new Map(EffectRecord.toEntries(open));
  let created = 0;
  let registered = stacks;
  const record = (call: string) =>
    Effect.sync(() => {
      calls.push(call);
    });
  const layer = Layer.succeed(GitHub, {
    // GitHub rejects adding to a stack that doesn't exist, or a pull request in another stack.
    addToStack: (number, pullRequests) => {
      if (!EffectArray.some(registered, (stack) => stack.number === number)) {
        return rejected(`POST /stacks/${number}/add`, 404);
      }
      if (
        EffectArray.some(registered, ({ unmerged }) =>
          EffectArray.some(unmerged, (pr) => pullRequests.includes(pr)),
        )
      ) {
        return rejected(`POST /stacks/${number}/add`, 422);
      }
      return record(
        `add ${EffectArray.join(EffectArray.map(pullRequests, String), ",")} to #${number}`,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registered = EffectArray.map(registered, (stack) =>
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
          EffectArray.filter(
            EffectArray.map(pullRequests, ({ number }) => number),
            (number) => approved.includes(number),
          ),
        ),
      ),
    cancelRun: (run) => {
      const found = EffectArray.findFirst(EffectRecord.values(runs).flat(), ({ id }) => id === run);
      const failed = (status: number) => rejected(`cancel run ${run}`, status);
      if (Option.isNone(found)) {
        return failed(404);
      }
      if (found.value.cancelForbidden === true) {
        return failed(403);
      }
      return found.value.completed
        ? Effect.succeed("finished" as const)
        : record(`cancel run ${run}`).pipe(Effect.as("cancelled" as const));
    },
    closePullRequest: (number) =>
      record(`close #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const [branch, pullRequest] of opened) {
              if (pullRequest.number === number) {
                opened.delete(branch);
              }
            }
          }),
        ),
      ),
    commentOnPullRequest: (number, body) =>
      commentForbidden
        ? rejected(`POST /issues/${number}/comments`, 403)
        : record(`comment on #${number}: ${body}`),
    createPullRequest: ({ base, body, draft, head, title }) => {
      const number = PullRequestNumberSchema.make(FIRST_CREATED + created);
      created += 1;
      return record(`open ${head} on ${base}${draft ? " as a draft" : ""}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            opened.set(head, { base, body, draft, number, title });
          }),
        ),
        Effect.as(number),
      );
    },
    // GitHub rejects a stack with a pull request that is already in another.
    createStack: (pullRequests) => {
      if (
        EffectArray.some(registered, ({ unmerged }) =>
          EffectArray.some(unmerged, (pr) => pullRequests.includes(pr)),
        )
      ) {
        return rejected("POST /stacks", 422);
      }
      const number = StackNumberSchema.make(
        Math.max(7, ...EffectArray.map(registered, (stack) => stack.number)) + 1,
      );
      return record(
        `create stack ${EffectArray.join(EffectArray.map(pullRequests, String), ",")}`,
      ).pipe(
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
      const found = EffectArray.findFirst(
        [...opened.entries()],
        ([, pullRequest]) => pullRequest.number === number,
      );
      if (Option.isNone(found)) {
        return rejected(`GET /pulls/${number}`, 404);
      }
      const [branch, pullRequest] = found.value;
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
    setBase: (number, base) =>
      record(`base #${number} → ${base}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const [branch, pullRequest] of opened) {
              if (pullRequest.number === number) {
                opened.set(branch, { ...pullRequest, base });
              }
            }
          }),
        ),
      ),
    setDescription: (number, { title }) => record(`describe #${number} as ${title}`),
    stackOf: (pullRequest) =>
      Effect.sync(() =>
        EffectArray.findFirst(registered, ({ unmerged }) => unmerged.includes(pullRequest)),
      ),
    unfinishedRuns: (commit) =>
      Effect.succeed(
        EffectArray.map(
          EffectArray.filter(runs[commit] ?? [], (run) => !run.completed),
          ({ id }) => WorkflowRunIdSchema.make(id),
        ),
      ),
    unstack: (number) =>
      EffectArray.some(registered, (stack) => stack.number === number)
        ? record(`unstack #${number}`).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                registered = EffectArray.filter(registered, (stack) => stack.number !== number);
              }),
            ),
          )
        : rejected(`POST /stacks/${number}/unstack`, 404),
  });
  return { calls, layer };
};

/** Runs a program against the scratch repository and the fake GitHub, with `env` as its environment. */
export const inRepository =
  (
    repository: ScratchRepository,
    github: { readonly layer: Layer.Layer<GitHub> },
    env: Readonly<Record<string, string>> = {},
  ) =>
  <A, E>(program: Effect.Effect<A, E, Git | GitHub | Jj | PrDescriptions>): Effect.Effect<A, E> =>
    program.pipe(Effect.provide([repository.layer, github.layer, environment(env)]));
