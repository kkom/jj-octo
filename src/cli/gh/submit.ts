import { Command, Flag } from "effect/cli";

import { asUserError, provideGitHubFromOrigin, revisionFlag, withHelp } from "../command";
import { submit } from "./stack/push";

export const submitCommand = Command.make(
  "submit",
  {
    overwriteDescriptions: Flag.Boolean("overwrite-descriptions").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Where a description changed locally and on GitHub, send the local one instead of merging",
      ),
    ),
    publish: Flag.Boolean("publish").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Open new pull requests ready for review, and mark existing drafts ready",
      ),
    ),
    revision: revisionFlag("The top change to submit"),
  },
  ({ overwriteDescriptions, publish, revision }) =>
    asUserError(submit(revision, { draft: !publish, overwriteDescriptions })),
).pipe(
  provideGitHubFromOrigin,
  withHelp(
    "Push a change and the ones below it, and open their pull requests",
    "Pushes each change's bookmark, and opens a pull request for each branch without one, titled and described from the change's description. Bases each pull request on the branch below, and the bottom one on the default branch.",
    "Opens new pull requests as drafts. `--publish` opens them ready for review and marks existing drafts ready after the push.",
    "Keeps each pull request's title and body equal to its change's description: it writes GitHub edits into the change, sends local edits, and merges edits on both sides line by line. Edits to the same lines stop the submit before any push. It records the last agreed description in `jj-octo/pr-descriptions` under the main workspace's `.jj/repo`, so it also sends local edits pushed with `jj git push`.",
    "First, where a submitted change's pull request merged or its branch changed on GitHub, syncs only that stack, as `jj gh sync` does, so the push keeps GitHub's changes.",
    "Stops before changing anything where a submitted change's branch was deleted on GitHub and the change doesn't count as merged: no pull request from it merged, another commit merged, or you edited it since. It says how to push the change again or drop it.",
    "Fails before any push where the sync's rebase gives a submitted change conflicts, since `jj git push` won't push it.",
    "Registers the pull requests as one GitHub stack, unless there is only one. After a reorder, insertion or dropped change, it dissolves the GitHub stack and registers it again under a new number. The pull requests stay open, including that of a change moved out of the stack.",
    "Closes the pull request of each change you abandoned in this repository, and comments why. It does this before it changes the stack, and only where the pull requests are in a GitHub stack.",
  ),
);
