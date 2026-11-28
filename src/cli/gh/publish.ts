import { Array as EffectArray, Console, Effect, Option, Schema } from "effect";
import { Command } from "effect/cli";

import type { Git } from "../../clients/git";
import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, provideGitHubFromOrigin, revisionFlag, withHelp } from "../command";
import { bookmarkTargets } from "./stack/bookmark-targets";
import { downstackChanges, type NotAStack, pushedState, withoutConflicts } from "./stack/changes";

export class NotPublishable extends Schema.TaggedError<
  NotPublishable,
  { readonly brand: unique symbol }
>()("NotPublishable", { message: Schema.String }) {}

export const publish = (
  revision: string,
): Effect.Effect<void, GitHubFailed | JjFailed | NotAStack | NotPublishable, Git | GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const changes = yield* downstackChanges(revision).pipe(Effect.flatMap(withoutConflicts));
    const targets = yield* bookmarkTargets;
    const unpushed = EffectArray.filter(
      changes,
      (change) => pushedState(targets.get(change.bookmark), change) !== "pushed",
    );
    if (unpushed.length > 0) {
      return yield* NotPublishable.make({
        message: `these changes aren't pushed: ${EffectArray.join(
          EffectArray.map(unpushed, ({ bookmark }) => bookmark),
          ", ",
        )}; run \`jj gh submit --publish\` instead`,
      });
    }
    const found = yield* Effect.forEach(
      changes,
      ({ bookmark }) =>
        Effect.map(github.openPullRequest(bookmark), (pullRequest) => ({ bookmark, pullRequest })),
      { concurrency: "unbounded" },
    );
    const missing = EffectArray.filter(found, ({ pullRequest }) => Option.isNone(pullRequest));
    if (missing.length > 0) {
      return yield* NotPublishable.make({
        message: `no open pull request for ${EffectArray.join(
          EffectArray.map(missing, ({ bookmark }) => bookmark),
          ", ",
        )}; run \`jj gh submit --publish\` instead`,
      });
    }
    const drafts = EffectArray.flatMap(found, ({ pullRequest }) =>
      Option.toArray(Option.filter(pullRequest, ({ draft }) => draft)),
    );
    if (drafts.length === 0) {
      yield* Console.error("no draft pull requests to publish");
    }
    for (const { number } of drafts) {
      yield* github.markReadyForReview(number);
      yield* Console.error(`published #${number}`);
    }
  });

export const publishCommand = Command.make(
  "publish",
  { revision: revisionFlag("The top change to publish") },
  ({ revision }) => asUserError(publish(revision)),
).pipe(
  provideGitHubFromOrigin,
  withHelp(
    "Mark the draft pull requests of a change and the ones below it ready for review",
    "Leaves ready pull requests as they are.",
    "Fails before publishing any where a change has unpushed edits or no open pull request, so reviewers never see an outdated one. `jj gh submit --publish` pushes, then publishes.",
    "Uses GitHub's GraphQL API, since REST can't mark a draft ready. In a Claude Code cloud session (`CLAUDE_CODE_REMOTE` is `true`), it uses the GitHub proxy's own route, and fails with the proxy's error where the proxy lacks it.",
  ),
);
