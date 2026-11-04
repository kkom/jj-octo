import { Console, Data, Effect, Option } from "effect";
import { Command } from "effect/cli";

import type { Git } from "../../clients/git";
import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, withHelp } from "../command";
import { bookmarkTargets, downstackChanges, type NotAStack, pushedState } from "./stack/changes";

export class NotPublishable extends Data.TaggedError("NotPublishable")<{
  readonly message: string;
}> {}

/**
 * Marks the draft pull requests of the revision's change and the ones below it ready for review,
 * bottom to top. Fails before marking any where a change has edits that aren't pushed, or has no
 * open pull request, so a reviewer never sees one that is out of date.
 */
export const publish = (
  revision: string,
): Effect.Effect<void, GitHubFailed | JjFailed | NotAStack | NotPublishable, Git | GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const changes = yield* downstackChanges(revision);
    const targets = yield* bookmarkTargets;
    const unpushed = changes.filter(
      (change) => pushedState(targets.get(change.bookmark), change) !== "pushed",
    );
    if (unpushed.length > 0) {
      yield* new NotPublishable({
        message: `these changes aren't pushed: ${unpushed.map(({ bookmark }) => bookmark).join(", ")}; run \`jj gh submit --publish\` instead`,
      });
    }
    const found = yield* Effect.forEach(
      changes,
      ({ bookmark }) =>
        Effect.map(github.openPullRequest(bookmark), (pullRequest) => ({ bookmark, pullRequest })),
      { concurrency: "unbounded" },
    );
    const missing = found.filter(({ pullRequest }) => Option.isNone(pullRequest));
    if (missing.length > 0) {
      yield* new NotPublishable({
        message: `no open pull request for ${missing.map(({ bookmark }) => bookmark).join(", ")}; run \`jj gh submit --publish\` instead`,
      });
    }
    const drafts = found.flatMap(({ pullRequest }) =>
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
  ({ revision }) => asUserError(publish(revision).pipe(Effect.provide(GitHubFromOrigin))),
).pipe(
  withHelp(
    "Mark the draft pull requests of a change and the ones below it ready for review",
    "An empty working copy means the change below it, so from the top of a stack this publishes all of it. Leaves a pull request that is already ready as it is.",
    "Fails before publishing any where one of the changes has edits that aren't pushed, or has no open pull request. `jj gh submit --publish` pushes them and publishes in one go.",
    "GitHub's REST API can't make a draft ready, so this uses its GraphQL API. Where `CLAUDE_CODE_REMOTE` is `true`, in a Claude Code cloud session whose GitHub proxy rejects GraphQL, it uses the proxy's own route for it instead. A proxy that doesn't serve that route fails the publish with its own error.",
  ),
);
