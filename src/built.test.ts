import { describe, expect } from "bun:test";

import { Array as EffectArray, Effect, FileSystem, Path, String as EffectString } from "effect";

import manifest from "../package.json" with { type: "json" };
import { SET_UP_VERSION } from "./cli/gh/setup";
import { formatJson } from "./json";
import { ENVIRONMENT_VARIABLES, SETTINGS } from "./settings";
import { builds, output, run } from "./testing/built-cli";
import { searchPath } from "./testing/github-client";
import {
  type InterceptedRequest,
  type InterceptingProxy,
  throughProxy,
} from "./testing/intercepting-proxy";
import { itEffect } from "./testing/it-effect";
import { isolatedEnv } from "./testing/scratch-process";
import { scratchRepository } from "./testing/scratch-repository";

// GitHub's answer to a request for the open pull requests from branch `a`.
const pullRequestOfA = ({ path: requestPath }: InterceptedRequest) =>
  requestPath === "/repos/owner/name/pulls?head=owner%3Aa&state=open"
    ? [{ base: { ref: "main" }, body: "", draft: true, number: 7, title: "a" }]
    : [];

// What the proxy receives and `log` prints when `log` reads that pull request.
const logOfA = {
  log: [
    "CONNECT api.github.com:443",
    "GET api.github.com/repos/owner/name/pulls?head=owner%3Aa&state=open",
  ],
  result: "a  #7 draft  not pushed\n",
};

// The search for whether #7 is open and approved.
const searchOfA = searchPath("7 created:2026-01-01T00:00:00Z..2026-01-01T00:00:00Z");

// GitHub's answers to a request for every pull request from branch `a`, which lists #7 ready for
// review, and to the search, which lists #7 as approved.
const answersOfA: Readonly<Record<string, unknown>> = {
  "/repos/owner/name/pulls?head=owner%3Aa&state=all&per_page=100&page=1": [
    {
      created_at: "2026-01-01T00:00:00Z",
      draft: false,
      head: { sha: "0000000" },
      html_url: "https://github.com/owner/name/pull/7",
      merged_at: null,
      number: 7,
      state: "open",
      title: "Add a",
    },
  ],
  [searchOfA]: { incomplete_results: false, items: [{ number: 7 }], total_count: 1 },
};
const listOfA = ({ path: requestPath }: InterceptedRequest) => answersOfA[requestPath] ?? [];

// The environment that sends jj-octo's requests through the proxy, with a token it can pass on.
const proxyEnv = ({ caFile, url }: InterceptingProxy) => ({
  GH_TOKEN: "test-token",
  HTTPS_PROXY: url,
  NODE_EXTRA_CA_CERTS: caFile,
});

// A repository with change `a` on `main`, whose `origin` is a GitHub repository, and the
// environment that runs the file in it with its own configuration. It records this version as
// the one that set it up, as `init` does, since `init` can't reach that `origin`.
const checkoutOfA = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repository = yield* scratchRepository;
  yield* repository.stack("a");
  yield* repository.jj("git", "remote", "set-url", "origin", "https://github.com/owner/name");
  yield* repository.jj("config", "set", "--repo", SET_UP_VERSION, formatJson(manifest.version));
  const root = yield* repository.jj("root");
  const cwd = EffectString.trim(root);
  return { cwd, env: isolatedEnv(path.dirname(cwd)), repository };
});

