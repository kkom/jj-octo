import { Effect } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { lines } from "./changes";

/** Where a bookmark points: locally, and on `origin` as of the last fetch or push. */
export interface BookmarkTarget {
  readonly local: string | undefined;
  readonly origin: string | undefined;
  /** Whether the bookmark tracks its branch on `origin`, which a push needs. */
  readonly tracked: boolean;
}

/** Every bookmark's targets, read in one command. A conflicted bookmark has no local target. */
export const bookmarkTargets: Effect.Effect<
  ReadonlyMap<string, BookmarkTarget>,
  JjFailed,
  Jj
> = Effect.gen(function* () {
  const jj = yield* Jj;
  const template = String.raw`name ++ "\t" ++ remote ++ "\t" ++ tracked ++ "\t" ++ if(normal_target, normal_target.commit_id()) ++ "\n"`;
  const targets = new Map<string, BookmarkTarget>();
  for (const line of lines(yield* jj.read(["bookmark", "list", "--all-remotes", "-T", template]))) {
    const [name = "", remote, tracked, commit] = line.split("\t");
    const known = targets.get(name) ?? { local: undefined, origin: undefined, tracked: false };
    const target = commit === "" ? undefined : commit;
    if (remote === "") {
      targets.set(name, { ...known, local: target });
    } else if (remote === "origin") {
      targets.set(name, { ...known, origin: target, tracked: tracked === "true" });
    }
  }
  return targets;
});
