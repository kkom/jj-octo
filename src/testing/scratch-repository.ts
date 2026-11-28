import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Layer,
  Path,
  Record as EffectRecord,
  type Scope,
  String as EffectString,
} from "effect";

import { lines } from "../cli/gh/stack/changes";
import type { Git } from "../clients/git";
import type { ListedPullRequest } from "../clients/github/types";
import type { Jj } from "../clients/jj";
import { PrDescriptions } from "../clients/pr-descriptions";
import { provideSetup } from "./it-effect";
import { pullRequest } from "./pull-requests";
import {
  isolatedEnv,
  layerAt,
  makeExecutor,
  type ScratchServices,
  scratchDirectory,
} from "./scratch-process";
import { templateOf } from "./templates";

/**
 * A jj repository with `main` pushed to a bare `origin`, for tests that run the real jj. A second,
 * plain git clone of `origin` stands in for GitHub changing branches by itself. A command that
 * fails is a defect, since it's the test's own setup that failed.
 */
export interface ScratchRepository {
  /** The names of the branches on `origin`, with the commit each points at. */
  readonly branches: Effect.Effect<Readonly<Record<string, string>>>;
  /** The id of the commit the revision names. */
  readonly commitOf: (revision: string) => Effect.Effect<string>;
  /**
   * Runs jj in a second jj clone of `origin`, made on first use. It stands in for another checkout
   * of the same person, whose pushes keep each change's id.
   */
  readonly elsewhere: (...args: readonly string[]) => Effect.Effect<string>;
  /** The files in the revision, sorted. */
  readonly files: (revision: string) => Effect.Effect<readonly string[]>;
  /** Runs git in the clone standing in for GitHub. */
  readonly git: (...args: readonly string[]) => Effect.Effect<string>;
  /** Runs jj in the repository, and returns what it printed. */
  readonly jj: (...args: readonly string[]) => Effect.Effect<string>;
  readonly layer: Layer.Layer<Git | Jj | PrDescriptions>;
  /** The effect, with the repository's recorded pull request descriptions. */
  readonly records: <A>(
    effect: (store: PrDescriptions["Service"]) => Effect.Effect<A>,
  ) => Effect.Effect<A>;
  /** The same clients in another directory, such as a workspace added to the repository. */
  readonly layerAt: (directory: string) => Layer.Layer<Git | Jj | PrDescriptions>;
  /** Each described change above the trunk, bottom to top, as `description [bookmarks]`. */
  readonly log: Effect.Effect<readonly string[]>;
  /** Records that GitHub merged a pull request from the branch, whose head was the commit. */
  readonly mergedOnGitHub: (branch: string, head: string) => void;
  /** What the jj commands that `layer` ran to change something printed, in order. */
  readonly printed: () => string;
  /** The pull requests from the branch that `mergedOnGitHub` recorded, newest first. */
  readonly pullRequestsFrom: (branch: string) => readonly ListedPullRequest[];
  /** The directory of the jj repository. */
  readonly root: string;
  /** Adds one change per name on top of `main`, each with a file and a bookmark of that name. */
  readonly stack: (...names: readonly string[]) => Effect.Effect<void>;
  /** Writes a file into the working copy of the second jj clone. */
  readonly writeElsewhere: (file: string, content: string) => Effect.Effect<void>;
  /** Writes a file into the clone standing in for GitHub. */
  readonly writeOnGitHub: (file: string, content: string) => Effect.Effect<void>;
  /** Writes a file into the jj working copy. */
  readonly write: (file: string, content: string) => Effect.Effect<void>;
}

