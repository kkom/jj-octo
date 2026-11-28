import { describe, expect } from "bun:test";

import { Array as EffectArray, Effect, Option, Order } from "effect";

import { failureOf, withGitHub } from "../../testing/github-client";
import { type InterceptedRequest, Reply } from "../../testing/intercepting-proxy";
import { itEffect } from "../../testing/it-effect";

const ACTIONS = 15_368;

const rulesPath = "/repos/owner/name/rules/branches/main?per_page=100&page=1";
const branchPath = "/repos/owner/name/branches/main";

// A GitHub whose `main` has the rules and the branch protection given, as a protected branch.
const protectedBy =
  (
    rules: readonly unknown[],
    protection?: { readonly enabled: boolean; readonly [field: string]: unknown },
  ) =>
  ({ path }: InterceptedRequest): unknown => {
    if (path === rulesPath) {
      return rules;
    }
    if (path === branchPath) {
      // A branch that only rulesets protect is protected too.
      return {
        name: "main",
        protected: rules.length > 0 || protection?.enabled !== false,
        protection,
      };
    }
    return new Reply(404, { message: "Not Found" });
  };

// In the order `toSorted` puts them.
const requests = [`GET api.github.com${branchPath}`, `GET api.github.com${rulesPath}`];

const statusChecksRule = (checks: readonly unknown[]) => ({
  parameters: { required_status_checks: checks, strict_required_status_checks_policy: false },
  ruleset_id: 1,
  ruleset_source: "owner/name",
  ruleset_source_type: "Repository",
  type: "required_status_checks",
});

const unprotected = {
  enabled: false,
  required_status_checks: { checks: [], contexts: [], enforcement_level: "off" },
};

describe("requiredChecks", () => {
  itEffect("reads the checks that rulesets and branch protection require, each once", () =>
    Effect.gen(function* () {
      const { requests: received, result } = yield* withGitHub(
        protectedBy(
          [
            { ruleset_id: 1, ruleset_source: "owner/name", type: "deletion" },
            statusChecksRule([{ context: "CI", integration_id: ACTIONS }, { context: "Lint" }]),
          ],
          {
            enabled: true,
            required_status_checks: {
              checks: [
                { app_id: ACTIONS, context: "CI" },
                { app_id: null, context: "Docs" },
                { app_id: null, context: "Lint" },
              ],
              contexts: ["CI", "Docs", "Lint"],
              enforcement_level: "everyone",
            },
          },
        ),
        (github) => github.requiredChecks("main"),
      );
      expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
        requests,
        result: {
          _tag: "Known",
          checks: [
            { app: Option.some(ACTIONS), name: "CI" },
            { app: Option.none(), name: "Lint" },
            { app: Option.none(), name: "Docs" },
          ],
        },
      });
    }),
  );

  itEffect("reads no checks from branch protection that isn't enforced", () =>
    Effect.gen(function* () {
      const { requests: received, result } = yield* withGitHub(
        protectedBy([], unprotected),
        (github) => github.requiredChecks("main"),
      );
      expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
        requests,
        result: { _tag: "Known", checks: [] },
      });
    }),
  );

  itEffect("reads the checks as unknown where GitHub doesn't let the token read the rules", () =>
    Effect.gen(function* () {
      const { requests: received, result } = yield* withGitHub(
        (request) =>
          request.path === rulesPath
            ? new Reply(403, { message: "Resource not accessible by integration" })
            : protectedBy([], unprotected)(request),
        (github) => github.requiredChecks("main"),
      );
      expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
        requests: [`GET api.github.com${rulesPath}`],
        result: {
          _tag: "Unknown",
          reason: `couldn't read the rules of main: GET ${rulesPath} returned 403: {"message":"Resource not accessible by integration"}`,
        },
      });
    }),
  );

  itEffect("reads the checks as unknown where GitHub doesn't find the branch for the token", () =>
    Effect.gen(function* () {
      const { requests: received, result } = yield* withGitHub(
        (request) =>
          request.path === branchPath
            ? new Reply(404, { message: "Branch not found" })
            : protectedBy([], unprotected)(request),
        (github) => github.requiredChecks("main"),
      );
      expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
        requests,
        result: {
          _tag: "Unknown",
          reason: `couldn't read the rules of main: GET ${branchPath} returned 404: {"message":"Branch not found"}`,
        },
      });
    }),
  );

  itEffect("reads the checks as unknown where a protected branch's summary has no protection", () =>
    Effect.gen(function* () {
      const { requests: received, result } = yield* withGitHub(protectedBy([]), (github) =>
        github.requiredChecks("main"),
      );
      expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
        requests,
        result: { _tag: "Unknown", reason: "GitHub listed main as protected without saying how" },
      });
    }),
  );

  itEffect("reads the checks as unknown where a ruleset requires workflows or code scanning", () =>
    Effect.gen(function* () {
      const { requests: received, result } = yield* withGitHub(
        protectedBy(
          [
            statusChecksRule([{ context: "CI" }]),
            { parameters: { workflows: [] }, type: "workflows" },
            { parameters: { code_scanning_tools: [] }, type: "code_scanning" },
          ],
          unprotected,
        ),
        (github) => github.requiredChecks("main"),
      );
      expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
        requests,
        result: {
          _tag: "Unknown",
          reason:
            "main's rulesets also require workflows and code_scanning, which aren't read as checks",
        },
      });
    }),
  );

  itEffect(
    "reads the checks as unknown where a rule requiring status checks doesn't name them",
    () =>
      Effect.gen(function* () {
        const { requests: received, result } = yield* withGitHub(
          protectedBy([{ type: "required_status_checks" }], unprotected),
          (github) => github.requiredChecks("main"),
        );
        expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
          requests,
          result: {
            _tag: "Unknown",
            reason: "GitHub listed a rule requiring status checks on main without naming them",
          },
        });
      }),
  );

  itEffect("fails on a rule requiring status checks that it can't read", () =>
    Effect.gen(function* () {
      const { requests: received, result } = yield* withGitHub(
        protectedBy(
          [{ parameters: { unexpected: true }, type: "required_status_checks" }],
          unprotected,
        ),
        (github) => failureOf(github.requiredChecks("main")),
      );
      expect({ requests: EffectArray.sort(received, Order.String), result }).toStrictEqual({
        requests: [`GET api.github.com${rulesPath}`],
        result: {
          message: EffectArray.join(
            [
              `unexpected response to ${rulesPath}: Missing key`,
              '  at [0]["parameters"]["required_status_checks"]',
              "a type other than required_status_checks",
              '  at [0]["type"]',
            ],
            "\n",
          ),
          status: undefined,
        },
      });
    }),
  );
});
