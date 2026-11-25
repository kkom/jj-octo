import { Console, Effect, Option } from "effect";

import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import type { PullRequestNumber } from "../../../clients/github/types";
import type { Jj, JjFailed } from "../../../clients/jj";
import type { BookmarkTarget } from "./bookmark-targets";
import { anyOf, changeIdsAt, changeRevset } from "./changes";

/** What a push comments on a pull request that it closed. */
export const CLOSED_COMMENT =
  "Closed by jj-octo, because the change of this pull request was abandoned. Reopen the pull request to keep it.";

// The bookmarks deleted here whose tracked branch on `origin` is on a change with no visible commit,
// as `jj abandon` leaves them.
const abandonedBookmarks = (targets: readonly (readonly [string, BookmarkTarget])[]) =>
  Effect.gen(function* () {
    const candidates = targets.flatMap(([name, { deleted, originChange, tracked }]) =>
      deleted && tracked && originChange !== undefined ? [{ change: originChange, name }] : [],
    );
    if (candidates.length === 0) {
      return [];
    }
    const visible = new Set(
      yield* changeIdsAt(anyOf(candidates.map(({ change }) => changeRevset(change)))),
    );
    return candidates.filter(({ change }) => !visible.has(change)).map(({ name }) => name);
  });

/**
 * Closes those of the pull requests whose change was abandoned, and comments why. `left` are the
 * pull requests that the pushed stack no longer holds, and `targets` every bookmark with its targets.
 */
export const closeAbandoned = (
  left: readonly PullRequestNumber[],
  targets: readonly (readonly [string, BookmarkTarget])[],
): Effect.Effect<void, GitHubFailed | JjFailed, GitHub | Jj> =>
  Effect.gen(function* () {
    if (left.length === 0) {
      return;
    }
    const github = yield* GitHub;
    for (const bookmark of yield* abandonedBookmarks(targets)) {
      const open = yield* github.openPullRequest(bookmark);
      if (Option.isSome(open) && left.includes(open.value.number)) {
        const { number } = open.value;
        yield* github.closePullRequest(number);
        yield* Console.error(`closed #${number}, since the change of ${bookmark} was abandoned`);
        yield* github.commentOnPullRequest(number, CLOSED_COMMENT);
      }
    }
  });
