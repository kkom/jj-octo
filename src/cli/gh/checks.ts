import {
  Array as EffectArray,
  Console,
  Effect,
  Match,
  Option,
  String as EffectString,
} from "effect";
import { Command, Flag } from "effect/cli";

import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import {
  type Check,
  isOpen,
  type ListedPullRequest,
  type RequiredChecks,
} from "../../clients/github/types";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, provideGitHubFromOrigin, revisionFlag, table, withHelp } from "../command";
import { checkReport } from "./check-report";
import { CONFLICTED, type NotAStack, stackChanges } from "./stack/changes";

const openOf = (pullRequests: readonly ListedPullRequest[]): Option.Option<ListedPullRequest> =>
  EffectArray.findFirst(pullRequests, ({ state }) => isOpen(state));

interface Checked {
  readonly bookmark: string;
  readonly commitId: string;
  readonly conflict: boolean;
  readonly open: Option.Option<{
    readonly latest: readonly Check[];
    readonly pullRequest: ListedPullRequest;
  }>;
}

const checksLines = (
  checked: readonly Checked[],
  required: RequiredChecks,
  { verbose }: { readonly verbose: boolean },
): readonly string[] => {
  const reported = EffectArray.map(
    EffectArray.reverse(checked),
    ({ bookmark, commitId, conflict, open }) => ({
      bookmark,
      commitId,
      conflict,
      open: Option.map(open, ({ latest, pullRequest }) => ({
        pullRequest,
        report: checkReport(required, latest),
      })),
    }),
  );
  const lines = table(
    EffectArray.map(reported, ({ bookmark, commitId, conflict, open }) => [
      ...Option.match(open, {
        onNone: () => [bookmark, "no open pull request"],
        onSome: ({ pullRequest: { head, number }, report }) => [
          bookmark,
          `#${number} ${report.state}`,
          ...(head === commitId
            ? []
            : [`head ${EffectString.slice(0, 12)(head)} differs from the change`]),
        ],
      }),
      ...(conflict ? [CONFLICTED] : []),
    ]),
    2,
  );
  const blocks = EffectArray.zipWith(lines, reported, (line, { open }) => [
    line,
    ...(verbose
      ? Option.match(open, {
          onNone: () => [],
          onSome: ({ report }) => EffectArray.map(report.rows, (row) => `  ${row}`),
        })
      : []),
  ]);
  const why = Match.value(required).pipe(
    Match.tag("Unknown", ({ reason }) => [[`required checks unknown: ${reason}`]]),
    Match.tag("Known", () => []),
    Match.exhaustive,
  );
  return verbose
    ? EffectArray.intersperse([...why, ...blocks], [""]).flat()
    : [...why, ...blocks].flat();
};

export const checks = (
  revision: string,
  options: { readonly verbose: boolean },
): Effect.Effect<readonly string[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const [stack, trunk] = yield* Effect.all([stackChanges(revision), github.defaultBranch], {
      concurrency: "unbounded",
    });
    const [required, checked] = yield* Effect.all(
      [
        github.requiredChecks(trunk),
        Effect.forEach(
          stack,
          ({ bookmark, commitId, conflict }) =>
            github.pullRequestsFrom(bookmark).pipe(
              Effect.flatMap((found) =>
                Effect.transposeOption(
                  Option.map(openOf(found), (pullRequest) =>
                    github
                      .latestChecks(pullRequest.head)
                      .pipe(Effect.map((latest) => ({ latest, pullRequest }))),
                  ),
                ),
              ),
              Effect.map((open): Checked => ({ bookmark, commitId, conflict, open })),
            ),
          { concurrency: "unbounded" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    return checksLines(checked, required, options);
  });

export const checksCommand = Command.make(
  "checks",
  {
    revision: revisionFlag("A change of the stack to show"),
    verbose: Flag.Boolean("verbose").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Also print each check of each pull request, with its latest result"),
    ),
  },
  ({ revision, verbose }) =>
    asUserError(checks(revision, { verbose })).pipe(
      Effect.flatMap((printed) => Console.log(EffectArray.join(printed, "\n"))),
    ),
).pipe(
  provideGitHubFromOrigin,
  withHelp(
    "Show the state of the required checks of the stack's pull requests",
    "Prints one line per change, top first: its bookmark, its open pull request, and the required checks' state furthest from passing: `failed`, `unknown`, `pending`, `skipped` or `passed`. Unless they passed, it names the checks in that state, such as `failed: CI`. It prints `no open pull request` for a change without one, and `no required checks` where none are required. Where the required checks can't be known, the state is `unknown`, and a line above says why. A change with conflicts ends its line with `conflicted`.",
    "With `--verbose`, each line is followed by one row per check, required ones first, with GitHub's word for its result, such as `success`. A required check without a result is `expected`.",
    "The checks are those of the pull request's head commit, which the line names where it differs from the change. Each check counts once, with its latest result: the newest check run per name and app, and the latest commit status per name. GitHub matches required checks by name, so same-named jobs in two workflows count as one check. A check passes on `success` or `neutral`. A check that ends as `skipped`, such as by a path filter, is `skipped`, though GitHub counts it as passed. A required check naming a GitHub App counts only that app's check runs. GitHub doesn't say which app sent a commit status, so a status of that name is `maybe required`, and makes the check `unknown` where counting it changes the state. A check with several results takes the one furthest from passing.",
    "The required checks are the default branch's, from its rulesets and branch protection, since `jj gh merge` merges the stack into it. Where the token can't read them, or the rulesets also require workflows, code scanning results or deployments, they're unknown, and each `--verbose` row says `maybe required`.",
    "Changes nothing, locally or on GitHub.",
  ),
);
