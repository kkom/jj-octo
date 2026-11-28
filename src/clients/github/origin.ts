import {
  Array as EffectArray,
  Effect,
  type FileSystem,
  type Layer,
  Option,
  String as EffectString,
} from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import type { Git } from "../git";
import { Jj, type JjFailed } from "../jj";
import { type GitHub, GitHubLive } from "./client";
import { connection } from "./connection";
import { GitHubFailed } from "./failure";
import { repositoryFromUrl } from "./repository";

// The client of the GitHub repository behind the `origin` remote, which jj reads whether or not
// the workspace is a git checkout.
export const gitHubLayerFromOrigin: Effect.Effect<
  Layer.Layer<GitHub, never, HttpClient.HttpClient>,
  GitHubFailed | JjFailed,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const jj = yield* Jj;
  const remotes = yield* jj.read(["git", "remote", "list"]);
  const origin = EffectArray.findFirst(EffectString.split(remotes, "\n"), (line) =>
    EffectString.startsWith("origin ")(line),
  );
  const repository = Option.flatMap(origin, (line) =>
    repositoryFromUrl(EffectString.slice("origin ".length)(line)),
  );
  if (Option.isNone(repository)) {
    return yield* GitHubFailed.make({ message: "the `origin` remote isn't a GitHub repository" });
  }
  const settings = yield* connection;
  return GitHubLive(repository.value, settings);
});
