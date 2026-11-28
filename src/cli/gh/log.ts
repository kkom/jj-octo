import { Array as EffectArray, Console, Effect, Option } from "effect";
import { Command } from "effect/cli";

import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import type { PullRequest } from "../../clients/github/types";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, provideGitHubFromOrigin, revisionFlag, table, withHelp } from "../command";
import { bookmarkTargets } from "./stack/bookmark-targets";
import {
  CONFLICTED,
  type NotAStack,
  type Pushed,
  pushedState,
  stackChanges,
} from "./stack/changes";

interface LogEntry {
  readonly bookmark: string;
  readonly conflict: boolean;
  readonly pullRequest: Option.Option<PullRequest>;
  readonly pushed: Pushed;
}

const logLines = (entries: readonly LogEntry[]): readonly string[] => {
  const rows = EffectArray.map(
    EffectArray.reverse(entries),
    ({ bookmark, conflict, pullRequest, pushed }) => [
      bookmark,
      Option.match(pullRequest, {
        onNone: () => "no pull request",
        onSome: ({ draft, number }) => `#${number} ${draft ? "draft" : "ready"}`,
      }),
      pushed,
      ...(conflict ? [CONFLICTED] : []),
    ],
  );
  return table(rows, 2);
};

export const log = (
  revision: string,
): Effect.Effect<readonly string[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* stackChanges(revision);
    const [targets, pullRequests] = yield* Effect.all(
      [
        bookmarkTargets,
        Effect.forEach(stack, ({ bookmark }) => github.openPullRequest(bookmark), {
          concurrency: "unbounded",
        }),
      ],
      { concurrency: "unbounded" },
    );
    return logLines(
      EffectArray.map(stack, (change, index) => ({
        bookmark: change.bookmark,
        conflict: change.conflict,
        pullRequest: pullRequests[index] ?? Option.none(),
        pushed: pushedState(targets.get(change.bookmark), change),
      })),
    );
  });

export const logCommand = Command.make(
  "log",
  { revision: revisionFlag("A change of the stack to show") },
  ({ revision }) =>
    asUserError(log(revision)).pipe(
      Effect.flatMap((printed) => Console.log(EffectArray.join(printed, "\n"))),
    ),
).pipe(
  provideGitHubFromOrigin,
  withHelp(
    "Show changes and their pull requests",
    "Prints one line per change, top first: its bookmark, its pull request as draft or ready, and whether the change is pushed, changed since the push, or not pushed. Marks a change with conflicts `conflicted`.",
    "Changes nothing, locally or on GitHub.",
  ),
);
