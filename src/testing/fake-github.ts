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

export interface FakeRun {
  readonly branch: string;
  /** GitHub answers 403 to a cancel where the token can't write to Actions. */
  readonly cancelForbidden?: boolean;
  readonly completed: boolean;
  readonly id: string;
}

export interface FakeGitHubOptions<R = never> {
  /** The open pull requests GitHub's search lists as approved. */
  readonly approved?: readonly PullRequestNumber[];
  /** The latest result of each check, by commit. */
  readonly checks?: Readonly<Record<string, readonly Check[]>>;
  /** GitHub answers 403 to a comment where the token can't write to issues. */
  readonly commentForbidden?: boolean;
  /** What GitHub does to the repository when it merges, since the fake has no repository. */
  readonly onMerge?: (pullRequest: PullRequestNumber) => Effect.Effect<void, never, R>;
  /** The branch's pull requests in any state, newest first, after those `recordMerge` recorded. */
  readonly pullRequestsFrom?: (branch: string) => readonly ListedPullRequest[];
  /** The checks each branch requires. A branch not named here doesn't exist. */
  readonly required?: Readonly<Record<string, RequiredChecks>>;
  /** Each commit's workflow runs, on any branch. */
  readonly runs?: Readonly<Record<string, readonly FakeRun[]>>;
}

export interface FakeGitHubSetUp<R = never> extends FakeGitHubOptions<R> {
  /** The open pull requests, by head branch. */
  readonly open?: Readonly<Record<string, PullRequest>>;
  readonly stacks?: readonly RemoteStack[];
}

export interface RecordedMerge {
  readonly branch: string;
  readonly deleted: boolean;
  readonly head: string;
  readonly into: string;
}

/** A GitHub that holds what `setUp` gives it, and records every call that changes something. */
export class FakeGitHub extends Context.Service<
  FakeGitHub,
  {
    /** The calls that changed something, in order. */
    readonly calls: Effect.Effect<readonly string[]>;
    /**
     * Records that GitHub merged the pull request from `branch` into `into` at `head`. Closes it
     * and drops it from its stack. With `deleted`, retargets the pull requests based on `branch` to
     * `into`. Returns the pull request as it was open, and dies where there is none.
     */
    readonly recordMerge: (merge: RecordedMerge) => Effect.Effect<PullRequest>;
    readonly setUp: (setUp: FakeGitHubSetUp) => Effect.Effect<void>;
  }
>()("jj-octo/testing/fake-github/FakeGitHub") {}

/** The fake GitHub, and the `GitHub` client that reads and changes it. */
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

/** Calls `FakeGitHub`'s `setUp`, and runs `onMerge` with the services this setup runs with. */
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

/** `FakeGitHub`'s `calls`. */
export const gitHubCalls: Effect.Effect<readonly string[], never, FakeGitHub> = Effect.flatMap(
  FakeGitHub,
  ({ calls }) => calls,
);

/** Sets up draft pull requests #1 for `a` and #2 for `b`, as stack #7 by default. */
export const setUpPullRequestsAB = <R = never>({
  stacks = stackOf(1, 2),
  ...options
}: Omit<FakeGitHubSetUp<R>, "open"> = {}): Effect.Effect<void, never, FakeGitHub | R> =>
  setUpGitHub({ ...options, open: openPullRequestsAB, stacks });

/** Sets up draft pull requests #1 for `a`, with the title and body, and #2 for `b`, as stack #7. */
export const setUpPullRequestsABWithA = (
  title: string,
  body: string,
): Effect.Effect<void, never, FakeGitHub> =>
  setUpGitHub({
    open: { ...openPullRequestsAB, a: { ...openPullRequest("main", 1, title), body } },
    stacks: stackOf(1, 2),
  });

/** Sets up draft pull requests #1 for `a`, #2 for `b` and #3 for `c`, as stack #7 by default. */
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
