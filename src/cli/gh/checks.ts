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

/** The open pull request among those from a branch, newest first. */
const openOf = (pullRequests: readonly ListedPullRequest[]): Option.Option<ListedPullRequest> =>
  EffectArray.findFirst(pullRequests, ({ state }) => isOpen(state));

/** A change of the stack, with its open pull request and that pull request's latest checks. */
interface Checked {
  readonly bookmark: string;
  readonly commitId: string;
  readonly conflict: boolean;
  readonly open: Option.Option<{
    readonly latest: readonly Check[];
    readonly pullRequest: ListedPullRequest;
  }>;
}

/**
 * One line per change, top first: its bookmark, then its open pull request and the state of its
 * required checks. With `verbose`, each line is followed by its pull request's check rows. Where the
 * required checks are unknown, a line above says why.
 */
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

/**
 * The checks of each change's open pull request in the revision's stack, top first, as
 * `checksLines` prints them.
 */
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
    "Prints one line per change of the stack, top first: its bookmark, its open pull request or `no open pull request`, and the state of the required checks, the one furthest from passing: `failed`, `unknown`, `pending`, `skipped` or `passed`. Unless they passed, the line names the required checks in that state, such as `failed: CI`, or `unknown: codecov` for a required check whose result can't be told apart, as below. Where the default branch requires no checks, the line says `no required checks`, and where the required checks can't be known, it says `unknown`, under a line that says why. A change with conflicts is marked `conflicted` at the end of its line.",
    "With `--verbose`, each line is followed by one row per check, the required ones first: whether it's required, its name, and GitHub's word for its result, such as `success`, `cancelled` or `in_progress`. A required check with no result yet is `expected`.",
    "The checks are those of the pull request's head commit, as GitHub has it. Where that differs from the change, the line names that commit. Each check counts once, with its latest result: the newest check run of each name and app, and the latest commit status of each name. So a run cancelled and then run again counts as the second run, and jobs of the same name in two workflows count as one check, as GitHub matches a required check by name. A check passes where it ends as `success` or `neutral`. One that ends as `skipped` is `skipped`, even where it skips on purpose, such as by a path filter, though GitHub counts it as passed. A required check that names a GitHub App counts only that app's check runs. GitHub doesn't say which app sent a commit status, so a status of its name is `maybe required`, and makes the check `unknown` where counting the status changes its state. A required check with results from several sources counts as the one furthest from passing.",
    "The required checks are the ones GitHub's default branch requires, through its rulesets and its branch protection. A pull request in a stack targets the branch of the change below it, which usually requires none, but `jj gh merge` merges the stack into the default branch, so that branch's rules decide the merge. Where the token can't read them, or the rulesets also require workflows, code scanning results or deployments, the required checks are unknown, and each row of `--verbose` says `maybe required`.",
    "Fails if the changes aren't a chain, or if one doesn't have exactly one bookmark. Changes nothing, locally or on GitHub.",
  ),
);
