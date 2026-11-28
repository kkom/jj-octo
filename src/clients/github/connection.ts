import {
  Config,
  Effect,
  FileSystem,
  Match,
  Option,
  Redacted,
  String as EffectString,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { GH_TOKEN, GITHUB_TOKEN, GITHUB_AUTH, readSetting } from "../../settings";
import { type Git, gitConfig } from "../git";
import type { Jj } from "../jj";
import { GitHubFailed } from "./failure";

export interface Proxy {
  /** PEM certificates trusted in place of the runtime's own, if any. */
  readonly ca: Option.Option<string>;
  readonly url: string;
}

export interface Connection {
  readonly proxy: Option.Option<Proxy>;
  readonly token: Redacted.Redacted;
}

const ownToken = Effect.gen(function* () {
  const fromEnvironment = yield* Config.option(
    Config.Redacted(GH_TOKEN.name).pipe(Config.orElse(() => Config.Redacted(GITHUB_TOKEN.name))),
  );
  if (Option.isSome(fromEnvironment)) {
    return fromEnvironment.value;
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Logged out, `gh` prints nothing and exits 1, and the exit code isn't reported.
  const stored = yield* spawner
    .string(ChildProcess.make("gh", ["auth", "token"]))
    .pipe(Effect.map(EffectString.trim));
  return stored === "" ? yield* Effect.fail("no token") : Redacted.make(stored);
}).pipe(
  Effect.mapError(() =>
    GitHubFailed.make({ message: "no GitHub token: set GH_TOKEN, or run `gh auth login`" }),
  ),
);

const gitSetting = (name: string) =>
  Effect.gen(function* () {
    const value = yield* gitConfig(["--get-urlmatch", name, "https://github.com"]).pipe(
      Effect.mapError(({ message }) => GitHubFailed.make({ message })),
    );
    return value === "" ? Option.none<string>() : Option.some(value);
  });

// `GITHUB_AUTH` documents what this does.
const gitProxy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const url = yield* gitSetting("http.proxy");
  if (Option.isNone(url)) {
    return yield* GitHubFailed.make({
      message: `${GITHUB_AUTH.key} is git-proxy, but git has no http.proxy for https://github.com`,
    });
  }
  const caFile = yield* gitSetting("http.sslCAInfo");
  const ca = Option.isNone(caFile)
    ? Option.none<string>()
    : yield* fs.readFileString(caFile.value).pipe(
        Effect.mapError((error) =>
          GitHubFailed.make({
            message: `can't read git's http.sslCAInfo ${caFile.value}: ${error.message}`,
          }),
        ),
        Effect.asSome,
      );
  // Git reads a proxy without a scheme as HTTP.
  const withScheme = /^[a-z][\d+.a-z-]*:\/\//iu.test(url.value) ? url.value : `http://${url.value}`;
  const connection: Connection = {
    proxy: Option.some({ ca, url: withScheme }),
    token: Redacted.make("proxy-injected"),
  };
  return connection;
});

export const connection: Effect.Effect<
  Connection,
  GitHubFailed,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const auth = yield* readSetting(GITHUB_AUTH).pipe(
    Effect.mapError(({ message }) => GitHubFailed.make({ message })),
  );
  return yield* Match.value(auth).pipe(
    Match.when("token", () =>
      Effect.map(ownToken, (token): Connection => ({ proxy: Option.none(), token })),
    ),
    Match.when("git-proxy", () => gitProxy),
    Match.exhaustive,
  );
});
