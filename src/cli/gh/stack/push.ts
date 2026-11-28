import { Array as EffectArray, Console, Effect, Option } from "effect";

import type { Git, GitFailed } from "../../../clients/git";
import { GitHub } from "../../../clients/github/client";
import type { GitHubFailed } from "../../../clients/github/failure";
import type { PullRequest, PullRequestNumber } from "../../../clients/github/types";
import { Jj, type JjFailed } from "../../../clients/jj";
import { PrDescriptions } from "../../../clients/pr-descriptions";
import { IGNORE_CLAUDE_CODE_FOOTER, readSetting } from "../../../settings";
import { closeAbandoned } from "./abandoned";
import { type BookmarkTargets, bookmarkTargets } from "./bookmark-targets";
import {
  anyOf,
  bookmarkRevset,
  bookmarksAt,
  downstackChanges,
  exactPattern,
  type NotAStack,
  type StackChange,
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
import { type TrunkMismatch, trunkAndDownstack } from "./trunk";

interface PushOptions {
  readonly trunk: string;
  /**
   * Whether new pull requests open as drafts. Where false, also marks existing drafts ready once
   * the stack is registered.
   */
  readonly draft: boolean;
  readonly overwriteDescriptions: boolean;
  /** `bookmarkTargets`, read after the repository's last change. */
  readonly targets: BookmarkTargets;
}

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

export const push = (
  stack: readonly StackChange[],
  { draft, overwriteDescriptions, targets, trunk }: PushOptions,
): Effect.Effect<void, PushFailed, Git | GitHub | Jj | PrDescriptions> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const jj = yield* Jj;
    const records = yield* PrDescriptions;
    const bookmarks = EffectArray.map(stack, ({ bookmark }) => bookmark);
    const bases = basesFor(bookmarks, trunk);
    // `jj config list` doesn't snapshot the working copy, so it can run beside `jj log`.
    const [found, pushedDescriptions, ignoreClaudeCodeFooter] = yield* Effect.all(
      [
        Effect.forEach(
          stack,
          (change, index) =>
            github
              .openPullRequest(change.bookmark)
              .pipe(
                Effect.map((pullRequest) => ({ base: bases[index] ?? trunk, change, pullRequest })),
              ),
          { concurrency: "unbounded" },
        ),
        descriptionsOf(
          EffectArray.flatMap(bookmarks, (bookmark) =>
            Option.toArray(Option.fromUndefinedOr(targets.get(bookmark)?.origin)),
          ),
        ),
        readSetting(IGNORE_CLAUDE_CODE_FOOTER),
      ],
      { concurrency: "unbounded" },
    );
    // Before syncing descriptions, which can rewrite changes, so a failure changes nothing.
    const openNumbers = EffectArray.flatMap(found, ({ pullRequest }) =>
      Option.toArray(Option.map(pullRequest, ({ number }) => number)),
    );
    const existing = yield* stackContaining(openNumbers);

    // Before anything changes on GitHub, so a description conflict stops the whole submit. One at a
    // time, since rewording a change rewrites those above it.
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

    // Before the stack changes, so after a failure here the next submit finds the same stack and
    // closes the rest.
    yield* closeAbandoned(
      Option.match(existing, {
        onNone: () => [],
        onSome: ({ unmerged }) =>
          EffectArray.filter(unmerged, (number) => !openNumbers.includes(number)),
      }),
      [...targets],
    );

    // Dissolves a stack that `mustDissolve` says doesn't fit.
    const moving = EffectArray.flatMap(changes, ({ base, open }) =>
      Option.isSome(open) && open.value.pullRequest.base !== base ? [open.value.pullRequest] : [],
    );
    const wanted = EffectArray.map(changes, ({ open }) =>
      Option.map(open, ({ pullRequest }) => pullRequest.number),
    );
    const dissolve = mustDissolve(existing, wanted, moving.length > 0);
    if (dissolve && Option.isSome(existing)) {
      yield* github.unstack(existing.value.number);
      yield* Console.error(`dissolved stack #${existing.value.number}`);
    }

    // GitHub closes a pull request as merged once its base contains its head, as after pushing one
    // moved below its old base. Basing it on the trunk first prevents this, since its branch has
    // commits the trunk lacks.
    for (const { number } of EffectArray.filter(moving, ({ base }) => base !== trunk)) {
      yield* github.setBase(number, trunk);
    }
    const moved = new Set(EffectArray.map(moving, ({ number }) => number));

    // Jj creates a remote branch only for a bookmark that tracks it.
    const untracked = EffectArray.filter(bookmarks, (name) => targets.get(name)?.tracked !== true);
    if (untracked.length > 0) {
      yield* jj.run([
        "bookmark",
        "track",
        ...EffectArray.map(untracked, (bookmark) => exactPattern(bookmark)),
        "--remote",
        "origin",
      ]);
    }
    yield* jj.run([
      "git",
      "push",
      ...EffectArray.flatMap(bookmarks, (bookmark) => ["--bookmark", exactPattern(bookmark)]),
    ]);
    // The pushed commits, which the records are agreed for.
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

export const submit = (
  revision: string,
  options: Omit<PushOptions, "targets" | "trunk">,
): Effect.Effect<void, SubmitFailed, Git | GitHub | Jj | PrDescriptions> =>
  Effect.gen(function* () {
    // Read first, so a non-stack fails before the sync rewrites anything.
    const { downstack, trunk } = yield* trunkAndDownstack(revision);
    const targets = yield* bookmarkTargets;
    // `syncStack` changes nothing where it returns false, so `targets` stays current.
    if (!(yield* syncStack(revision, trunk, targets))) {
      yield* push(downstack, { ...options, targets, trunk });
      return;
    }
    // The sync can drop merged changes and replace others with GitHub's, so the stack is found
    // again by its bookmarks; the highest left is its top.
    const left = yield* bookmarksAt(
      anyOf(EffectArray.map(downstack, ({ bookmark }) => bookmarkRevset(bookmark))),
    );
    const top = EffectArray.findLast(downstack, ({ bookmark }) => left.includes(bookmark));
    if (Option.isNone(top)) {
      yield* Console.error(`nothing left to submit: the sync left no bookmark of the stack`);
      return;
    }
    // The sync rebases the rest of the stack even where that conflicts.
    const synced = yield* downstackChanges(bookmarkRevset(top.value.bookmark)).pipe(
      Effect.flatMap(withoutConflicts),
    );
    const syncedTargets = yield* bookmarkTargets;
    yield* push(synced, { ...options, targets: syncedTargets, trunk });
  });
