import { Array as EffectArray, Console, Effect, Exit, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import type { Git } from "../../clients/git";
import { GitHub } from "../../clients/github/client";
import { GitHubFailed } from "../../clients/github/failure";
import type { PullRequest, PullRequestNumber } from "../../clients/github/types";
import type { Jj } from "../../clients/jj";
import type { PrDescriptions } from "../../clients/pr-descriptions";
import { asUserError, provideGitHubFromOrigin, revisionFlag, withHelp } from "../command";
import { bookmarkTargets } from "./stack/bookmark-targets";
import {
  bookmarkRevset,
  bookmarksAt,
  commitsAt,
  downstackChanges,
  withoutConflicts,
  pushedState,
  type StackChange,
  upstackRevset,
} from "./stack/changes";
import type { PushFailed } from "./stack/push";
import { pushAgain } from "./stack/push-again";
import type { NotCombined } from "./stack/reconcile";
import { checkedTrunk } from "./stack/trunk";
import { allWorkspacesFlag, sync } from "./sync";

export class NotMergeable extends Schema.TaggedError<
  NotMergeable,
  { readonly brand: unique symbol }
>()("NotMergeable", { message: Schema.String }) {}

const numbered = (pullRequests: readonly PullRequestNumber[]): string =>
  EffectArray.join(
    EffectArray.map(pullRequests, (number) => `#${number}`),
    ", ",
  );

const openPullRequestOf = (bookmark: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const opened = yield* github.openPullRequest(bookmark);
    if (Option.isNone(opened)) {
      return yield* NotMergeable.make({
        message: `no open pull request for ${bookmark}; run \`jj gh submit\` first`,
      });
    }
    return opened.value;
  });

const mergeOnGitHub = ({ base, number }: PullRequest, trunk: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* github.stackOf(number);
    if (Option.isSome(stack)) {
      const { unmerged } = stack.value;
      yield* Console.error(`merging ${numbered(unmerged.slice(0, unmerged.indexOf(number) + 1))}`);
      return yield* github.mergeStack(number);
    }
    // Outside a GitHub stack, a merge goes into the pull request's base and takes nothing below it.
    if (base !== trunk) {
      return yield* NotMergeable.make({
        message: `#${number} isn't in a GitHub stack and its base is ${base}, not the trunk; run \`jj gh submit\` to register the stack, or merge the changes below it first`,
      });
    }
    yield* Console.error(`merging ${numbered([number])}`);
    yield* github.mergePullRequest(number);
    return "merged" as const;
  });

const cancelPullRequestRuns = (changes: readonly StackChange[]) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const runs = (yield* Effect.forEach(
      changes,
      ({ bookmark, commitId }) => github.unfinishedRuns({ branch: bookmark, commit: commitId }),
      { concurrency: 4 },
    )).flat();
    const [outcomes, failures] = yield* Effect.partition(runs, (run) => github.cancelRun(run), {
      concurrency: 4,
    });
    const cancelled = EffectArray.filter(outcomes, (outcome) => outcome === "cancelled").length;
    yield* Console.error(
      `cancelled ${cancelled} workflow ${cancelled === 1 ? "run" : "runs"} of the merged pull requests`,
    );
    if (failures.length > 0) {
      return yield* GitHubFailed.make({
        message: EffectArray.join(
          [
            `couldn't cancel ${failures.length} of the merged pull requests' workflow runs:`,
            ...EffectArray.map(failures, ({ message }) => message),
          ],
          "\n",
        ),
      });
    }
  });

export const merge = (
  revision: string,
  {
    allWorkspaces,
    cancelPrRuns,
  }: { readonly allWorkspaces: boolean; readonly cancelPrRuns: boolean },
): Effect.Effect<
  void,
  NotCombined | NotMergeable | PushFailed,
  Git | GitHub | Jj | PrDescriptions
> =>
  Effect.gen(function* () {
    const trunk = yield* checkedTrunk;
    const changes = yield* downstackChanges(revision).pipe(Effect.flatMap(withoutConflicts));
    const top = changes.at(-1)?.bookmark ?? "";

    // GitHub merges what was pushed, so a later edit would be stranded on a change whose branch is
    // gone.
    const targets = yield* bookmarkTargets;
    const unpushed = EffectArray.filter(
      changes,
      (change) => pushedState(targets.get(change.bookmark), change) !== "pushed",
    );
    if (unpushed.length > 0) {
      return yield* NotMergeable.make({
        message: `these changes aren't pushed: ${EffectArray.join(
          EffectArray.map(unpushed, ({ bookmark }) => bookmark),
          ", ",
        )}; run \`jj gh submit\` first`,
      });
    }
    const pullRequest = yield* openPullRequestOf(top);
    const above = yield* bookmarksAt(upstackRevset(bookmarkRevset(top)));

    if ((yield* mergeOnGitHub(pullRequest, trunk)) === "enqueued") {
      yield* Console.error(
        `queued to merge; once it has, run \`jj gh sync\`, with \`--all-workspaces\` where only other workspaces' working copies are on the stack${cancelPrRuns ? ", and cancel the workflow runs yourself" : ""}`,
      );
    } else {
      yield* Console.error(`merged up to #${pullRequest.number}`);
      // GitHub merged exactly what was pushed, as checked above.
      yield* sync({ allWorkspaces, known: changes, trunk });
      // Cancels before the push, which can fail, but fails after it, so a token that can't cancel
      // runs still leaves the stack pushed.
      const cancelling = cancelPrRuns
        ? yield* Effect.exit(cancelPullRequestRuns(changes))
        : Exit.void;
      // Any bookmark left above the merged change names the rest of its stack.
      for (const bookmark of above) {
        if ((yield* commitsAt(bookmarkRevset(bookmark))).length > 0) {
          yield* pushAgain(bookmarkRevset(bookmark), trunk);
          break;
        }
      }
      yield* cancelling;
    }
  });

export const mergeCommand = Command.make(
  "merge",
  {
    allWorkspaces: allWorkspacesFlag,
    cancelPrRuns: Flag.Boolean("cancel-pr-runs").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "After merging, cancel the merged pull requests' unfinished workflow runs",
      ),
    ),
    revision: revisionFlag("The top change to merge"),
  },
  ({ allWorkspaces, cancelPrRuns, revision }) =>
    asUserError(merge(revision, { allWorkspaces, cancelPrRuns })),
).pipe(
  provideGitHubFromOrigin,
  withHelp(
    "Merge the pull requests of a change and the ones below it",
    "Prints which pull requests it merges, then squash-merges them. Fails before merging if a change has unpushed edits.",
    "Pull requests in a GitHub stack merge with those below them, all or none. One outside a stack merges alone, and only if based on the trunk.",
    "Then syncs as `jj gh sync` does, including the merged stack even where only other workspaces' working copies are on it. Then pushes the rest of the stack again, up to the highest branch on GitHub, stopping below the lowest change with conflicts and printing which it leaves local. Closes the pull requests of abandoned changes, as `jj gh submit` does.",
    "With `--cancel-pr-runs`, cancels the merged pull requests' unfinished workflow runs after the sync. Where a cancel fails, it tries the rest and pushes the stack, then fails.",
    "Where GitHub queues the merge, `merge` neither syncs nor cancels runs. Once the pull requests merge, run `jj gh sync`, with `--all-workspaces` where only other workspaces' working copies are on the stack.",
  ),
);
