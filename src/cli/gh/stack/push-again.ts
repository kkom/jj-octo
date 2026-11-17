import { Console, Effect } from "effect";

import type { Git } from "../../../clients/git";
import type { GitHub } from "../../../clients/github/client";
import type { Jj } from "../../../clients/jj";
import type { PrDescriptions } from "../../../clients/pr-descriptions";
import { bookmarkTargets, changesIn, stackChanges, stackRevset } from "./changes";
import { push, type PushFailed } from "./push";

/**
 * Pushes the stack containing the revision again, up to the highest bookmark already pushed, so
 * local work above it stays local. A change with conflicts can't be pushed, so it pushes only the
 * changes below the lowest one, and prints which it leaves local. Does nothing when the stack has
 * no changes left or was never pushed.
 */
export const pushAgain = (
  revision: string,
  trunk: string,
): Effect.Effect<void, PushFailed, Git | GitHub | Jj | PrDescriptions> =>
  Effect.gen(function* () {
    if ((yield* changesIn(stackRevset(revision))).length === 0) {
      return;
    }
    const stack = yield* stackChanges(revision);
    const targets = yield* bookmarkTargets;
    const pushed = stack.slice(
      0,
      stack.findLastIndex(({ bookmark }) => targets.get(bookmark)?.origin !== undefined) + 1,
    );
    const conflicted = pushed.findIndex(({ conflict }) => conflict);
    const left = conflicted === -1 ? [] : pushed.slice(conflicted);
    if (left.length > 0) {
      yield* Console.error(
        [
          "left these changes local, since they or a change below them have conflicts:",
          ...left.map(({ label }) => label),
        ].join("\n"),
      );
    }
    const pushing = pushed.slice(0, pushed.length - left.length);
    if (pushing.length > 0) {
      yield* push(pushing, { draft: true, overwriteDescriptions: false, trunk });
    }
  });
