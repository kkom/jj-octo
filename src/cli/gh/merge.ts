import { Console, Data, Effect, Exit, Option } from "effect";
import { Command, Flag } from "effect/cli";

import type { Git } from "../../clients/git";
import { GitHub } from "../../clients/github/client";
import { GitHubFailed } from "../../clients/github/failure";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { PullRequest, PullRequestNumber } from "../../clients/github/types";
import type { Jj } from "../../clients/jj";
import type { PrDescriptions } from "../../clients/pr-descriptions";
import { asUserError, revisionFlag, withHelp } from "../command";
import {
  bookmarkRevset,
  bookmarksAt,
  bookmarkTargets,
  commitsAt,
  downstackChanges,
  pushedState,
  type StackChange,
  upstackRevset,
} from "./stack/changes";
import { type PushFailed, pushAgain } from "./stack/push";
import type { NotCombined } from "./stack/reconcile";
import { checkedTrunk } from "./stack/trunk";
import { sync } from "./sync";

export class NotMergeable extends Data.TaggedError("NotMergeable")<{
  readonly message: string;
}> {}

const numbered = (pullRequests: readonly PullRequestNumber[]): string =>
  pullRequests.map((number) => `#${number}`).join(", ");

const openPullRequestOf = (bookmark: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const opened = yield* github.openPullRequest(bookmark);
    if (Option.isNone(opened)) {
      return yield* new NotMergeable({
        message: `no open pull request for ${bookmark}; run \`jj gh submit\` first`,
      });
    }
    return opened.value;
  });

/** Merges the pull request, and returns whether it has merged or is only queued to. */
const mergeOnGitHub = ({ base, number }: PullRequest, trunk: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* github.stackOf(number);
    if (Option.isSome(stack)) {
      const { unmerged } = stack.value;
      yield* Console.error(`merging ${numbered(unmerged.slice(0, unmerged.indexOf(number) + 1))}`);
      return yield* github.mergeStack(number);
    }
    // Outside a GitHub stack a merge goes into the pull request's base, and takes nothing below
    // it along.
    if (base !== trunk) {
      return yield* new NotMergeable({
        message: `#${number} isn't in a GitHub stack, and its base is ${base}, so merging it wouldn't reach the trunk; run \`jj gh submit\` to register the stack, or merge the changes below it first`,
      });
    }
    yield* Console.error(`merging ${numbered([number])}`);
    yield* github.mergePullRequest(number);
    return "merged" as const;
  });

/**
 * Cancels the workflow runs that haven't completed for the merged changes' commits, which are their
 * pull requests' heads. Tries every run, and fails at the end if any cancel failed.
 */
const cancelPullRequestRuns = (changes: readonly StackChange[]) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const runs = (yield* Effect.forEach(
      changes,
      ({ commitId }) => github.unfinishedRuns(commitId),
      { concurrency: 4 },
    )).flat();
    const [outcomes, failures] = yield* Effect.partition(runs, (run) => github.cancelRun(run), {
      concurrency: 4,
    });
    const cancelled = outcomes.filter((outcome) => outcome === "cancelled").length;
    yield* Console.error(
      `cancelled ${cancelled} workflow ${cancelled === 1 ? "run" : "runs"} of the merged pull requests`,
    );
    if (failures.length > 0) {
      yield* new GitHubFailed({
        message: [
          `couldn't cancel ${failures.length} of the merged pull requests' workflow runs:`,
          ...failures.map(({ message }) => message),
        ].join("\n"),
      });
    }
  });

/**
 * Merges the pull requests of the revision's change and the ones below it in its stack. One in a
 * GitHub stack is merged through the stack API, together with everything below it, or nothing at
 * all. One outside a stack is merged normally. Then syncs, and pushes again what is left of the
 * stack. With `cancelPrRuns`, it cancels the merged pull requests' workflow runs that haven't
 * completed, after the sync.
 */
export const merge = (
  revision: string,
  { cancelPrRuns }: { readonly cancelPrRuns: boolean },
): Effect.Effect<
  void,
  NotCombined | NotMergeable | PushFailed,
  Git | GitHub | Jj | PrDescriptions
> =>
  Effect.gen(function* () {
    const trunk = yield* checkedTrunk;
    const changes = yield* downstackChanges(revision);
    const top = changes.at(-1)?.bookmark ?? "";

    // GitHub merges what was pushed, so an edit made since would be left behind on a change
    // whose branch is gone.
    const targets = yield* bookmarkTargets;
    const unpushed = changes.filter(
      (change) => pushedState(targets.get(change.bookmark), change) !== "pushed",
    );
    if (unpushed.length > 0) {
      yield* new NotMergeable({
        message: `these changes aren't pushed: ${unpushed.map(({ bookmark }) => bookmark).join(", ")}; run \`jj gh submit\` first`,
      });
    }
    const pullRequest = yield* openPullRequestOf(top);
    const above = yield* bookmarksAt(upstackRevset(bookmarkRevset(top)));

    if ((yield* mergeOnGitHub(pullRequest, trunk)) === "enqueued") {
      yield* Console.error(
        `queued to merge; run \`jj gh sync\` once it has${cancelPrRuns ? ", and cancel the workflow runs yourself" : ""}`,
      );
    } else {
      yield* Console.error(`merged up to #${pullRequest.number}`);
      // GitHub merged exactly what was pushed, as checked above.
      yield* sync(changes);
      // Before the push, which can fail, and failing only after it, so a token that can't
      // cancel runs still leaves the rest of the stack pushed.
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
    cancelPrRuns: Flag.Boolean("cancel-pr-runs").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "After merging, cancel the merged pull requests' workflow runs that haven't completed",
      ),
    ),
    revision: revisionFlag("The top change to merge"),
  },
  ({ cancelPrRuns, revision }) =>
    asUserError(merge(revision, { cancelPrRuns }).pipe(Effect.provide(GitHubFromOrigin))),
).pipe(
  withHelp(
    "Merge the pull requests of a change and the ones below it",
    "Squash-merges them, and prints which before it does. An empty working copy means the change below it. Fails before merging if any of the changes has edits that aren't pushed.",
    "A pull request in a GitHub stack is merged together with the pull requests below it. Either all of them merge or none does. A pull request outside a stack is merged alone, and only if its base is the trunk.",
    "Then syncs, as `jj gh sync` does: it abandons the merged changes, forgets their bookmarks, and rebases the rest of the stack onto the trunk even where it conflicts, recording the conflict in the change. Then it pushes what is left of the change's stack again, up to the highest branch already on GitHub.",
    "With `--cancel-pr-runs`, it also cancels the merged pull requests' workflow runs that haven't completed, after the sync. Where a cancel fails, it still tries the rest and pushes the stack, then fails.",
    "If GitHub queues the merge instead, nothing is synced or cancelled. Run `jj gh sync` once it has merged.",
  ),
);
