import { afterAll, describe, expect } from "bun:test";

import { Effect } from "effect";

import manifest from "../../../package.json" with { type: "json" };
import { formatJson } from "../../json";
import { gitClone } from "../../testing/git-clone";
import { itEffect, provideSetup } from "../../testing/it-effect";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { problems } from "./doctor";
import { init, setUpOnUpgrade } from "./init";
import { SET_UP_VERSION } from "./setup";

afterAll(removeScratchRepositories);

type Clone = ReturnType<typeof gitClone>;

/** The version the clone's repository config records setting it up with, as jj lists it. */
const recorded = (clone: Clone): string => clone.jj("config", "list", "--repo", SET_UP_VERSION);

/** The repository's `jj gh` alias, as jj lists it. */
const alias = (clone: Clone): string => clone.jj("config", "list", "--repo", "aliases.gh");

const THIS_VERSION = `${SET_UP_VERSION} = "${manifest.version}"\n`;
const ALIAS = 'aliases.gh = ["util","exec","--","jj-octo"]\n';

/** A clone that init set up, with the version given recorded and the alias removed. */
const setUpBy = (version: string) =>
  Effect.gen(function* () {
    const clone = gitClone(scratchRepository());
    yield* init.pipe(provideSetup(clone.layer));
    clone.jj("config", "set", "--repo", SET_UP_VERSION, formatJson(version));
    clone.jj("config", "unset", "--repo", "aliases.gh");
    return clone;
  });

describe("the version that set the checkout up", () => {
  itEffect("is recorded by init", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      yield* init.pipe(provideSetup(clone.layer));
      expect(recorded(clone)).toBe(THIS_VERSION);
    }),
  );

  itEffect("sets up a checkout where no version is recorded", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      clone.jj("git", "init", "--colocate");
      yield* setUpOnUpgrade.pipe(provideSetup(clone.layer));
      expect([yield* problems.pipe(provideSetup(clone.layer)), recorded(clone)]).toStrictEqual([
        [],
        THIS_VERSION,
      ]);
    }),
  );

  itEffect("sets up a plain git clone", () =>
    Effect.gen(function* () {
      const clone = gitClone(scratchRepository());
      yield* setUpOnUpgrade.pipe(provideSetup(clone.layer));
      expect([yield* problems.pipe(provideSetup(clone.layer)), recorded(clone)]).toStrictEqual([
        [],
        THIS_VERSION,
      ]);
    }),
  );

  itEffect.each([
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
      const clone = yield* setUpBy(version);
      yield* setUpOnUpgrade.pipe(provideSetup(clone.layer));
      expect([alias(clone), recorded(clone)]).toStrictEqual(
        setsUp ? [ALIAS, THIS_VERSION] : ["", `${SET_UP_VERSION} = ${formatJson(version)}\n`],
      );
    }),
  );

  itEffect(
    "records this version, and leaves what's left to doctor, where init can't set the checkout up",
    () =>
      Effect.gen(function* () {
        const clone = gitClone(scratchRepository());
        clone.git("config", "--unset", "user.email");
        yield* setUpOnUpgrade.pipe(provideSetup(clone.layer));
        expect([yield* problems.pipe(provideSetup(clone.layer)), recorded(clone)]).toStrictEqual([
          ["neither jj nor git has user.email; set it with `jj config set --user user.email`"],
          THIS_VERSION,
        ]);
      }),
  );
});
