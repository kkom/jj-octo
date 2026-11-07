import { Console, Effect, type FileSystem, Result, SemVer } from "effect";
import { Command } from "effect/cli";

import manifest from "../../../package.json" with { type: "json" };
import type { Git, GitFailed } from "../../clients/git";
import { type Jj, type JjFailed, setJjConfig } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { NotSetUp, SET_UP_VERSION, type SetupStep, readSetUpVersion, runSteps } from "./setup";

/**
 * Runs the fix where the check finds a problem that `init` fixes, and returns what the check finds
 * afterwards, such as a value that a higher config overrides. A check or fix that fails leaves its
 * error as the problem.
 */
const fixed = ({ check, fix }: SetupStep) =>
  Effect.gen(function* () {
    const found = yield* check;
    if (found?.byInit !== true) {
      return found?.message;
    }
    yield* fix;
    const problem = yield* check;
    return problem?.byInit === true
      ? `${problem.message}, though init set it up`
      : problem?.message;
  }).pipe(Effect.catch((error) => Effect.succeed(error.message)));

/**
 * Sets up a git checkout for the other commands: a colocated jj repository with an identity,
 * `origin`'s default branch as `trunk()`, and the `jj gh` alias. Runs every step, and then fails
 * with the problems that remain. Where none remain, records its own version in the repository's
 * config, which `setUpOnUpgrade` reads.
 */
export const init: Effect.Effect<
  void,
  GitFailed | JjFailed | NotSetUp,
  FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const { branch, problems } = yield* runSteps(fixed);
  if (problems.length > 0) {
    yield* new NotSetUp({ message: problems.join("\n") });
  }
  yield* setJjConfig(SET_UP_VERSION, manifest.version);
  yield* Console.error(`set up jj, with trunk() as ${yield* branch}@origin`);
});

const THIS_VERSION = SemVer.parseUnsafe(manifest.version);

/** Whether `recorded` is a version older than this one, or isn't a version at all. */
const isOlder = (recorded: unknown): boolean =>
  typeof recorded !== "string" ||
  Result.match(SemVer.parse(recorded), {
    onFailure: () => true,
    onSuccess: (version) => SemVer.isLessThan(version, THIS_VERSION),
  });

/**
 * Runs `init` where an older version, or none, recorded setting the repository up. Where `init`
 * can't set something up, prints what's left and records this version anyway, so each upgrade
 * tries once.
 */
export const setUpOnUpgrade: Effect.Effect<
  void,
  GitFailed | JjFailed,
  FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  if (!isOlder(yield* readSetUpVersion)) {
    return;
  }
  yield* Console.error(`setting this checkout up for jj-octo ${manifest.version}`);
  yield* init.pipe(
    Effect.catchTag("NotSetUp", ({ message }) =>
      Effect.andThen(
        Console.error(`${message}\nrun \`jj-octo init\` once that's fixed`),
        setJjConfig(SET_UP_VERSION, manifest.version),
      ),
    ),
  );
});

export const initCommand = Command.make("init", {}, () => asUserError(init)).pipe(
  withHelp(
    "Set up a git checkout for the other commands",
    "Makes the checkout a jj repository colocated with git, unless it already is one. Copies git's name and email into the repository's jj config where jj has none. Where neither has them, set them with `jj config set --user`.",
    "Fetches and tracks the default branch of `origin`, and sets `trunk()` to it in the repository's config. jj's own `trunk()` guesses from branch names, and can miss the default branch. `submit`, `merge` and `sync` fail where `trunk()` and that branch point at different commits.",
    "Sets the `jj gh` alias to run `jj-octo` from `PATH` in the repository's config, unless the repository already has one.",
    `Records its version as \`${SET_UP_VERSION}\` in the repository's config, once everything is set up. Where the config holds no version, an older one, or a value that isn't a version, the other commands, except \`doctor\`, run \`init\` first. Where \`init\` reports what it couldn't set up, they still record the version.`,
    "Needs no GitHub token. Changes nothing that is already set up. After the default branch changes on GitHub, run it again. Fails with what it couldn't set up, after setting up the rest. Where it can't make a colocated jj repository, as in a git worktree, it sets up nothing.",
  ),
);
