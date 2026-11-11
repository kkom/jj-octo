import { Console, Effect, Option } from "effect";

import type { Git, GitFailed } from "../../../clients/git";
import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import type { PullRequest, PullRequestNumber } from "../../../clients/github/types";
import { Jj, type JjFailed } from "../../../clients/jj";
import { PrDescriptions } from "../../../clients/pr-descriptions";
import { IGNORE_CLAUDE_CODE_FOOTER, readSetting } from "../../../settings";
import {
  anyOf,
  bookmarkRevset,
  bookmarksAt,
  bookmarkTargets,
  changesIn,
  downstackChanges,
  type NotAStack,
  type StackChange,
  stackChanges,
  stackRevset,
  withoutConflicts,
} from "./changes";
import {
  type DescriptionConflict,
  descriptionsOf,
  syncDescription,
  type SyncedDescription,
} from "./descriptions";
import { basesFor, mustDissolve, titleAndBody } from "./plan";
import type { NotCombined } from "./reconcile";
import { register, type SeveralStacks, stackContaining } from "./stacks";
import { type BranchesDeleted, syncStack } from "./sync-stack";
import { checkedTrunk, type TrunkMismatch } from "./trunk";

interface PushOptions {
  /** GitHub's default branch, which the bottom pull request is based on. */
  readonly trunk: string;
  /**
   * Whether a missing pull request is opened as a draft. Where false, existing drafts are marked
   * ready too, once the stack is registered.
   */
  readonly draft: boolean;
  /** Sends the local description where it and the pull request's both changed, without merging. */
  readonly overwriteDescriptions: boolean;
}

/** A pull request already open for a change, and the description they agree on. */
interface OpenPullRequest {
  readonly pullRequest: PullRequest;
  readonly synced: SyncedDescription;
}

export type PushFailed =
  | DescriptionConflict
  | GitFailed
  | GitHubFailed
  | JjFailed
  | NotAStack
  | SeveralStacks
  | TrunkMismatch;

export type SubmitFailed = BranchesDeleted | NotCombined | PushFailed;

/**
 * Pushes the changes' bookmarks, opens the pull requests missing, sets their bases, and registers
 * them as one stack. Each pull request's title and body are kept the same as its change's
 * description.
 */
