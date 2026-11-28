import { expect } from "bun:test";

import { Effect, FileSystem, Option, Path, Redacted } from "effect";

import { GITHUB_AUTH } from "../../settings";
import { withEnvironment } from "../../testing/environment";
import { GitClone, gitClone } from "../../testing/git-clone";
import { layer } from "../../testing/it-effect";
import { scratchDirectory } from "../../testing/scratch-process";
import { connection } from "./connection";
import { GitHubFailed } from "./failure";

/**
 * Makes the clone a colocated jj repository. Returns it with the connection it resolves and the
 * failure it fails with, each in an environment holding `env`.
 */
const checkout = (env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const clone = yield* GitClone;
    yield* clone.jj("git", "init", "--colocate");
    const resolved = connection.pipe(
      Effect.map(({ proxy, token }) => ({
        proxy: Option.getOrUndefined(
          Option.map(proxy, ({ ca, url }) => ({ ca: Option.getOrUndefined(ca), url })),
        ),
        token: Redacted.value(token),
      })),
      withEnvironment(env),
    );
    const failure = Effect.flip(connection.pipe(withEnvironment(env)));
    return { failure, git: clone.git, jj: clone.jj, resolved };
  });

layer(gitClone())("connection", (it) => {
  it("sends the token from the environment by default", () =>
    Effect.gen(function* () {
      const { resolved } = yield* checkout({ GH_TOKEN: "own-token" });
      const found = yield* resolved;
      expect(found).toStrictEqual({ proxy: undefined, token: "own-token" });
    }));

  it("sends a placeholder through git's proxy for github.com, trusting git's CA bundle", () =>
    Effect.gen(function* () {
      const { git, jj, resolved } = yield* checkout();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* scratchDirectory("ca-");
      const ca = path.join(directory, "ca.pem");
      yield* Effect.orDie(fs.writeFileString(ca, "certificate\n"));
      yield* git("config", "http.https://github.com/.proxy", "http://127.0.0.1:1234");
      yield* git("config", "http.https://github.com/.sslCAInfo", ca);
      yield* jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const found = yield* resolved;
      expect(found).toStrictEqual({
        proxy: { ca: "certificate\n", url: "http://127.0.0.1:1234" },
        token: "proxy-injected",
      });
    }));

  it("uses the system's certificate authorities where git names no CA bundle", () =>
    Effect.gen(function* () {
      const { git, jj, resolved } = yield* checkout();
      yield* git("config", "http.proxy", "http://127.0.0.1:1234");
      yield* jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const found = yield* resolved;
      expect(found).toStrictEqual({
        proxy: { ca: undefined, url: "http://127.0.0.1:1234" },
        token: "proxy-injected",
      });
    }));

  it("reads a proxy without a scheme as an HTTP one, as git does", () =>
    Effect.gen(function* () {
      const { git, jj, resolved } = yield* checkout();
      yield* git("config", "http.proxy", "127.0.0.1:1234");
      yield* jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const found = yield* resolved;
      expect(found).toStrictEqual({
        proxy: { ca: undefined, url: "http://127.0.0.1:1234" },
        token: "proxy-injected",
      });
    }));

  it("fails for git-proxy where git has no proxy for github.com", () =>
    Effect.gen(function* () {
      const { failure, git, jj } = yield* checkout({ GH_TOKEN: "own-token" });
      yield* git("config", "http.https://example.com/.proxy", "http://127.0.0.1:1234");
      yield* jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const failed = yield* failure;
      expect(failed).toStrictEqual(
        GitHubFailed.make({
          message:
            "jj-octo.github-auth is git-proxy, but git has no http.proxy for https://github.com",
        }),
      );
    }));

  it("fails for a value it doesn't know", () =>
    Effect.gen(function* () {
      const { failure, jj } = yield* checkout({ GH_TOKEN: "own-token" });
      yield* jj("config", "set", "--repo", GITHUB_AUTH.key, "proxy");
      const failed = yield* failure;
      expect(failed).toStrictEqual(
        GitHubFailed.make({
          message: 'jj-octo.github-auth is "proxy"; set it to token or git-proxy',
        }),
      );
    }));
});
