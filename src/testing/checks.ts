import { Option } from "effect";

import type { Check, RequiredChecks } from "../clients/github/types";

/** The id of the GitHub Actions app. */
export const ACTIONS = 15_368;

/** A check run's result from GitHub Actions. */
export const run = (name: string, outcome: string, state: Check["state"]): Check => ({
  app: Option.some(ACTIONS),
  name,
  outcome,
  state,
});

/** A commit status's result, which names no app. */
export const status = (name: string, outcome: string, state: Check["state"]): Check => ({
  app: Option.none(),
  name,
  outcome,
  state,
});

/** Required checks of the names, each from any app. */
export const requiring = (...names: readonly string[]): RequiredChecks => ({
  _tag: "Known",
  checks: names.map((name) => ({ app: Option.none(), name })),
});
