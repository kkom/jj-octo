import { Array as EffectArray, Console, Effect, Match, Option, Order } from "effect";
import { Command, Flag } from "effect/cli";

import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import { GitHubFromOrigin } from "../../clients/github/origin";
import {
  type Check,
  type CheckState,
  isOpen,
  type ListedPullRequest,
  type RequiredCheck,
  type RequiredChecks,
} from "../../clients/github/types";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, revisionFlag, table, withHelp } from "../command";
import { CONFLICTED, type NotAStack, stackChanges } from "./stack/changes";

/**
 * Where a required check is: a `CheckState`, or `unknown` where only a commit status could be its
 * result, and GitHub doesn't say whether the app the requirement names sent it.
 */
type RequirementState = CheckState | "unknown";

// The states, the furthest from passing first.
const FURTHEST_FIRST: readonly RequirementState[] = ["failed", "unknown", "pending", "passed"];

/**
 * How a check relates to a required check: its `result`, or `maybe` its result, for a commit status
 * of the name where the requirement names an app, or `unrelated`.
 */
type Relation = "maybe" | "result" | "unrelated";

const CLOSEST_FIRST: readonly Relation[] = ["result", "maybe", "unrelated"];

const relationOf =
  (required: RequiredCheck) =>
  (check: Check): Relation => {
    if (check.name !== required.name) {
      return "unrelated";
    }
    return Option.match(required.app, {
      onNone: () => "result",
      onSome: (wanted) =>
        Option.match(check.app, {
          onNone: () => "maybe",
          onSome: (sent) => (sent === wanted ? "result" : "unrelated"),
        }),
    });
  };

/** The state furthest from passing among the checks, or pending where there are none. */
const furthestOf = (checks: readonly Check[]): RequirementState =>
  FURTHEST_FIRST.find((state) => checks.some((check) => check.state === state)) ?? "pending";

/**
 * The state of a required check, from its results: the one furthest from passing, or pending with
 * none. Where a commit status may also be its result, the state is the same with and without the
 * status, or else unknown.
 */
const stateOf = (required: RequiredCheck, checks: readonly Check[]): RequirementState => {
  const withRelation = (relations: readonly Relation[]) =>
    checks.filter((check) => relations.includes(relationOf(required)(check)));
  const certain = furthestOf(withRelation(["result"]));
  return certain === furthestOf(withRelation(["result", "maybe"])) ? certain : "unknown";
};

const byName = <A extends { readonly name: string }>(items: readonly A[]): readonly A[] =>
  items.toSorted(Order.mapInput(Order.String, ({ name }) => name));

/** One row per check: whether it's required, its name, and GitHub's word for its result. */
const rows = (requirement: string, checks: readonly Check[]): readonly (readonly string[])[] =>
  byName(checks).map(({ name, outcome }) => [requirement, name, outcome]);

const names = (required: readonly RequiredCheck[]): string =>
  EffectArray.dedupe(required.map(({ name }) => name)).join(", ");

/** What `checks` prints of a pull request's checks. */
export interface CheckReport {
  /**
   * One row per check, the required ones first: whether it's required, its name, and GitHub's
   * word for its result. A required check with no result yet is `expected`, as GitHub shows it.
   */
  readonly rows: readonly string[];
  /**
   * The state of the required checks: the one furthest from passing, naming the required checks in
   * it unless they passed, or that the trunk requires none, or that they're unknown.
   */
  readonly state: string;
}

