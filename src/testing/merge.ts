import type { Effect } from "effect";

import { merge, type NotMergeable } from "../cli/gh/merge";
import type { PushFailed } from "../cli/gh/stack/push";
import type { NotCombined } from "../cli/gh/stack/reconcile";
import type { GitHub } from "../clients/github/client";
import type { RepositoryClients } from "./scratch-process";

/** Merges up to the revision, in this workspace alone and without cancelling runs. */
export const merging = (
  revision: string,
): Effect.Effect<void, NotCombined | NotMergeable | PushFailed, GitHub | RepositoryClients> =>
  merge(revision, { allWorkspaces: false, cancelPrRuns: false });