// The repository in a directory that already holds one: `origin.git`, `repository`, `github`
// and the jj configuration.
const open = (root: string): Effect.Effect<ScratchRepository, never, ScratchServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<ScratchServices>();
    const repository = path.join(root, "repository");
    const github = path.join(root, "github");
    const env = {
      ...isolatedEnv(root),
      GIT_AUTHOR_EMAIL: "github@example.com",
      GIT_AUTHOR_NAME: "GitHub",
      GIT_COMMITTER_EMAIL: "github@example.com",
      GIT_COMMITTER_NAME: "GitHub",
    };
    const execute = yield* makeExecutor(env);
    const jj = (...args: readonly string[]) => execute(repository, ["jj", ...args]);
    const git = (...args: readonly string[]) => execute(github, ["git", ...args]);
    const writeIn = (directory: string, file: string, content: string) =>
      Effect.orDie(fs.writeFileString(path.join(directory, file), content));
    const other = path.join(root, "elsewhere");
    const cloneElsewhere = Effect.orDie(fs.exists(other)).pipe(
      Effect.flatMap((exists) =>
        exists
          ? Effect.void
          : execute(root, ["jj", "git", "clone", path.join(root, "origin.git"), other]),
      ),
    );
    const merged: { readonly branch: string; readonly pullRequest: ListedPullRequest }[] = [];
    const printed: string[] = [];
    const layerIn = (directory: string) =>
      layerAt(directory, env, (text) => {
        printed.push(text);
      }).pipe(Layer.provide(Layer.succeedContext(services)));
    const layer = layerIn(repository);

    return {
      branches: git("ls-remote", "--heads", "origin").pipe(
        Effect.map((listed) =>
          EffectRecord.fromEntries(
            EffectArray.map(lines(listed), (line): readonly [string, string] => {
              const [commit, ref = ""] = EffectString.split(line, "\t");
              return [EffectString.replace("refs/heads/", "")(ref), commit];
            }),
          ),
        ),
      ),
      commitOf: (revision) => jj("log", "--no-graph", "-r", revision, "-T", "commit_id"),
      elsewhere: (...args) => cloneElsewhere.pipe(Effect.andThen(execute(other, ["jj", ...args]))),
      files: (revision) => jj("file", "list", "-r", revision).pipe(Effect.map(lines)),
      git,
      jj,
      layer,
      layerAt: layerIn,
      log: jj(
        "log",
        "--no-graph",
        "--reversed",
        "-r",
        'trunk().. ~ description(exact:"")',
        "-T",
        String.raw`description.first_line() ++ " [" ++ local_bookmarks.map(|b| b.name()).join(",") ++ "]\n"`,
      ).pipe(Effect.map(lines)),
      mergedOnGitHub: (branch, head) => {
        const number = merged.length + 1;
        merged.unshift({
          branch,
          pullRequest: { ...pullRequest(number, "merged", head), title: branch },
        });
      },
      printed: () => EffectArray.join(printed, ""),
      pullRequestsFrom: (branch) =>
        EffectArray.map(
          EffectArray.filter(merged, (recorded) => recorded.branch === branch),
          (recorded) => recorded.pullRequest,
        ),
      records: (effect) => Effect.flatMap(PrDescriptions, effect).pipe(provideSetup(layer)),
      root: repository,
      stack: (...names) =>
        Effect.gen(function* () {
          yield* jj("new", "main");
          yield* Effect.forEach(
            names,
            (name) =>
              Effect.gen(function* () {
                yield* jj("describe", "-m", name);
                yield* writeIn(repository, `${name}.txt`, `${name}\n`);
                yield* jj("bookmark", "create", name, "-r", "@");
                yield* jj("new");
              }),
            { concurrency: 1, discard: true },
          );
        }),
      write: (file, content) => writeIn(repository, file, content),
      writeElsewhere: (file, content) =>
        cloneElsewhere.pipe(Effect.andThen(writeIn(other, file, content))),
      writeOnGitHub: (file, content) => writeIn(github, file, content),
    };
  });

// The two git configurations hold the path of `origin.git`, which is rewritten to the copy's.
const duplicate = (
  from: string,
  to: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.copy(from, to, { preserveTimestamps: true });
    yield* Effect.forEach(
      ["repository/.git/config", "github/.git/config"],
      (config) => {
        const file = path.join(to, config);
        return fs
          .readFileString(file)
          .pipe(
            Effect.flatMap((text) =>
              fs.writeFileString(file, EffectString.replaceAll(from, to)(text)),
            ),
          );
      },
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.orDie);

const copyOf = (
  template: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* scratchDirectory("repository-");
    yield* duplicate(template, root);
    return root;
  });

const buildBase = (root: string): Effect.Effect<void, never, ScratchServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.orDie(
      fs.writeFileString(
        path.join(root, "config.toml"),
        '[user]\nname = "Test"\nemail = "test@example.com"\n',
      ),
    );
    yield* Effect.orDie(fs.makeDirectory(path.join(root, "repository")));
    const execute = yield* makeExecutor(isolatedEnv(root));
    yield* execute(root, [
      "git",
      "init",
      "--quiet",
      "--bare",
      "--initial-branch=main",
      "origin.git",
    ]);
    const { jj, write } = yield* open(root);
    yield* jj("git", "init", "--colocate");
    yield* jj("git", "remote", "add", "origin", path.join(root, "origin.git"));
    yield* jj("describe", "-m", "base");
    yield* write("base.txt", "base\n");
    yield* jj("bookmark", "create", "main", "-r", "@");
    yield* jj("git", "push", "--bookmark", "main");
    yield* execute(root, ["git", "clone", "--quiet", path.join(root, "origin.git"), "github"]);
  });

const baseTemplate: Effect.Effect<string, never, ScratchServices> = templateOf("base", buildBase);

/** A repository with only `main`, pushed. Its directory is removed when the test's scope closes. */
export const scratchRepository: Effect.Effect<
  ScratchRepository,
  never,
  ScratchServices | Scope.Scope
> = baseTemplate.pipe(Effect.flatMap(copyOf), Effect.flatMap(open));

/** A repository with one change per name stacked on `main`, each pushed with its bookmark. */
export const pushedStack = (
  ...names: readonly string[]
): Effect.Effect<ScratchRepository, never, ScratchServices | Scope.Scope> =>
  templateOf(`pushed-${EffectArray.join(names, "-")}`, (root) =>
    Effect.gen(function* () {
      const base = yield* baseTemplate;
      yield* duplicate(base, root);
      const built = yield* open(root);
      yield* built.stack(...names);
      yield* built.jj("git", "push", ...EffectArray.flatMap(names, (name) => ["--bookmark", name]));
    }),
  ).pipe(Effect.flatMap(copyOf), Effect.flatMap(open));
