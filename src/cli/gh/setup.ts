import { Array as EffectArray, Effect, FileSystem, Schema } from "effect";

import { Git, GitFailed, gitConfig, gitDirectories } from "../../clients/git";
import { Jj, type JjFailed, jjConfig, readJjConfig, setJjConfig } from "../../clients/jj";
import { commitsAt, exactPattern } from "./stack/changes";
import { trunkRevset } from "./stack/trunk";

export class NotSetUp extends Schema.TaggedError<NotSetUp, { readonly brand: unique symbol }>()(
  "NotSetUp",
  { message: Schema.String },
) {}

type SetupEffect<A> = Effect.Effect<A, GitFailed | JjFailed, FileSystem.FileSystem | Git | Jj>;

export interface Problem {
  /** Whether `init` sets it up. */
  readonly byInit: boolean;
  readonly message: string;
}

const forInit = (message: string): Problem => ({ byInit: true, message });

export const advice = ({ byInit, message }: Problem): string =>
  byInit ? `${message}; run \`jj-octo init\`` : message;

/** One thing that `init` sets up in a checkout. */
export interface SetupStep {
  /** Changes nothing. */
  readonly check: SetupEffect<Problem | undefined>;
  readonly fix: SetupEffect<void>;
}

// On GitHub, `origin`'s HEAD is the default branch. `ls-remote` needs no token.
const defaultBranch = Effect.gen(function* () {
  const git = yield* Git;
  const output = yield* git.read(["ls-remote", "--symref", "origin", "HEAD"]);
  const branch = /^ref: refs\/heads\/(?<branch>\S+)\tHEAD$/mu.exec(output)?.groups?.["branch"];
  if (branch === undefined) {
    return yield* GitFailed.make({ message: "origin names no default branch" });
  }
  return branch;
});

// Reads the files, since jj fails the same way outside a jj repository as on a config it can't
// parse.
const checkout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { commonDirectory, gitDirectory, topLevel: root } = yield* gitDirectories;
  const isColocated = yield* fs.exists(`${root}/.jj`).pipe(Effect.orElseSucceed(() => false));
  return { isColocated, isWorktree: gitDirectory !== commonDirectory, root };
});

export const SET_UP_VERSION = "jj-octo.set-up-version";

export const readSetUpVersion = readJjConfig(SET_UP_VERSION, { repo: true });

const colocated: SetupStep = {
  check: Effect.map(checkout, ({ isColocated, isWorktree }) => {
    const problem = isWorktree
      ? {
          byInit: false,
          message:
            "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
        }
      : forInit("this checkout isn't a jj repository colocated with git");
    return isColocated ? undefined : problem;
  }),
  fix: Effect.gen(function* () {
    const jj = yield* Jj;
    const { root } = yield* checkout;
    yield* jj.run(["git", "init", "--colocate", root]);
  }),
};

const IDENTITY = ["user.name", "user.email"];

// Copies git's name or email into jj's config, as a fresh container often configures only git.
const identity = (key: string): SetupStep => ({
  check: Effect.gen(function* () {
    const inJj = (yield* jjConfig(key)) !== "";
    const inGit = !inJj && (yield* gitConfig([key])) !== "";
    const problem = inGit
      ? forInit(`jj has no ${key}, which git has`)
      : {
          byInit: false,
          message: `neither jj nor git has ${key}; set it with \`jj config set --user ${key}\``,
        };
    return inJj ? undefined : problem;
  }),
  fix: Effect.gen(function* () {
    const fromGit = yield* gitConfig([key]);
    yield* setJjConfig(key, fromGit);
  }),
});

// Changes jj made before it had an identity have no author and can't be pushed.
const ANONYMOUS = 'mutable() & (author_name(exact:"") | author_email(exact:""))';

// Gives those changes jj's identity. Where jj has none, the identity step reports it.
const authors: SetupStep = {
  check: Effect.gen(function* () {
    const values = yield* Effect.forEach(IDENTITY, jjConfig, { concurrency: "unbounded" });
    const hasIdentity = EffectArray.every(values, (value) => value !== "");
    const isAnonymous = hasIdentity && (yield* commitsAt(ANONYMOUS)).length > 0;
    return isAnonymous ? forInit("some mutable changes have no author") : undefined;
  }),
  fix: Effect.gen(function* () {
    const jj = yield* Jj;
    yield* jj.run(["metaedit", "--quiet", "--update-author", "-r", ANONYMOUS]);
  }),
};

const isTracked = (branch: string) =>
  Effect.map(
    commitsAt(`tracked_remote_bookmarks(${exactPattern(branch)}, remote=exact:"origin")`),
    (commits) => commits.length > 0,
  );

// Compares the text, since another branch can share the commit. A colocating jj writes
// `<branch>@origin`.
const namesTrunk = (branch: string) =>
  Effect.map(
    jjConfig('revset-aliases."trunk()"'),
    (alias) => alias === trunkRevset(branch) || alias === `${branch}@origin`,
  );

const trunk = (branchOnOrigin: Effect.Effect<string, GitFailed, Git>): SetupStep => ({
  check: Effect.gen(function* () {
    const branch = yield* branchOnOrigin;
    return (yield* isTracked(branch)) && (yield* namesTrunk(branch))
      ? undefined
      : forInit(`trunk() isn't ${branch}@origin, GitHub's default branch, fetched and tracked`);
  }),
  fix: Effect.gen(function* () {
    const jj = yield* Jj;
    const branch = yield* branchOnOrigin;
    if ((yield* commitsAt(`present(${trunkRevset(branch)})`)).length === 0) {
      yield* jj.run(["git", "fetch", "--remote", "origin", "--branch", exactPattern(branch)]);
    }
    if (!(yield* isTracked(branch))) {
      yield* jj.run(["bookmark", "track", exactPattern(branch), "--remote", "origin"]);
    }
    if (!(yield* namesTrunk(branch))) {
      yield* setJjConfig('revset-aliases."trunk()"', trunkRevset(branch));
    }
  }),
});

// Sets the alias in the repository's config where it has none, and keeps one that runs another
// build. jj reads aliases only from user and repository config, not from a tracked file.
const alias: SetupStep = {
  check: Effect.map(readJjConfig("aliases.gh", { repo: true }), (value) =>
    value === undefined ? forInit("`jj gh` isn't set up") : undefined,
  ),
  fix: setJjConfig("aliases.gh", ["util", "exec", "--", "jj-octo"]),
};

// The steps that read the colocated jj repository.
const setup = Effect.map(Effect.cached(defaultBranch), (branch) => ({
  branch,
  steps: [...EffectArray.map(IDENTITY, (key) => identity(key)), authors, trunk(branch), alias],
}));

export const runSteps = <R>(
  run: (step: SetupStep) => Effect.Effect<string | undefined, never, R>,
): Effect.Effect<
  { readonly branch: Effect.Effect<string, GitFailed, Git>; readonly problems: readonly string[] },
  never,
  R
> =>
  Effect.gen(function* () {
    const { branch, steps } = yield* setup;
    const notColocated = yield* run(colocated);
    // In turn: `init`'s fixes write the same jj config, and each check runs jj, which may snapshot
    // the working copy.
    const found =
      notColocated === undefined
        ? yield* Effect.forEach(steps, (step) => run(step), { concurrency: 1 })
        : [notColocated];
    // Reports once a failure several steps share, such as an unparseable jj config.
    const problems = new Set(EffectArray.filter(found, (problem) => problem !== undefined));
    return { branch, problems: [...problems] };
  });
