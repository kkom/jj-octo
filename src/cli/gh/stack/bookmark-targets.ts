import { Effect, String as EffectString } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { lines } from "./changes";

/** Where a bookmark points: locally, and on `origin` as of the last fetch or push. */
export interface BookmarkTarget {
  /** Whether the bookmark was deleted here, as `jj abandon` does, but not yet on `origin`. */
  readonly deleted: boolean;
  readonly local: string | undefined;
  readonly origin: string | undefined;
  readonly originChange: string | undefined;
  /** Whether the bookmark tracks its `origin` branch, which a push needs. */
  readonly tracked: boolean;
}

export type BookmarkTargets = ReadonlyMap<string, BookmarkTarget>;

/** A conflicted bookmark has no local target. */
export const bookmarkTargets: Effect.Effect<BookmarkTargets, JjFailed, Jj> = Effect.gen(
  function* () {
    const jj = yield* Jj;
    const template = String.raw`name ++ "\t" ++ remote ++ "\t" ++ tracked ++ "\t" ++ present ++ "\t" ++ if(normal_target, normal_target.commit_id() ++ "\t" ++ normal_target.change_id()) ++ "\n"`;
    const targets = new Map<string, BookmarkTarget>();
    const listed = yield* jj.read(["bookmark", "list", "--all-remotes", "-T", template]);
    for (const line of lines(listed)) {
      const [name, remote, tracked, present, commit, change] = EffectString.split(line, "\t");
      const known = targets.get(name) ?? {
        deleted: false,
        local: undefined,
        origin: undefined,
        originChange: undefined,
        tracked: false,
      };
      const target = commit === "" ? undefined : commit;
      if (remote === "") {
        targets.set(name, { ...known, deleted: present === "false", local: target });
      } else if (remote === "origin") {
        targets.set(name, {
          ...known,
          origin: target,
          originChange: change,
          tracked: tracked === "true",
        });
      }
    }
    return targets;
  },
);
