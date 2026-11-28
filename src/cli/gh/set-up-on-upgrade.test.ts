import { expect } from "bun:test";

import { Effect } from "effect";

import manifest from "../../../package.json" with { type: "json" };
import { formatJson } from "../../json";
import { GitClone, gitClone } from "../../testing/git-clone";
import { layer } from "../../testing/it-effect";
import { problems } from "./doctor";
import { init, setUpOnUpgrade } from "./init";
import { SET_UP_VERSION } from "./setup";

/** The version the clone's repository config records setting it up with, as jj lists it. */
const recorded: Effect.Effect<string, never, GitClone> = GitClone.use((clone) =>
  clone.jj("config", "list", "--repo", SET_UP_VERSION),
);

/** The repository's `jj gh` alias, as jj lists it. */
const alias: Effect.Effect<string, never, GitClone> = GitClone.use((clone) =>
  clone.jj("config", "list", "--repo", "aliases.gh"),
);

const THIS_VERSION = `${SET_UP_VERSION} = "${manifest.version}"\n`;
const ALIAS = 'aliases.gh = ["util","exec","--","jj-octo"]\n';

/** Sets the clone up with init, then records the version given and removes the alias. */
const setUpBy = (version: string) =>
  Effect.gen(function* () {
    const clone = yield* GitClone;
    yield* init;
    yield* clone.jj("config", "set", "--repo", SET_UP_VERSION, formatJson(version));
    yield* clone.jj("config", "unset", "--repo", "aliases.gh");
  });

layer(gitClone())("the version that set the checkout up", (it) => {
  it("is recorded by init", () =>
    Effect.gen(function* () {
      yield* init;
      const version = yield* recorded;
      expect(version).toBe(THIS_VERSION);
    }));

  it("sets up a checkout where no version is recorded", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* clone.jj("git", "init", "--colocate");
      yield* setUpOnUpgrade;
      const found = yield* problems;
      const version = yield* recorded;
      expect([found, version]).toStrictEqual([[], THIS_VERSION]);
    }));

  it("sets up a plain git clone", () =>
    Effect.gen(function* () {
      yield* setUpOnUpgrade;
      const found = yield* problems;
      const version = yield* recorded;
      expect([found, version]).toStrictEqual([[], THIS_VERSION]);
    }));

  it.each([
    { recorded: "0.0.1", setsUp: true, title: "sets it up where an older version is recorded" },
    { recorded: "dev", setsUp: true, title: "sets it up where what's recorded isn't a version" },
    {
      recorded: manifest.version,
      setsUp: false,
      title: "leaves it where this version is recorded",
    },
    { recorded: "99.0.0", setsUp: false, title: "leaves it where a newer version is recorded" },
  ])("$title", ({ recorded: version, setsUp }) =>
    Effect.gen(function* () {
      yield* setUpBy(version);
      yield* setUpOnUpgrade;
      const aliased = yield* alias;
      const recordedVersion = yield* recorded;
      expect([aliased, recordedVersion]).toStrictEqual(
        setsUp ? [ALIAS, THIS_VERSION] : ["", `${SET_UP_VERSION} = ${formatJson(version)}\n`],
      );
    }),
  );

  it("records this version, and leaves what's left to doctor, where init can't set the checkout up", () =>
    Effect.gen(function* () {
      const clone = yield* GitClone;
      yield* clone.git("config", "--unset", "user.email");
      yield* setUpOnUpgrade;
      const found = yield* problems;
      const version = yield* recorded;
      expect([found, version]).toStrictEqual([
        ["neither jj nor git has user.email; set it with `jj config set --user user.email`"],
        THIS_VERSION,
      ]);
    }));
});
