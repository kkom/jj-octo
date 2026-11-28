import { afterAll, describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted } from "effect";

import { GITHUB_AUTH } from "../../settings";
import { environment } from "../../testing/environment";
import { gitClone } from "../../testing/git-clone";
import { itEffect } from "../../testing/it-effect";
import {
  removeScratchRepositories,
  scratchDirectory,
  scratchRepository,
} from "../../testing/scratch-repository";
import { connection } from "./connection";

afterAll(removeScratchRepositories);

/** A colocated jj repository, with the git and jj clients and an environment holding `env`. */
const checkout = (env: Readonly<Record<string, string>> = {}) => {
  const clone = gitClone(scratchRepository());
  clone.jj("git", "init", "--colocate");
  const layer = Layer.mergeAll(clone.layer, BunServices.layer, environment(env));
  const resolved = connection.pipe(
    Effect.map(({ proxy, token }) => ({
      proxy: Option.getOrUndefined(
        Option.map(proxy, ({ ca, url }) => ({ ca: Option.getOrUndefined(ca), url })),
      ),
      token: Redacted.value(token),
    })),
    Effect.provide(layer),
  );
  const failure = Effect.flip(connection.pipe(Effect.provide(layer))).pipe(
    Effect.map(({ message }) => message),
  );
  return { ...clone, failure, resolved };
};

describe("connection", () => {
  itEffect("sends the token from the environment by default", () =>
    Effect.gen(function* () {
      const { resolved } = checkout({ GH_TOKEN: "own-token" });
      const found = yield* resolved;
      expect(found).toStrictEqual({ proxy: undefined, token: "own-token" });
    }),
  );

  itEffect("sends a placeholder through git's proxy for github.com, trusting git's CA bundle", () =>
    Effect.gen(function* () {
      const { git, jj, resolved } = checkout();
      const ca = path.join(scratchDirectory("ca-"), "ca.pem");
      writeFileSync(ca, "certificate\n");
      git("config", "http.https://github.com/.proxy", "http://127.0.0.1:1234");
      git("config", "http.https://github.com/.sslCAInfo", ca);
      jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const found = yield* resolved;
      expect(found).toStrictEqual({
        proxy: { ca: "certificate\n", url: "http://127.0.0.1:1234" },
        token: "proxy-injected",
      });
    }),
  );

  itEffect("uses the system's certificate authorities where git names no CA bundle", () =>
    Effect.gen(function* () {
      const { git, jj, resolved } = checkout();
      git("config", "http.proxy", "http://127.0.0.1:1234");
      jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const found = yield* resolved;
      expect(found).toStrictEqual({
        proxy: { ca: undefined, url: "http://127.0.0.1:1234" },
        token: "proxy-injected",
      });
    }),
  );

  itEffect("reads a proxy without a scheme as an HTTP one, as git does", () =>
    Effect.gen(function* () {
      const { git, jj, resolved } = checkout();
      git("config", "http.proxy", "127.0.0.1:1234");
      jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const found = yield* resolved;
      expect(found).toStrictEqual({
        proxy: { ca: undefined, url: "http://127.0.0.1:1234" },
        token: "proxy-injected",
      });
    }),
  );

  itEffect("fails for git-proxy where git has no proxy for github.com", () =>
    Effect.gen(function* () {
      const { failure, git, jj } = checkout({ GH_TOKEN: "own-token" });
      git("config", "http.https://example.com/.proxy", "http://127.0.0.1:1234");
      jj("config", "set", "--repo", GITHUB_AUTH.key, "git-proxy");
      const message = yield* failure;
      expect(message).toBe(
        "jj-octo.github-auth is git-proxy, but git has no http.proxy for https://github.com",
      );
    }),
  );

  itEffect("fails for a value it doesn't know", () =>
    Effect.gen(function* () {
      const { failure, jj } = checkout({ GH_TOKEN: "own-token" });
      jj("config", "set", "--repo", GITHUB_AUTH.key, "proxy");
      const message = yield* failure;
      expect(message).toBe('jj-octo.github-auth is "proxy"; set it to token or git-proxy');
    }),
  );
});