export const checkReport = (required: RequiredChecks, checks: readonly Check[]): CheckReport =>
  Match.value(required).pipe(
    Match.tag("Unknown", () => ({
      rows: table(rows("maybe required", checks), 2),
      state: "unknown",
    })),
    Match.tag("Known", ({ checks: requiredChecks }) => {
      // A check's closest relation to any required check.
      const relationToAny = (check: Check): Relation => {
        const all = new Set(requiredChecks.map((req) => relationOf(req)(check)));
        return CLOSEST_FIRST.find((relation) => all.has(relation)) ?? "unrelated";
      };
      const results = byName(requiredChecks).map((check) => ({
        check,
        state: stateOf(check, checks),
      }));
      const furthest = FURTHEST_FIRST.find((state) =>
        results.some((result) => result.state === state),
      );
      const expected = EffectArray.dedupe(
        requiredChecks
          .filter((req) => checks.every((check) => relationOf(req)(check) === "unrelated"))
          .map(({ name }) => name),
      );
      const related = (relation: Relation) =>
        checks.filter((check) => relationToAny(check) === relation);
      return {
        rows: table(
          [
            ...byName([
              ...related("result"),
              ...expected.map((name) => ({ name, outcome: "expected" })),
            ]).map(({ name, outcome }) => ["required", name, outcome]),
            ...rows("maybe required", related("maybe")),
            ...rows("not required", related("unrelated")),
          ],
          2,
        ),
        state: Match.value(furthest).pipe(
          Match.when(Match.undefined, () => "no required checks"),
          Match.when("passed", () => "passed"),
          Match.whenOr(
            "failed",
            "pending",
            "unknown",
            (state) =>
              `${state}: ${names(results.filter((result) => result.state === state).map(({ check }) => check))}`,
          ),
          Match.exhaustive,
        ),
      };
    }),
    Match.exhaustive,
  );

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
  const reported = checked.toReversed().map(({ bookmark, commitId, conflict, open }) => ({
    bookmark,
    commitId,
    conflict,
    open: Option.map(open, ({ latest, pullRequest }) => ({
      pullRequest,
      report: checkReport(required, latest),
    })),
  }));
  const lines = table(
    reported.map(({ bookmark, commitId, conflict, open }) => [
      ...Option.match(open, {
        onNone: () => [bookmark, "no open pull request"],
        onSome: ({ pullRequest: { head, number }, report }) => [
          bookmark,
          `#${number} ${report.state}`,
          ...(head === commitId ? [] : [`head ${head.slice(0, 12)} differs from the change`]),
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
          onSome: ({ report }) => report.rows.map((row) => `  ${row}`),
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
    asUserError(checks(revision, { verbose }).pipe(Effect.provide(GitHubFromOrigin))).pipe(
      Effect.flatMap((printed) => Console.log(printed.join("\n"))),
    ),
).pipe(
  withHelp(
    "Show the state of the required checks of the stack's pull requests",
    "Prints one line per change of the stack, top first: its bookmark, its open pull request or `no open pull request`, and the state of the required checks, the one furthest from passing: `failed`, `unknown`, `pending` or `passed`. Unless they passed, the line names the required checks in that state, such as `failed: CI`, or `unknown: codecov` for a required check whose result can't be told apart, as below. Where the default branch requires no checks, the line says `no required checks`, and where the required checks can't be known, it says `unknown`, under a line that says why. A change with conflicts is marked `conflicted` at the end of its line.",
    "With `--verbose`, each line is followed by one row per check, the required ones first: whether it's required, its name, and GitHub's word for its result, such as `success`, `cancelled` or `in_progress`. A required check with no result yet is `expected`.",
    "The checks are those of the pull request's head commit, as GitHub has it. Where that differs from the change, the line names that commit. Each check counts once, with its latest result: the newest check run of each name and app, and the latest commit status of each name. So a run cancelled and then run again counts as the second run, and jobs of the same name in two workflows count as one check, as GitHub matches a required check by name. A check passes where it ends as `success`, `neutral` or `skipped`, as GitHub counts a required check. A required check that names a GitHub App counts only that app's check runs. GitHub doesn't say which app sent a commit status, so a status of its name is `maybe required`, and makes the check `unknown` where counting the status changes its state. A required check with results from several sources counts as the one furthest from passing.",
    "The required checks are the ones GitHub's default branch requires, through its rulesets and its branch protection. A pull request in a stack targets the branch of the change below it, which usually requires none, but `jj gh merge` merges the stack into the default branch, so that branch's rules decide the merge. Where the token can't read them, or the rulesets also require workflows, code scanning results or deployments, the required checks are unknown, and each row of `--verbose` says `maybe required`.",
    "Fails if the changes aren't a chain, or if one doesn't have exactly one bookmark. Changes nothing, locally or on GitHub.",
  ),
);
