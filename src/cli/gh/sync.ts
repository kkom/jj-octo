import { Effect } from "effect";
import { Command } from "effect/cli";

import type { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { Jj, JjFailed } from "../../clients/jj";
import type { PrDescriptions } from "../../clients/pr-descriptions";
import { asUserError, withHelp } from "../command";
import { bookmarksBeforeFetch } from "./stack/combine";
import {
  type MergedChange,
  mergedOnGitHub,
  type NotCombined,
  notMerged,
  reconcile,
} from "./stack/reconcile";
import { checkedTrunk } from "./stack/trunk";

/**
 * Rebases every stack that doesn't conflict onto the fetched trunk, and pushes nothing. Each
 * bookmark is combined with its branch on GitHub first, and each merged change abandoned.
 */
export const sync = (
  // Changes known to have merged, which GitHub isn't asked about.
  known: readonly MergedChange[] = [],
): Effect.Effect<void, GitHubFailed | JjFailed | NotCombined, GitHub | Jj | PrDescriptions> =>
  Effect.gen(function* () {
    const before = yield* bookmarksBeforeFetch("mutable()");
    const merged = [
      ...known,
      ...(yield* mergedOnGitHub(before.filter(({ name }) => notMerged(known)(name)))),
    ];
    yield* reconcile({ before, merged, scope: "every stack" });
  });

export const syncCommand = Command.make("sync", {}, () =>
  asUserError(
    Effect.gen(function* () {
      yield* checkedTrunk;
      yield* sync();
    }).pipe(Effect.provide(GitHubFromOrigin)),
  ),
).pipe(
  withHelp(
    "Fetch, and rebase every change onto the trunk",
    "Fetches, then rebases every unmerged change onto the trunk, keeping each on the changes below it. Abandons each change whose pull request merged, and forgets its bookmark, unless you edited the change after the merge.",
    "Leaves a stack that would conflict with the trunk where it was, and names it. When you want to resolve the conflict, rebase it with `jj rebase`. `sync` rebases the rest of a stack whose changes merged even where the rebase conflicts, and records the conflict in the change.",
    "Squashes commits added to a branch on GitHub into the branch's local change, even where that change has local edits too. Where GitHub only rebased a branch, keeps the local change.",
    "Fails before fetching if `trunk()` isn't GitHub's default branch, which `jj-octo init` sets.",
    "Pushes nothing. To update the pull requests of a change and the ones below it, run `jj gh submit`.",
  ),
);
