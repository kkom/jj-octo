import { Array as EffectArray, Effect, Layer, Option, String as EffectString } from "effect";

import { Jj } from "../jj";
import { GitHubLive } from "./client";
import { connection } from "./connection";
import { GitHubFailed } from "./failure";
import { repositoryFromUrl } from "./repository";

// The GitHub repository behind the `origin` remote, which jj reads whether or not the
// workspace is a git checkout.
export const GitHubFromOrigin = Layer.unwrap(
  Effect.gen(function* () {
    const jj = yield* Jj;
    const remotes = yield* jj.read(["git", "remote", "list"]);
    const origin = EffectArray.findFirst(EffectString.split(remotes, "\n"), (line) =>
      EffectString.startsWith("origin ")(line),
    );
    const repository = Option.flatMap(origin, (line) =>
      repositoryFromUrl(EffectString.slice("origin ".length)(line)),
    );
    if (Option.isNone(repository)) {
      return yield* new GitHubFailed({ message: "the `origin` remote isn't a GitHub repository" });
    }
    const settings = yield* connection;
    return GitHubLive(repository.value, settings);
  }),
);
