import { Array as EffectArray, Effect, Equal, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { formatJson } from "../../json";
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

export interface CheckReads {
  /**
   * The newest check run per name and app, and each commit status, of which GitHub lists only the
   * latest per name.
   */
  readonly latestChecks: (commit: string) => Effect.Effect<readonly Check[], GitHubFailed>;
  /** The checks the branch's rulesets and branch protection require, or why they're unknown. */
  readonly requiredChecks: (branch: string) => Effect.Effect<RequiredChecks, GitHubFailed>;
}

type CheckRun = (typeof CheckRuns.Type)["check_runs"][number];

// The state of each conclusion. GitHub counts every other one as `failed`.
const CONCLUSION_STATES: Readonly<Record<string, CheckState>> = {
  neutral: "passed",
  skipped: "skipped",
  success: "passed",
};

// GitHub documents a commit status's state as any string, so a new one counts as failed.
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
  return CONCLUSION_STATES[conclusion ?? ""] ?? "failed";
};

/**
 * A commit keeps every run of a check, such as a cancelled run and its re-run. GitHub gives each
 * new run a higher id, started or not. Same-named jobs in two workflows are one check, as GitHub
 * matches required checks by name.
 */
const newestRuns = (runs: readonly CheckRun[]): readonly CheckRun[] => {
  const newest = new Map<string, CheckRun>();
  for (const run of runs) {
    const key = formatJson([run.app?.id ?? null, run.name]);
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
      // `filter=all`, as `latest` filters by completion time, and an unfinished re-run is newest.
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
      ...EffectArray.map(newestRuns(runs), (run): Check => ({
        app: Option.fromNullishOr(run.app?.id),
        name: run.name,
        outcome: run.conclusion ?? run.status,
        state: checkRunState(run),
      })),
      ...EffectArray.map(statuses, ({ context, state }): Check => ({
        app: Option.none(),
        name: context,
        outcome: state,
        state: STATUS_STATES[state] ?? "failed",
      })),
    ]),
  );

// Rules requiring results that can't be matched to checks by name.
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
  // In turn, so where both fail, the first failure is reported.
  return Effect.all(
    [
      everyPage(HttpClientRequest.get(repo(`/rules/branches/${encoded}`)), json(BranchRules)),
      json(BranchProtection)(HttpClientRequest.get(repo(`/branches/${encoded}`))),
    ],
    { concurrency: 1 },
  ).pipe(
    Effect.map(([rules, branchDetails]): RequiredChecks => {
      const unread = EffectArray.dedupe(
        EffectArray.filter(
          EffectArray.map(rules, ({ type }) => type),
          (type) => UNREAD_RULES.has(type),
        ),
      );
      if (unread.length > 0) {
        return {
          _tag: "Unknown",
          reason: `${branch}'s rulesets also require ${EffectArray.join(unread, " and ")}, which aren't read as checks`,
        };
      }
      const statusRules = EffectArray.filter(rules, Schema.is(StatusCheckRule));
      // GitHub documents a rule's `parameters` as optional.
      if (EffectArray.some(statusRules, ({ parameters }) => parameters === undefined)) {
        return {
          _tag: "Unknown",
          reason: `GitHub listed a rule requiring status checks on ${branch} without naming them`,
        };
      }
      // GitHub documents `protection` as always present.
      if (branchDetails.protected && branchDetails.protection === undefined) {
        return {
          _tag: "Unknown",
          reason: `GitHub listed ${branch} as protected without saying how`,
        };
      }
      const fromRules = EffectArray.map(
        EffectArray.flatMap(
          statusRules,
          ({ parameters }) => parameters?.required_status_checks ?? [],
        ),
        ({ context, integration_id }): RequiredCheck => ({
          app: Option.fromUndefinedOr(integration_id),
          name: context,
        }),
      );
      const statusChecks = branchDetails.protection?.required_status_checks;
      // Any source can send a check with a `null` app.
      const fromProtection =
        statusChecks === undefined || statusChecks.enforcement_level === "off"
          ? []
          : EffectArray.map(statusChecks.checks, ({ app_id, context }): RequiredCheck => ({
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
