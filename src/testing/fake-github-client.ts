import { Array as EffectArray, Effect, Option, Record as EffectRecord, Ref, Result } from "effect";

import type { GitHub } from "../clients/github/client";
import { GitHubFailed } from "../clients/github/failure";
import {
  type ListedPullRequest,
  type PullRequest,
  type PullRequestNumber,
  PullRequestNumberSchema,
  type RemoteStack,
  StackNumberSchema,
  WorkflowRunIdSchema,
} from "../clients/github/types";
import type { FakeGitHubOptions } from "./fake-github";

/**
 * What the fake GitHub holds. Opening a pull request, marking one ready, setting a base and setting
 * a description change what `openPullRequest` returns afterwards.
 */
export interface State {
  readonly calls: readonly string[];
  /** How many pull requests the fake opened. */
  readonly created: number;
  /** The pull requests `recordMerge` recorded, newest first, with the branch of each. */
  readonly merged: readonly { readonly branch: string; readonly pullRequest: ListedPullRequest }[];
  readonly open: Readonly<Record<string, PullRequest>>;
  readonly options: FakeGitHubOptions;
  readonly stacks: readonly RemoteStack[];
}

/** The number of the first pull request a fake GitHub opens. The next ones count up from it. */
const FIRST_CREATED = 99;

const rejected = (request: string, status: number) =>
  Effect.fail(GitHubFailed.make({ message: `${request} returned ${status}`, status }));

const inAStack = (stacks: readonly RemoteStack[], pullRequests: readonly PullRequestNumber[]) =>
  EffectArray.some(stacks, ({ unmerged }) =>
    EffectArray.some(unmerged, (pr) => pullRequests.includes(pr)),
  );

const listed = (pullRequests: readonly PullRequestNumber[]) =>
  EffectArray.join(EffectArray.map(pullRequests, String), ",");

// Replaces the pull request numbered `number`, where it's open.
const updateOpen = (
  open: Readonly<Record<string, PullRequest>>,
  number: PullRequestNumber,
  update: (pullRequest: PullRequest) => PullRequest,
) =>
  EffectRecord.map(open, (pullRequest) =>
    pullRequest.number === number ? update(pullRequest) : pullRequest,
  );

