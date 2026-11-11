import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { GitHubFromOrigin } from "../../clients/github/origin";
import { asUserError, revisionFlag, withHelp } from "../command";
import { submit } from "./stack/push";

export const submitCommand = Command.make(
  "submit",
  {
    overwriteDescriptions: Flag.Boolean("overwrite-descriptions").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Where a description changed both locally and on GitHub, send the local one instead of merging the two",
      ),
    ),
    publish: Flag.Boolean("publish").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Open new pull requests ready for review, and mark existing drafts ready, as `jj gh publish` does",
      ),
    ),
    revision: revisionFlag("The top change to submit"),
  },
  ({ overwriteDescriptions, publish, revision }) =>
    asUserError(
      submit(revision, { draft: !publish, overwriteDescriptions }).pipe(
        Effect.provide(GitHubFromOrigin),
      ),
    ),
).pipe(
  withHelp(
    "Push a change and the ones below it, and open their pull requests",
    "Pushes the bookmark of each change. An empty working copy means the change below it. Opens a pull request for each branch that has none, with the title and body from its change's description. Points each pull request at the branch below it, and the bottom one at the default branch.",
    "Opens new pull requests as drafts. With `--publish`, opens them ready for review, and marks existing drafts ready after the push.",
    "Keeps each pull request's title and body the same as its change's description. `submit` writes an edit made on GitHub into the change, and sends a local edit to the pull request. It merges edits on both sides line by line. It also sends a local edit pushed with `jj git push`, because it records the description both sides last agreed on, in `jj-octo/pr-descriptions` under the main workspace's `.jj/repo`. Edits to the same lines stop the submit before it pushes anything.",
    "First, where a submitted change's pull request merged or its branch changed on GitHub, syncs that stack as `jj gh sync` does, so the push doesn't undo what GitHub did. It leaves other stacks as they are.",
    "Stops before changing anything where someone deleted a submitted change's branch on GitHub and the change doesn't count as merged: no pull request from it merged, another commit merged, or you edited the change since. It says how to push the change again or drop it.",
    "Fails before pushing anything where a submitted change has conflicts, as `jj git push` doesn't push one. That includes a conflict that the sync gives a change, by rebasing it onto the trunk. A change above the one submitted can have conflicts.",
    "Registers the pull requests as one GitHub stack, unless there is only one.",
    "After a reorder, an insertion or a dropped change, dissolves the GitHub stack and registers it again under a new number. The pull requests stay open, including a dropped change's.",
  ),
);
