import { Console, Data, Effect, Option } from "effect";
import { Command } from "effect/cli";

import type { Git } from "../../clients/git";
import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, withHelp } from "../command";
import {
  bookmarkTargets,
  downstackChanges,
  type NotAStack,
  pushedState,
  withoutConflicts,
} from "./stack/changes";
import { checkDescriptions, type DescriptionsNotReady } from "./stack/readiness";

export class NotPublishable extends Data.TaggedError("NotPublishable")<{
  readonly message: string;
}> {}

/**
 * Marks the draft pull requests of the revision's change and the ones below it ready for review,
 * bottom to top. Fails before marking any where a change has conflicts, has edits that aren't
 * pushed, or has no open pull request, so a reviewer never sees one that is out of date. Fails
 * too where a draft's description isn't ready for review, since reviewers start once it's published.
 */
export const publish = (
  revision: string,
): Effect.Effect<
  void,
  DescriptionsNotReady | GitHubFailed | JjFailed | NotAStack | NotPublishable,
  Git | GitHub | Jj
> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const changes = yield* downstackChanges(revision).pipe(Effect.flatMap(withoutConflicts));
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
      (change) =>
        Effect.map(github.openPullRequest(change.bookmark), (pullRequest) => ({
          bookmark: change.bookmark,
          change,
          pullRequest,
        })),
      { concurrency: "unbounded" },
    );
    const missing = found.filter(({ pullRequest }) => Option.isNone(pullRequest));
    if (missing.length > 0) {
      yield* new NotPublishable({
        message: `no open pull request for ${missing.map(({ bookmark }) => bookmark).join(", ")}; run \`jj gh submit --publish\` instead`,
      });
    }
    const drafts = found.flatMap(({ change, pullRequest }) =>
      Option.toArray(Option.filter(pullRequest, ({ draft }) => draft)).map(({ number }) => ({
        change,
        number,
      })),
    );
    yield* checkDescriptions(
      drafts.map(({ change }) => change),
      { publishing: true },
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
    "An empty working copy means the change below it. Leaves pull requests that are already ready as they are.",
    "Fails before publishing any where a change has conflicts, has edits that aren't pushed, or has no open pull request. A change above the one named can have conflicts. `jj gh submit --publish` pushes the changes and then publishes them.",
    "Also fails before publishing any where a draft's description isn't ready for review: it has nothing after its first line, or lacks a heading of the trunk's pull request template. The template is the first `pull_request_template.md`, in any case, in `.github`, the root or `docs`. A heading inside an HTML comment doesn't count.",
    "Uses GitHub's GraphQL API, since REST can't mark a draft ready. In a Claude Code cloud session, where `CLAUDE_CODE_REMOTE` is `true`, it uses the GitHub proxy's own route for this instead. Where the proxy doesn't serve that route, it fails with the proxy's error.",
  ),
);
