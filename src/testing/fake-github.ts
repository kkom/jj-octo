import { Array as EffectArray, Context, Effect, Layer, Record as EffectRecord, Ref } from "effect";

import { GitHub } from "../clients/github/client";
import type {
  Check,
  PullRequest,
  ListedPullRequest,
  PullRequestNumber,
  RemoteStack,
  RequiredChecks,
} from "../clients/github/types";
import { fakeGitHubClient, type State } from "./fake-github-client";
import {
  openPullRequest,
  openPullRequestsAB,
  openPullRequestsABC,
  pullRequest,
  stackOf,
} from "./pull-requests";

/** A workflow run, by its id, the branch it ran on, and whether it has completed. */
export interface FakeRun {
  readonly branch: string;
  /** GitHub answers 403 to a cancel where the token can't write to Actions. */
  readonly cancelForbidden?: boolean;
  readonly completed: boolean;
  readonly id: string;
}

export interface FakeGitHubOptions<R = never> {
  /** The open pull requests GitHub's search lists as approved. None by default. */
  readonly approved?: readonly PullRequestNumber[];
  /** The latest result of each check of each commit. None by default. */
  readonly checks?: Readonly<Record<string, readonly Check[]>>;
  /** GitHub answers 403 to a comment where the token can't write to issues. */
  readonly commentForbidden?: boolean;
  /** What GitHub does to the repository when it merges, which the fake has no repository to do. */
  readonly onMerge?: (pullRequest: PullRequestNumber) => Effect.Effect<void, never, R>;
  /**
   * The pull requests from the branch in any state, newest first, after the ones
   * `recordMerge` recorded. None by default.
   */
  readonly pullRequestsFrom?: (branch: string) => readonly ListedPullRequest[];
  /** The checks each branch requires. A branch not named here doesn't exist. */
  readonly required?: Readonly<Record<string, RequiredChecks>>;
  /** Each commit's workflow runs, on any branch. None by default. */
  readonly runs?: Readonly<Record<string, readonly FakeRun[]>>;
}

/** What the fake GitHub holds: the open pull requests by branch, the stacks, and the rest. */
export interface FakeGitHubSetUp<R = never> extends FakeGitHubOptions<R> {
  /** The open pull requests, by the branch each is from. None by default. */
  readonly open?: Readonly<Record<string, PullRequest>>;
  /** The stacks. None by default. */
  readonly stacks?: readonly RemoteStack[];
}

/** A merge that `FakeGitHub`'s `recordMerge` records. */
export interface RecordedMerge {
  readonly branch: string;
  readonly deleted: boolean;
  readonly head: string;
  readonly into: string;
}

/**
 * A GitHub that holds the pull requests and stacks `setUp` gives it, and records every call that
 * changes something. It holds none until then.
 */
export class FakeGitHub extends Context.Service<
  FakeGitHub,
  {
    /** The calls that changed something, in order. */
    readonly calls: Effect.Effect<readonly string[]>;
    /**
     * Records that GitHub merged the pull request from `branch` into `into`, with `head` as its
     * head commit. As GitHub does, closes that pull request and drops it from its stack. With
     * `deleted`, the merge deleted the branch, so the open pull requests based on it are retargeted
     * to `into`. Returns the pull request as it was open. Dies where `branch` has no open pull request.
     */
    readonly recordMerge: (merge: RecordedMerge) => Effect.Effect<PullRequest>;
    /** Sets the open pull requests by branch, the stacks, and the rest of what GitHub holds. */
    readonly setUp: (setUp: FakeGitHubSetUp) => Effect.Effect<void>;
  }
>()("jj-octo/testing/fake-github/FakeGitHub") {}

