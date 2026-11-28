import { Array as EffectArray, Console, Effect, type FileSystem, Result, SemVer } from "effect";
import { Command } from "effect/cli";

import manifest from "../../../package.json" with { type: "json" };
import type { Git, GitFailed } from "../../clients/git";
import { type Jj, type JjFailed, setJjConfig } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { NotSetUp, SET_UP_VERSION, type SetupStep, readSetUpVersion, runSteps } from "./setup";

// Returns what the check finds after the fix, such as a value a higher config overrides.
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

export const init: Effect.Effect<
  void,
  GitFailed | JjFailed | NotSetUp,
  FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const { branch, problems } = yield* runSteps(fixed);
  if (problems.length > 0) {
    return yield* NotSetUp.make({ message: EffectArray.join(problems, "\n") });
  }
  yield* setJjConfig(SET_UP_VERSION, manifest.version);
  yield* Console.error(`set up jj, with trunk() as ${yield* branch}@origin`);
});

const THIS_VERSION = SemVer.parseUnsafe(manifest.version);

const isOlder = (recorded: unknown): boolean =>
  typeof recorded !== "string" ||
  Result.match(SemVer.parse(recorded), {
    onFailure: () => true,
    onSuccess: (version) => SemVer.isLessThan(version, THIS_VERSION),
  });

export const setUpOnUpgrade: Effect.Effect<
  void,
  GitFailed | JjFailed,
  FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const setUpVersion = yield* readSetUpVersion;
  if (!isOlder(setUpVersion)) {
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
    "Makes the checkout a colocated jj repository. Copies git's name and email into the repository's jj config where jj lacks them. Where both lack them, set them with `jj config set --user`.",
    "Fetches and tracks `origin`'s default branch, and sets `trunk()` to it in the repository's config, since jj's own `trunk()` guesses from branch names. `submit`, `merge` and `sync` fail where `trunk()` and that branch differ.",
    "Sets the repository's `jj gh` alias to run `jj-octo` from `PATH`, unless it has one.",
    `Once everything is set up, records its version as \`${SET_UP_VERSION}\` in the repository's config. Every other command except \`doctor\` runs \`init\` first where that value is missing, older, or not a version. Those commands record the version even where \`init\` fails, so each upgrade tries once.`,
    "Needs no GitHub token, and changes nothing already set up. Run it again after the default branch changes on GitHub. Sets up what it can, then fails with the rest. Where it can't make a colocated jj repository, as in a git worktree, it sets up nothing.",
  ),
);
