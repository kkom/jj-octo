import { Effect, Layer, Option } from "effect";

import type { Git } from "../clients/git";
import { GitHub } from "../clients/github/client";
import { GitHubFailed } from "../clients/github/failure";
import {
  type PullRequest,
  type ListedPullRequest,
  type PullRequestNumber,
  PullRequestNumberSchema,
  type PullRequestState,
  type RemoteStack,
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

interface FakeGitHubOptions {
  /** What GitHub does to the repository when it merges, which the fake has no repository to do. */
  readonly onMerge?: (pullRequest: PullRequestNumber) => void;
  /** The pull requests from the branch in any state, newest first. None by default. */
  readonly pullRequestsFrom?: (branch: string) => readonly ListedPullRequest[];
  /** Each commit's workflow runs. None by default. */
  readonly runs?: Readonly<Record<string, readonly FakeRun[]>>;
}

// A GitHub with the given open pull requests and stack, recording every call that changes something.
export const fakeGitHub = (
  open: Readonly<Record<string, PullRequest>>,
  stack: Option.Option<RemoteStack>,
  { onMerge, pullRequestsFrom = () => [], runs = {} }: FakeGitHubOptions = {},
): { readonly calls: readonly string[]; readonly layer: Layer.Layer<GitHub> } => {
  const calls: string[] = [];
  // Marking a pull request ready changes what `openPullRequest` returns afterwards.
  const opened = new Map(Object.entries(open));
  let registered = stack;
  const record = (call: string) =>
    Effect.sync(() => {
      calls.push(call);
    });
  const layer = Layer.succeed(GitHub, {
    addToStack: (number, pullRequests) => record(`add ${pullRequests.join(",")} to #${number}`),
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
    createStack: (pullRequests) =>
      record(`create stack ${pullRequests.join(",")}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registered = Option.some({ number: StackNumberSchema.make(8), unmerged: pullRequests });
          }),
        ),
        Effect.as(StackNumberSchema.make(8)),
      ),
    defaultBranch: Effect.succeed("main"),
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
    setBase: (number, base) => record(`base #${number} → ${base}`),
    setDescription: (number, { title }) => record(`describe #${number} as ${title}`),
    stackOf: () => Effect.sync(() => registered),
    unfinishedRuns: (commit) =>
      Effect.succeed(
        (runs[commit] ?? [])
          .filter((run) => !run.completed)
          .map(({ id }) => WorkflowRunIdSchema.make(id)),
      ),
    unstack: (number) =>
      record(`unstack #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registered = Option.none();
          }),
        ),
      ),
  });
  return { calls, layer };
};

export const pullRequests = (...numbers: readonly number[]): readonly PullRequestNumber[] =>
  numbers.map((number) => PullRequestNumberSchema.make(number));

/** Stack #7, with the given pull requests that haven't merged. */
export const stackOf = (...unmerged: readonly number[]): Option.Option<RemoteStack> =>
  Option.some({ number: StackNumberSchema.make(7), unmerged: pullRequests(...unmerged) });

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