describe.each(builds)("$name", ({ command }) => {
  itEffect("prints its version", () =>
    Effect.gen(function* () {
      const printed = yield* run(command, ["--version"], { cwd: process.cwd(), env: {} });
      expect(printed).toBe(`jj gh v${manifest.version}\n`);
    }),
  );

  itEffect("documents every setting and environment variable in its help", () =>
    Effect.gen(function* () {
      const printed = yield* run(command, ["--help"], { cwd: process.cwd(), env: {} });
      const help = EffectString.split(printed, "\n");
      expect({
        environment: EffectArray.filter(
          EffectArray.map(
            help,
            (line) => /^ {2}(?<name>[A-Z][\d_A-Z]+) {3}/u.exec(line)?.groups?.["name"],
          ),
          (name) => name !== undefined,
        ),
        sections: EffectArray.filter(help, (line) => /^[A-Z]/u.test(line)),
        settings: EffectArray.map(
          EffectArray.filter(help, (line) => EffectString.startsWith("  jj-octo.")(line)),
          (line) => EffectString.trim(line),
        ),
      }).toStrictEqual({
        environment: EffectArray.map(ENVIRONMENT_VARIABLES, ({ name }) => name),
        sections: [
          "DESCRIPTION",
          "USAGE",
          "GLOBAL FLAGS",
          "SUBCOMMANDS",
          "SETTINGS",
          "ENVIRONMENT",
        ],
        settings: EffectArray.map(SETTINGS, ({ key }) => key),
      });
    }),
  );

  itEffect("reads pull requests through git's proxy for github.com", () =>
    Effect.gen(function* () {
      const received = yield* throughProxy("api.github.com", pullRequestOfA, (proxy) =>
        Effect.gen(function* () {
          const { cwd, env, repository } = yield* checkoutOfA;
          const git = (...args: readonly string[]) =>
            repository.jj("util", "exec", "--", "git", "config", ...args);
          yield* git("http.https://github.com/.proxy", proxy.url);
          yield* git("http.https://github.com/.sslCAInfo", proxy.caFile);
          yield* repository.jj("config", "set", "--repo", "jj-octo.github-auth", "git-proxy");
          return yield* run(command, ["log"], { cwd, env });
        }),
      );
      expect(received).toStrictEqual(logOfA);
    }),
  );

  itEffect("links the pull requests GitHub lists for a branch", () =>
    Effect.gen(function* () {
      const received = yield* throughProxy("api.github.com", listOfA, (proxy) =>
        Effect.gen(function* () {
          const { cwd, env } = yield* checkoutOfA;
          return yield* run(command, ["links"], { cwd, env: { ...env, ...proxyEnv(proxy) } });
        }),
      );
      expect(received).toStrictEqual({
        log: [
          "CONNECT api.github.com:443",
          "GET api.github.com/repos/owner/name/pulls?head=owner%3Aa&state=all&per_page=100&page=1",
          `GET api.github.com${searchOfA}`,
        ],
        result: "✅ [#7 Add a](https://github.com/owner/name/pull/7) `+1/-0`\n",
      });
    }),
  );

  itEffect(
    "tells the agent to reply with the links, with --copy in a Claude Code cloud session",
    () =>
      Effect.gen(function* () {
        const received = yield* throughProxy("api.github.com", listOfA, (proxy) =>
          Effect.gen(function* () {
            const { cwd, env } = yield* checkoutOfA;
            return yield* output(command, ["links", "--copy"], {
              cwd,
              env: { ...env, CLAUDE_CODE_REMOTE: "true", ...proxyEnv(proxy) },
            });
          }),
        );
        expect(received.result).toStrictEqual({
          stderr:
            "This Claude Code cloud session can't reach the user's clipboard. Copy the lines between the markers into your reply verbatim: without the markers, a code block or added backticks. They then show as links that paste into Slack.\n",
          stdout: EffectArray.join(
            [
              "-----BEGIN TEXT TO PASTE VERBATIM-----",
              "✅ [#7 Add a](https://github.com/owner/name/pull/7) `+1/-0`",
              "-----END TEXT TO PASTE VERBATIM-----",
              "",
            ],
            "\n",
          ),
        });
      }),
  );

  itEffect("tries to set a checkout up before a command where no version is recorded", () =>
    Effect.gen(function* () {
      const received = yield* throughProxy("api.github.com", pullRequestOfA, (proxy) =>
        Effect.gen(function* () {
          const { cwd, env, repository } = yield* checkoutOfA;
          yield* repository.jj("config", "unset", "--repo", SET_UP_VERSION);
          const { stderr, stdout } = yield* output(command, ["log"], {
            cwd,
            env: { ...env, ...proxyEnv(proxy) },
          });
          // What git prints between them depends on the network, which the test doesn't control.
          const printed = EffectString.split(EffectString.trimEnd(stderr), "\n");
          const recorded = yield* repository.jj("config", "get", SET_UP_VERSION);
          return {
            firstPrinted: printed.at(0),
            lastPrinted: printed.at(-1),
            recorded,
            stdout,
          };
        }),
      );
      // `init` can't reach this `origin` with git, so it says what's left and the command carries on.
      expect(received).toStrictEqual({
        // The first is `init`'s `git ls-remote`, which the proxy doesn't answer for github.com.
        log: ["CONNECT github.com:443", ...logOfA.log],
        result: {
          firstPrinted: `setting this checkout up for jj-octo ${manifest.version}`,
          lastPrinted: "run `jj-octo init` once that's fixed",
          recorded: `${manifest.version}\n`,
          stdout: logOfA.result,
        },
      });
    }),
  );

  itEffect("reads pull requests through the proxy HTTPS_PROXY names", () =>
    Effect.gen(function* () {
      const received = yield* throughProxy("api.github.com", pullRequestOfA, (proxy) =>
        Effect.gen(function* () {
          const { cwd, env } = yield* checkoutOfA;
          return yield* run(command, ["log"], { cwd, env: { ...env, ...proxyEnv(proxy) } });
        }),
      );
      expect(received).toStrictEqual(logOfA);
    }),
  );

  // The checkout is someone else's, so neither its `.env` nor its `bunfig.toml` may change how
  // jj-octo runs. Loaded, this `.env` would send the request past the proxy.
  itEffect("ignores a .env file in the checkout", () =>
    Effect.gen(function* () {
      const received = yield* throughProxy("api.github.com", pullRequestOfA, (proxy) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { cwd, env } = yield* checkoutOfA;
          // Excluded, so jj doesn't record it.
          yield* Effect.orDie(
            fs.writeFileString(path.join(cwd, ".git", "info", "exclude"), ".env\n", { flag: "a" }),
          );
          yield* Effect.orDie(fs.writeFileString(path.join(cwd, ".env"), "NO_PROXY=*\n"));
          return yield* run(command, ["log"], { cwd, env: { ...env, ...proxyEnv(proxy) } });
        }),
      );
      expect(received).toStrictEqual(logOfA);
    }),
  );

  // Loaded, the checkout's `bunfig.toml` would run its preload inside jj-octo, which fails the run.
  itEffect("ignores a bunfig.toml file in the checkout", () =>
    Effect.gen(function* () {
      const received = yield* throughProxy("api.github.com", pullRequestOfA, (proxy) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { cwd, env } = yield* checkoutOfA;
          // Excluded, so jj doesn't record them.
          yield* Effect.orDie(
            fs.writeFileString(
              path.join(cwd, ".git", "info", "exclude"),
              "bunfig.toml\npreload.ts\n",
              { flag: "a" },
            ),
          );
          yield* Effect.orDie(
            fs.writeFileString(path.join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n'),
          );
          yield* Effect.orDie(
            fs.writeFileString(
              path.join(cwd, "preload.ts"),
              'console.error("ran the checkout\'s bunfig.toml preload");\nprocess.exit(3);\n',
            ),
          );
          return yield* run(command, ["log"], { cwd, env: { ...env, ...proxyEnv(proxy) } });
        }),
      );
      expect(received).toStrictEqual(logOfA);
    }),
  );
});
