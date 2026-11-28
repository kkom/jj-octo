import { Array as EffectArray, Console, Effect, Option } from "effect";

import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import type { PullRequestNumber } from "../../../clients/github/types";
import type { Jj, JjFailed } from "../../../clients/jj";
import type { BookmarkTarget } from "./bookmark-targets";
import { anyOf, changeIdsAt, changeRevset } from "./changes";

export const CLOSED_COMMENT =
  "Closed by jj-octo, since this pull request's change was abandoned. Reopen it to keep it.";

// Bookmarks deleted here whose tracked `origin` branch is on a change with no visible commit, as
// `jj abandon` leaves them.
const abandonedBookmarks = (targets: readonly (readonly [string, BookmarkTarget])[]) =>
  Effect.gen(function* () {
    const candidates = EffectArray.flatMap(targets, ([name, { deleted, originChange, tracked }]) =>
      deleted && tracked && originChange !== undefined ? [{ change: originChange, name }] : [],
    );
    if (candidates.length === 0) {
      return [];
    }
    const visibleIds = yield* changeIdsAt(
      anyOf(EffectArray.map(candidates, ({ change }) => changeRevset(change))),
    );
    const visible = new Set(visibleIds);
    return EffectArray.map(
      EffectArray.filter(candidates, ({ change }) => !visible.has(change)),
      ({ name }) => name,
    );
  });

/** `left` are the pull requests that the pushed stack no longer holds. */
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