/** The `GitHub` client, reading and changing what the fake GitHub holds. */
export const fakeGitHubClient = (state: Ref.Ref<State>): GitHub["Service"] => {
  const read = <A>(f: (current: State) => A) => Effect.map(Ref.get(state), f);
  const record = (call: string, update: (current: State) => State = (current) => current) =>
    Ref.update(state, (current) => ({ ...update(current), calls: [...current.calls, call] }));
  const onMerge = (number: PullRequestNumber) =>
    Effect.flatMap(Ref.get(state), ({ options }) => options.onMerge?.(number) ?? Effect.void);
  return {
    // GitHub rejects adding to a stack that doesn't exist, or a pull request in another stack.
    addToStack: (number, pullRequests) =>
      Effect.flatMap(Ref.get(state), ({ stacks }) => {
        if (!EffectArray.some(stacks, (stack) => stack.number === number)) {
          return rejected(`POST /stacks/${number}/add`, 404);
        }
        if (inAStack(stacks, pullRequests)) {
          return rejected(`POST /stacks/${number}/add`, 422);
        }
        return record(`add ${listed(pullRequests)} to #${number}`, (current) => ({
          ...current,
          stacks: EffectArray.map(current.stacks, (stack) =>
            stack.number === number
              ? { ...stack, unmerged: [...stack.unmerged, ...pullRequests] }
              : stack,
          ),
        }));
      }),
    approvedPullRequests: (pullRequests) =>
      read(
        ({ options: { approved = [] } }) =>
          new Set(
            EffectArray.filter(
              EffectArray.map(pullRequests, ({ number }) => number),
              (number) => approved.includes(number),
            ),
          ),
      ),
    cancelRun: (run) =>
      Effect.flatMap(Ref.get(state), ({ options: { runs = {} } }) => {
        const found = EffectArray.findFirst(
          EffectRecord.values(runs).flat(),
          ({ id }) => id === run,
        );
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
      }),
    closePullRequest: (number) =>
      record(`close #${number}`, (current) => ({
        ...current,
        open: EffectRecord.filter(current.open, (pullRequest) => pullRequest.number !== number),
      })),
    commentOnPullRequest: (number, body) =>
      Effect.flatMap(Ref.get(state), ({ options: { commentForbidden = false } }) =>
        commentForbidden
          ? rejected(`POST /issues/${number}/comments`, 403)
          : record(`comment on #${number}: ${body}`),
      ),
    createPullRequest: ({ base, body, draft, head, title }) =>
      Effect.flatMap(Ref.get(state), ({ created }) => {
        const number = PullRequestNumberSchema.make(FIRST_CREATED + created);
        return record(`open ${head} on ${base}${draft ? " as a draft" : ""}`, (current) => ({
          ...current,
          created: current.created + 1,
          open: { ...current.open, [head]: { base, body, draft, number, title } },
        })).pipe(Effect.as(number));
      }),
    // GitHub rejects a stack with a pull request that is already in another.
    createStack: (pullRequests) =>
      Effect.flatMap(Ref.get(state), ({ stacks }) => {
        if (inAStack(stacks, pullRequests)) {
          return rejected("POST /stacks", 422);
        }
        const number = StackNumberSchema.make(
          Math.max(7, ...EffectArray.map(stacks, (stack) => stack.number)) + 1,
        );
        return record(`create stack ${listed(pullRequests)}`, (current) => ({
          ...current,
          stacks: [...current.stacks, { number, unmerged: pullRequests }],
        })).pipe(Effect.as(number));
      }),
    defaultBranch: Effect.succeed("main"),
    latestChecks: (commit) => read(({ options: { checks = {} } }) => checks[commit] ?? []),
    markReadyForReview: (number) =>
      Effect.flatMap(Ref.get(state), ({ open }) =>
        EffectArray.some(EffectRecord.values(open), (pullRequest) => pullRequest.number === number)
          ? record(`publish #${number}`, (current) => ({
              ...current,
              open: updateOpen(current.open, number, (pullRequest) => ({
                ...pullRequest,
                draft: false,
              })),
            }))
          : rejected(`GET /pulls/${number}`, 404),
      ),
    mergePullRequest: (number) => record(`merge #${number}`).pipe(Effect.andThen(onMerge(number))),
    mergeStack: (number) =>
      record(`merge the stack up to #${number}`).pipe(
        Effect.andThen(onMerge(number)),
        Effect.as("merged"),
      ),
    openPullRequest: (branch) => read(({ open }) => Option.fromNullishOr(open[branch])),
    pullRequestsFrom: (branch) =>
      read(({ merged, options: { pullRequestsFrom = () => [] } }) => [
        ...EffectArray.filterMap(merged, (recorded) =>
          recorded.branch === branch ? Result.succeed(recorded.pullRequest) : Result.failVoid,
        ),
        ...pullRequestsFrom(branch),
      ]),
    // GitHub answers 404 for a branch it doesn't have, which the client reads as unknown.
    requiredChecks: (branch) =>
      read(
        ({ options: { required = {} } }) =>
          required[branch] ?? {
            _tag: "Unknown" as const,
            reason: `couldn't read the rules of ${branch}: GET /branches/${branch} returned 404`,
          },
      ),
    setBase: (number, base) =>
      record(`base #${number} → ${base}`, (current) => ({
        ...current,
        open: updateOpen(current.open, number, (pullRequest) => ({ ...pullRequest, base })),
      })),
    setDescription: (number, { body, title }) =>
      record(`describe #${number} as ${title}`, (current) => ({
        ...current,
        open: updateOpen(current.open, number, (pullRequest) => ({ ...pullRequest, body, title })),
      })),
    stackOf: (pullRequest) =>
      read(({ stacks }) =>
        EffectArray.findFirst(stacks, ({ unmerged }) => unmerged.includes(pullRequest)),
      ),
    unfinishedRuns: ({ branch, commit }) =>
      read(({ options: { runs = {} } }) =>
        EffectArray.map(
          EffectArray.filter(runs[commit] ?? [], (run) => run.branch === branch && !run.completed),
          ({ id }) => WorkflowRunIdSchema.make(id),
        ),
      ),
    unstack: (number) =>
      Effect.flatMap(Ref.get(state), ({ stacks }) =>
        EffectArray.some(stacks, (stack) => stack.number === number)
          ? record(`unstack #${number}`, (current) => ({
              ...current,
              stacks: EffectArray.filter(current.stacks, (stack) => stack.number !== number),
            }))
          : rejected(`POST /stacks/${number}/unstack`, 404),
      ),
  };
};
