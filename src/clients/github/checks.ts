import { Array as EffectArray, Effect, Equal, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import type { GitHubFailed } from "./failure";
import { everyPage } from "./pages";
import type { Requests } from "./requests";
import {
  BranchProtection,
  BranchRules,
  CheckRuns,
  CombinedStatus,
  StatusCheckRule,
} from "./responses";
import type { Check, CheckState, RequiredCheck, RequiredChecks } from "./types";

/** The client's reads of a commit's checks and of a branch's required checks. */
export interface CheckReads {
  /**
   * The latest result of each check of the commit: the newest check run of each name and app, and
   * each commit status, of which GitHub lists only the latest of each name.
   */
  readonly latestChecks: (commit: string) => Effect.Effect<readonly Check[], GitHubFailed>;
  /**
   * The checks the branch requires, through the rulesets that apply to it and through its branch
   * protection, or why they can't be known.
   */
  readonly requiredChecks: (branch: string) => Effect.Effect<RequiredChecks, GitHubFailed>;
}

type CheckRun = (typeof CheckRuns.Type)["check_runs"][number];

// The conclusions that satisfy a required check. GitHub counts every other one as a failure.
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["neutral", "skipped", "success"]);

// A commit status's states. GitHub documents the field as any string, so one it adds counts as a
// failure.
const STATUS_STATES: Readonly<Record<string, CheckState>> = {
  error: "failed",
  failure: "failed",
  pending: "pending",
  success: "passed",
};

const checkRunState = ({ conclusion, status }: CheckRun): CheckState => {
  if (status !== "completed") {
    return "pending";
  }
  return PASSING_CONCLUSIONS.has(conclusion ?? "") ? "passed" : "failed";
};

/**
 * The newest check run of each name and app. A commit keeps every run of a check, such as one
 * cancelled and the re-run that followed it, and only the newest one counts. GitHub gives each new
 * run a higher id, whether or not it has started. Jobs of the same name in two workflows are one
 * check, as GitHub matches a required check by name.
 */
const newestRuns = (runs: readonly CheckRun[]): readonly CheckRun[] => {
  const newest = new Map<string, CheckRun>();
  for (const run of runs) {
    const key = JSON.stringify([run.app?.id ?? null, run.name]);
    const kept = newest.get(key);
    if (kept === undefined || BigInt(run.id) > BigInt(kept.id)) {
      newest.set(key, run);
    }
  }
  return [...newest.values()];
};

const latestChecks = (
  { json }: Requests,
  repo: (path: string) => string,
  commit: string,
): Effect.Effect<readonly Check[], GitHubFailed> =>
  Effect.all(
    [
      // `filter=all`, since `latest` filters by when a run completed, and a re-run that hasn't
      // completed is still the newest.
      everyPage(
        HttpClientRequest.get(repo(`/commits/${commit}/check-runs`), {
          urlParams: { filter: "all" },
        }),
        (request) =>
          json(CheckRuns)(request).pipe(Effect.map(({ check_runs: checkRuns }) => checkRuns)),
      ),
      everyPage(HttpClientRequest.get(repo(`/commits/${commit}/status`)), (request) =>
        json(CombinedStatus)(request).pipe(Effect.map(({ statuses }) => statuses)),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([runs, statuses]) => [
      ...newestRuns(runs).map((run): Check => ({
        app: Option.fromNullishOr(run.app?.id),
        name: run.name,
        outcome: run.conclusion ?? run.status,
        state: checkRunState(run),
      })),
      ...statuses.map(({ context, state }): Check => ({
        app: Option.none(),
        name: context,
        outcome: state,
        state: STATUS_STATES[state] ?? "failed",
      })),
    ]),
  );

// Rules that require results this command can't match to checks by name: the runs of required
// workflows, code scanning results and deployments.
const UNREAD_RULES: ReadonlySet<string> = new Set([
  "code_scanning",
  "required_deployments",
  "workflows",
]);

const requiredChecks = (
  { json }: Requests,
  repo: (path: string) => string,
  branch: string,
): Effect.Effect<RequiredChecks, GitHubFailed> => {
  const encoded = encodeURIComponent(branch);
  // One after the other, so where both fail, the first failure is the one reported.
  return Effect.all([
    everyPage(HttpClientRequest.get(repo(`/rules/branches/${encoded}`)), json(BranchRules)),
    json(BranchProtection)(HttpClientRequest.get(repo(`/branches/${encoded}`))),
  ]).pipe(
    Effect.map(([rules, branchDetails]): RequiredChecks => {
      const unread = EffectArray.dedupe(
        rules.map(({ type }) => type).filter((type) => UNREAD_RULES.has(type)),
      );
      if (unread.length > 0) {
        return {
          _tag: "Unknown",
          reason: `${branch}'s rulesets also require ${unread.join(" and ")}, which aren't read as checks`,
        };
      }
      const statusRules = rules.filter(Schema.is(StatusCheckRule));
      // GitHub documents a rule's `parameters` as optional, so one without them is unknown.
      if (statusRules.some(({ parameters }) => parameters === undefined)) {
        return {
          _tag: "Unknown",
          reason: `GitHub listed a rule requiring status checks on ${branch} without naming them`,
        };
      }
      // GitHub documents `protection` as always there, so a protected branch without it is unknown.
      if (branchDetails.protected && branchDetails.protection === undefined) {
        return {
          _tag: "Unknown",
          reason: `GitHub listed ${branch} as protected without saying how`,
        };
      }
      const fromRules = statusRules
        .flatMap(({ parameters }) => parameters?.required_status_checks ?? [])
        .map(({ context, integration_id }): RequiredCheck => ({
          app: Option.fromUndefinedOr(integration_id),
          name: context,
        }));
      const statusChecks = branchDetails.protection?.required_status_checks;
      // A check with a `null` app is one any source can send.
      const fromProtection =
        statusChecks === undefined || statusChecks.enforcement_level === "off"
          ? []
          : statusChecks.checks.map(({ app_id, context }): RequiredCheck => ({
              app: Option.fromNullOr(app_id),
              name: context,
            }));
      return {
        _tag: "Known",
        checks: EffectArray.dedupeWith([...fromRules, ...fromProtection], Equal.equals),
      };
    }),
    // GitHub answers 403 or 404 where the token can't read the branch's rules or summary.
    Effect.catchIf(
      ({ status }) => status === 403 || status === 404,
      ({ message }) =>
        Effect.succeed<RequiredChecks>({
          _tag: "Unknown",
          reason: `couldn't read the rules of ${branch}: ${message}`,
        }),
    ),
  );
};

export const checkReads = (requests: Requests, repo: (path: string) => string): CheckReads => ({
  latestChecks: (commit) => latestChecks(requests, repo, commit),
  requiredChecks: (branch) => requiredChecks(requests, repo, branch),
});
