import { Array as EffectArray, Match, Option, Order } from "effect";

import type { Check, CheckState, RequiredCheck, RequiredChecks } from "../../clients/github/types";
import { table } from "../command";

/**
 * A required check's state: a `CheckState`, or `unknown` where only a commit status could be its
 * result and GitHub doesn't say whether the required app sent it.
 */
type RequirementState = CheckState | "unknown";

// The states, furthest from passing first.
const FURTHEST_FIRST: readonly RequirementState[] = [
  "failed",
  "unknown",
  "pending",
  "skipped",
  "passed",
];

/**
 * How a check relates to a required check: its `result`; `maybe` its result, for a commit status
 * of that name where the requirement names an app; or `unrelated`.
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

const furthestOf = (checks: readonly Check[]): RequirementState =>
  Option.getOrElse(
    EffectArray.findFirst(FURTHEST_FIRST, (state) =>
      EffectArray.some(checks, (check) => check.state === state),
    ),
    () => "pending",
  );

// Unknown where a commit status that may be the check's result changes its state.
const stateOf = (required: RequiredCheck, checks: readonly Check[]): RequirementState => {
  const withRelation = (relations: readonly Relation[]) =>
    EffectArray.filter(checks, (check) => relations.includes(relationOf(required)(check)));
  const certain = furthestOf(withRelation(["result"]));
  return certain === furthestOf(withRelation(["result", "maybe"])) ? certain : "unknown";
};

const byName = <A extends { readonly name: string }>(items: readonly A[]): readonly A[] =>
  EffectArray.sort(
    items,
    Order.mapInput(Order.String, ({ name }: A) => name),
  );

const rows = (requirement: string, checks: readonly Check[]): readonly (readonly string[])[] =>
  EffectArray.map(byName(checks), ({ name, outcome }) => [requirement, name, outcome]);

const names = (required: readonly RequiredCheck[]): string =>
  EffectArray.join(EffectArray.dedupe(EffectArray.map(required, ({ name }) => name)), ", ");

/** What `checks` prints of a pull request's checks. */
export interface CheckReport {
  /**
   * One row per check, required ones first, with GitHub's word for its result. A required check
   * without a result is `expected`, as GitHub shows it.
   */
  readonly rows: readonly string[];
  /**
   * The state furthest from passing, naming the required checks in it unless they passed. It's
   * `no required checks` where none are required, and `unknown` where they can't be known.
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
      const relationToAny = (check: Check): Relation => {
        const all = new Set(EffectArray.map(requiredChecks, (req) => relationOf(req)(check)));
        return Option.getOrElse(
          EffectArray.findFirst(CLOSEST_FIRST, (relation) => all.has(relation)),
          () => "unrelated",
        );
      };
      const results = EffectArray.map(byName(requiredChecks), (check) => ({
        check,
        state: stateOf(check, checks),
      }));
      const furthest = EffectArray.findFirst(FURTHEST_FIRST, (state) =>
        EffectArray.some(results, (result) => result.state === state),
      );
      const expected = EffectArray.dedupe(
        EffectArray.map(
          EffectArray.filter(requiredChecks, (req) =>
            EffectArray.every(checks, (check) => relationOf(req)(check) === "unrelated"),
          ),
          ({ name }) => name,
        ),
      );
      const related = (relation: Relation) =>
        EffectArray.filter(checks, (check) => relationToAny(check) === relation);
      return {
        rows: table(
          [
            ...EffectArray.map(
              byName([
                ...related("result"),
                ...EffectArray.map(expected, (name) => ({ name, outcome: "expected" })),
              ]),
              ({ name, outcome }) => ["required", name, outcome],
            ),
            ...rows("maybe required", related("maybe")),
            ...rows("not required", related("unrelated")),
          ],
          2,
        ),
        state: Option.match(furthest, {
          onNone: () => "no required checks",
          onSome: (state) =>
            Match.value(state).pipe(
              Match.when("passed", () => "passed"),
              Match.whenOr(
                "failed",
                "pending",
                "skipped",
                "unknown",
                (notPassed) =>
                  `${notPassed}: ${names(
                    EffectArray.map(
                      EffectArray.filter(results, (result) => result.state === notPassed),
                      ({ check }) => check,
                    ),
                  )}`,
              ),
              Match.exhaustive,
            ),
        }),
      };
    }),
    Match.exhaustive,
  );