const push = (
  stack: readonly StackChange[],
  { draft, overwriteDescriptions, trunk }: PushOptions,
): Effect.Effect<void, PushFailed, Git | GitHub | Jj | PrDescriptions> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const jj = yield* Jj;
    const records = yield* PrDescriptions;
    const bookmarks = stack.map(({ bookmark }) => bookmark);
    const bases = basesFor(bookmarks, trunk);
    const found = yield* Effect.all(
      stack.map((change, index) =>
        github
          .openPullRequest(change.bookmark)
          .pipe(
            Effect.map((pullRequest) => ({ base: bases[index] ?? trunk, change, pullRequest })),
          ),
      ),
      { concurrency: "unbounded" },
    );
    // Before a description is synced, which can rewrite changes, so a failure changes nothing.
    const existing = yield* stackContaining(
      found.flatMap(({ pullRequest }) =>
        Option.toArray(Option.map(pullRequest, ({ number }) => number)),
      ),
    );
    const targets = yield* bookmarkTargets;
    const pushedDescriptions = yield* descriptionsOf(
      bookmarks.flatMap((bookmark) => targets.get(bookmark)?.origin ?? []),
    );
    const ignoreClaudeCodeFooter = yield* readSetting(IGNORE_CLAUDE_CODE_FOOTER);

    // Before anything changes on GitHub, so a conflict in a description stops the whole submit.
    // One at a time, because rewording a change rewrites the ones above it.
    const changes = [];
    for (const { base, change, pullRequest } of found) {
      const pushed = targets.get(change.bookmark)?.origin;
      const options = {
        ignoreClaudeCodeFooter,
        overwriteDescriptions,
        pushedCommit: pushed,
        pushedDescription:
          (pushed === undefined ? undefined : pushedDescriptions.get(pushed)) ?? "",
      };
      changes.push({
        base,
        change,
        open: Option.isNone(pullRequest)
          ? Option.none<OpenPullRequest>()
          : Option.some({
              pullRequest: pullRequest.value,
              synced: yield* syncDescription(change, pullRequest.value, options),
            }),
      });
    }

    // GitHub rejects a base change on a pull request that is in a stack, and can only add to a
    // stack's top, so a stack that doesn't fit what is wanted is dissolved first.
    const moving = changes.flatMap(({ base, open }) =>
      Option.isSome(open) && open.value.pullRequest.base !== base ? [open.value.pullRequest] : [],
    );
    const wanted = changes.map(({ open }) =>
      Option.map(open, ({ pullRequest }) => pullRequest.number),
    );
    const dissolve = mustDissolve(existing, wanted, moving.length > 0);
    if (dissolve && Option.isSome(existing)) {
      yield* github.unstack(existing.value.number);
      yield* Console.error(`dissolved stack #${existing.value.number}`);
    }

    // GitHub closes a pull request as merged once its head is reachable from its base, and pushing
    // a pull request that moved below its old base does exactly that. Pointing it at the trunk first
    // prevents this, because its branch still has commits the trunk doesn't have.
    for (const { number } of moving.filter(({ base }) => base !== trunk)) {
      yield* github.setBase(number, trunk);
    }
    const moved = new Set(moving.map(({ number }) => number));

    // Jj only creates a branch on the remote for a bookmark that tracks it.
    for (const bookmark of bookmarks.filter((name) => targets.get(name)?.tracked !== true)) {
      yield* jj.run(["bookmark", "track", `exact:${bookmark}`, "--remote", "origin"]);
    }
    yield* jj.run([
      "git",
      "push",
      ...bookmarks.flatMap((bookmark) => ["--bookmark", `exact:${bookmark}`]),
    ]);
    // The commits pushed, which the records are agreed for.
    const pushedTargets = yield* bookmarkTargets;
    const record = (bookmark: string, description: string, pullRequest: PullRequestNumber) =>
      records.write({
        bookmark,
        commit: pushedTargets.get(bookmark)?.local ?? "",
        description,
        pullRequest,
      });

    const numbers = [];
    const drafts = [];
    for (const { base, change, open } of changes) {
      if (Option.isNone(open)) {
        const created = yield* github.createPullRequest({
          ...titleAndBody(change.description),
          base,
          draft,
          head: change.bookmark,
        });
        yield* Console.error(`opened #${created} for ${change.bookmark}`);
        yield* record(change.bookmark, change.description, created);
        numbers.push(created);
      } else {
        const {
          pullRequest: { number },
          synced: { send, text },
        } = open.value;
        if (moved.has(number) && base !== trunk) {
          yield* github.setBase(number, base);
        }
        if (send) {
          yield* github.setDescription(number, titleAndBody(text));
          yield* Console.error(`updated the description of #${number}`);
        }
        yield* record(change.bookmark, text, number);
        numbers.push(number);
        if (open.value.pullRequest.draft) {
          drafts.push(number);
        }
      }
    }

    yield* register(dissolve ? Option.none() : existing, numbers);
    // Last, so a failure here leaves every pull request open and the stack registered.
    if (!draft) {
      for (const number of drafts) {
        yield* github.markReadyForReview(number);
        yield* Console.error(`published #${number}`);
      }
    }
  });

/**
 * Pushes the revision's change and the ones below it in its stack, and opens their pull requests.
 * Syncs that stack first where any of its pull requests merged or any of its branches changed on
 * GitHub, since pushing over either would drop what GitHub has.
 */
export const submit = (
  revision: string,
  options: Omit<PushOptions, "trunk">,
): Effect.Effect<void, SubmitFailed, Git | GitHub | Jj | PrDescriptions> =>
  Effect.gen(function* () {
    const trunk = yield* checkedTrunk;
    // Read first, so a stack that isn't one fails before the sync rewrites anything.
    const downstack = yield* downstackChanges(revision).pipe(Effect.flatMap(withoutConflicts));
    if (!(yield* syncStack(revision, trunk))) {
      yield* push(downstack, { ...options, trunk });
      return;
    }
    // The sync can drop merged changes and replace others with GitHub's, so the stack is found
    // again by its bookmarks: the highest one left is its top.
    const left = yield* bookmarksAt(
      anyOf(downstack.map(({ bookmark }) => bookmarkRevset(bookmark))),
    );
    const top = downstack.findLast(({ bookmark }) => left.includes(bookmark));
    if (top === undefined) {
      yield* Console.error(
        `nothing left to submit: no bookmark of the stack is left after the sync`,
      );
      return;
    }
    // The sync rebases the rest of the stack even where that conflicts.
    const synced = yield* downstackChanges(bookmarkRevset(top.bookmark)).pipe(
      Effect.flatMap(withoutConflicts),
    );
    yield* push(synced, { ...options, trunk });
  });

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
