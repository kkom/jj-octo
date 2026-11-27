import { Array as EffectArray, Console, Effect, Option } from "effect";

import type { Git } from "../../../clients/git";
import type { GitHub } from "../../../clients/github/client";
import type { Jj } from "../../../clients/jj";
import type { PrDescriptions } from "../../../clients/pr-descriptions";
import { bookmarkTargets } from "./bookmark-targets";
import { changesIn, stackChanges, stackRevset } from "./changes";
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
    const pushed = Option.match(
      EffectArray.findLastIndex(
        stack,
        ({ bookmark }) => targets.get(bookmark)?.origin !== undefined,
      ),
      { onNone: () => [], onSome: (highest) => stack.slice(0, highest + 1) },
    );
    const left = Option.match(
      EffectArray.findFirstIndex(pushed, ({ conflict }) => conflict),
      { onNone: () => [], onSome: (conflicted) => pushed.slice(conflicted) },
    );
    if (left.length > 0) {
      yield* Console.error(
        EffectArray.join(
          [
            "left these changes local, since they or a change below them have conflicts:",
            ...EffectArray.map(left, ({ label }) => label),
          ],
          "\n",
        ),
      );
    }
    const pushing = pushed.slice(0, pushed.length - left.length);
    if (pushing.length > 0) {
      yield* push(pushing, { draft: true, overwriteDescriptions: false, trunk });
    }
  });