/** The fake GitHub, and the `GitHub` client that reads and changes what it holds. */
export const fakeGitHub: Layer.Layer<FakeGitHub | GitHub> = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({
      calls: [],
      created: 0,
      merged: [],
      open: {},
      options: {},
      stacks: [],
    });
    return Layer.mergeAll(
      Layer.succeed(FakeGitHub, {
        calls: Effect.map(Ref.get(state), ({ calls }) => calls),
        recordMerge: ({ branch, deleted, head, into }) =>
          Effect.flatten(
            Ref.modify(state, (current): [Effect.Effect<PullRequest>, State] => {
              const merging = current.open[branch];
              if (merging === undefined) {
                return [
                  Effect.die(
                    new Error(`the fake GitHub has no open pull request from ${branch} to merge`),
                  ),
                  current,
                ];
              }
              const others = EffectRecord.filter(current.open, (_, from) => from !== branch);
              return [
                Effect.succeed(merging),
                {
                  ...current,
                  merged: [
                    {
                      branch,
                      pullRequest: {
                        ...pullRequest(merging.number, "merged", head),
                        title: merging.title,
                      },
                    },
                    ...current.merged,
                  ],
                  open: deleted
                    ? EffectRecord.map(others, (open) =>
                        open.base === branch ? { ...open, base: into } : open,
                      )
                    : others,
                  stacks: EffectArray.map(current.stacks, (stack) => ({
                    ...stack,
                    unmerged: EffectArray.filter(
                      stack.unmerged,
                      (unmerged) => unmerged !== merging.number,
                    ),
                  })),
                },
              ];
            }),
          ),
        setUp: ({ open = {}, stacks = [], ...options }) =>
          Ref.update(state, (current) => ({ ...current, open, options, stacks })),
      }),
      Layer.succeed(GitHub, fakeGitHubClient(state)),
    );
  }),
);

/**
 * Sets what the fake GitHub holds, as `FakeGitHub`'s `setUp` does. `onMerge` runs with the
 * services that the setup ran with.
 */
export const setUpGitHub = <R = never>({
  onMerge,
  ...options
}: FakeGitHubSetUp<R>): Effect.Effect<void, never, FakeGitHub | R> =>
  Effect.gen(function* () {
    const github = yield* FakeGitHub;
    const context = yield* Effect.context<R>();
    yield* github.setUp({
      ...options,
      ...(onMerge === undefined
        ? {}
        : { onMerge: (number) => Effect.provideContext(onMerge(number), context) }),
    });
  });

/** The calls to the fake GitHub that changed something, in order. */
export const gitHubCalls: Effect.Effect<readonly string[], never, FakeGitHub> = Effect.flatMap(
  FakeGitHub,
  ({ calls }) => calls,
);

/**
 * Sets the fake GitHub up with draft pull requests #1 for `a` and #2 for `b`, as stack #7 unless
 * `stacks` says otherwise.
 */
export const setUpPullRequestsAB = <R = never>({
  stacks = stackOf(1, 2),
  ...options
}: Omit<FakeGitHubSetUp<R>, "open"> = {}): Effect.Effect<void, never, FakeGitHub | R> =>
  setUpGitHub({ ...options, open: openPullRequestsAB, stacks });

/**
 * Sets the fake GitHub up with draft pull requests #1 for `a`, with the title and body, and #2 for
 * `b`, as stack #7.
 */
export const setUpPullRequestsABWithA = (
  title: string,
  body: string,
): Effect.Effect<void, never, FakeGitHub> =>
  setUpGitHub({
    open: { ...openPullRequestsAB, a: { ...openPullRequest("main", 1, title), body } },
    stacks: stackOf(1, 2),
  });

/**
 * Sets the fake GitHub up with draft pull requests #1 for `a`, #2 for `b` and #3 for `c`, as stack
 * #7 unless `stacks` says otherwise.
 */
export const setUpPullRequestsABC = <R = never>({
  stacks = stackOf(1, 2, 3),
  ...options
}: Omit<FakeGitHubSetUp<R>, "open"> = {}): Effect.Effect<void, never, FakeGitHub | R> =>
  setUpGitHub({ ...options, open: openPullRequestsABC, stacks });

/** `fakeGitHub`, set up by `setUp`, such as `setUpPullRequestsAB()`. */
export const fakeGitHubHolding = (
  setUp: Effect.Effect<void, never, FakeGitHub>,
): Layer.Layer<FakeGitHub | GitHub> =>
  Layer.effectDiscard(setUp).pipe(Layer.provideMerge(fakeGitHub));
