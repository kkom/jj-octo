import {
  Array as EffectArray,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Record as EffectRecord,
  Ref,
  type Scope,
  String as EffectString,
} from "effect";

import { lines } from "../cli/gh/stack/changes";
import { copyRepository, scratchCopyOf } from "./repository-copies";
import {
  clientsIn,
  isolatedEnv,
  jjConfigFile,
  makeExecutor,
  type RepositoryClients,
  type ScratchServices,
  scratchServices,
} from "./scratch-process";
import { templateOf } from "./templates";

/**
 * A jj repository with `main` pushed to a bare `origin`. A git worktree of `origin` stands in for
 * GitHub changing branches. A failed command is a defect, since the test's own setup failed.
 */
export class ScratchRepository extends Context.Service<
  ScratchRepository,
  {
    /** The commit each branch on `origin` points at, by branch name. */
    readonly branches: Effect.Effect<Readonly<Record<string, string>>>;
    /** The directory of the jj repository. */
    readonly checkout: string;
    /** Builds the `RepositoryClients` in a directory, such as a workspace's. */
    readonly clientsIn: (
      directory: string,
    ) => Effect.Effect<Context.Context<RepositoryClients>, never, Scope.Scope>;
    readonly commitOf: (revision: string) => Effect.Effect<string>;
    /** The `labels` of the changes with conflicts, top first. */
    readonly conflicted: Effect.Effect<string>;
    /** The revision's description, without its trailing newline. */
    readonly description: (revision: string) => Effect.Effect<string>;
    /**
     * Runs jj in a second jj clone of `origin`, made on first use. It stands in for the same
     * person's other checkout, whose pushes keep each change's id.
     */
    readonly elsewhere: (...args: readonly string[]) => Effect.Effect<string>;
    readonly env: Readonly<Record<string, string>>;
    /** The files in the revision, sorted. */
    readonly files: (revision: string) => Effect.Effect<readonly string[]>;
    /** Runs git in the worktree standing in for GitHub. */
    readonly git: (...args: readonly string[]) => Effect.Effect<string>;
    readonly jj: (...args: readonly string[]) => Effect.Effect<string>;
    /** One line per revision, in order: its change's short id and its description's first line. */
    readonly labels: (...revisions: readonly string[]) => Effect.Effect<string>;
    /** Each described change above the trunk, bottom to top, as `description [bookmarks]`. */
    readonly log: Effect.Effect<readonly string[]>;
    /** The path of the bare `origin.git`. */
    readonly origin: string;
    /** What the clients' jj commands that change something printed, in order. */
    readonly printed: Effect.Effect<string>;
    /** Adds one change per name on top of `main`, each with a file and a bookmark of that name. */
    readonly stack: (...names: readonly string[]) => Effect.Effect<void>;
    /** Writes a file into the working copy of the second jj clone. */
    readonly writeElsewhere: (file: string, content: string) => Effect.Effect<void>;
    /** Writes a file into the worktree standing in for GitHub. */
    readonly writeOnGitHub: (file: string, content: string) => Effect.Effect<void>;
    /** Writes a file into the jj working copy. */
    readonly write: (file: string, content: string) => Effect.Effect<void>;
  }
>()("jj-octo/testing/scratch-repository/ScratchRepository") {}

const LABEL = String.raw`change_id.shortest(8) ++ " " ++ description.first_line() ++ "\n"`;

// Opens the `origin.git`, `repository`, `github` and jj configuration that a directory holds.
const open = (root: string): Effect.Effect<ScratchRepository["Service"], never, ScratchServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* scratchServices;
    const repository = path.join(root, "repository");
    const github = path.join(root, "github");
    const origin = path.join(root, "origin.git");
    const env = isolatedEnv(root);
    const execute = yield* makeExecutor(env);
    const executeAsGitHub = yield* makeExecutor({
      ...env,
      GIT_AUTHOR_EMAIL: "github@example.com",
      GIT_AUTHOR_NAME: "GitHub",
      GIT_COMMITTER_EMAIL: "github@example.com",
      GIT_COMMITTER_NAME: "GitHub",
    });
    const jj = (...args: readonly string[]) => execute(repository, ["jj", ...args]);
    const git = (...args: readonly string[]) => executeAsGitHub(github, ["git", ...args]);
    const writeIn = (directory: string, file: string, content: string) =>
      Effect.orDie(fs.writeFileString(path.join(directory, file), content));
    const other = path.join(root, "elsewhere");
    const cloneElsewhere = Effect.orDie(fs.exists(other)).pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.void : execute(root, ["jj", "git", "clone", origin, other]),
      ),
    );
    const printed = yield* Ref.make("");
    const labelsIn = (revset: string) =>
      Effect.map(
        jj("log", "--no-graph", "-r", revset, "-T", LABEL),
        EffectString.replace(/\n$/u, ""),
      );

    return {
      branches: git(
        "for-each-ref",
        "--format=%(objectname)%09%(refname:lstrip=2)",
        "refs/heads",
      ).pipe(
        Effect.map((listed) =>
          EffectRecord.fromEntries(
            EffectArray.map(lines(listed), (line): readonly [string, string] => {
              const [commit, branch = ""] = EffectString.split(line, "\t");
              return [branch, commit];
            }),
          ),
        ),
      ),
      checkout: repository,
      clientsIn: (directory) =>
        clientsIn(directory, env, (text) => Ref.update(printed, (before) => before + text)).pipe(
          Effect.provide(services),
        ),
      commitOf: (revision) => jj("log", "--no-graph", "-r", revision, "-T", "commit_id"),
      conflicted: labelsIn("conflicts()"),
      description: (revision) =>
        Effect.map(
          jj("log", "--no-graph", "-r", revision, "-T", "description"),
          EffectString.trimEnd,
        ),
      elsewhere: (...args) => cloneElsewhere.pipe(Effect.andThen(execute(other, ["jj", ...args]))),
      env,
      files: (revision) => jj("file", "list", "-r", revision).pipe(Effect.map(lines)),
      git,
      jj,
      labels: (...revisions) =>
        Effect.map(Effect.forEach(revisions, labelsIn, { concurrency: 1 }), EffectArray.join("\n")),
      log: jj(
        "log",
        "--no-graph",
        "--reversed",
        "-r",
        'trunk().. ~ description(exact:"")',
        "-T",
        String.raw`description.first_line() ++ " [" ++ local_bookmarks.map(|b| b.name()).join(",") ++ "]\n"`,
      ).pipe(Effect.map(lines)),
      origin,
      printed: Ref.get(printed),
      stack: (...names) =>
        Effect.gen(function* () {
          yield* Effect.reduce(
            names,
            () => "main",
            (parent, name) =>
              Effect.gen(function* () {
                yield* jj("new", parent, "-m", name);
                yield* writeIn(repository, `${name}.txt`, `${name}\n`);
                yield* jj("bookmark", "create", name, "-r", "@");
                return name;
              }),
          );
          yield* jj("new");
        }),
      write: (file, content) => writeIn(repository, file, content),
      writeElsewhere: (file, content) =>
        cloneElsewhere.pipe(Effect.andThen(writeIn(other, file, content))),
      writeOnGitHub: (file, content) => writeIn(github, file, content),
    };
  });

const buildBase = (root: string): Effect.Effect<void, never, ScratchServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.orDie(
      fs.writeFileString(jjConfigFile(root), '[user]\nname = "Test"\nemail = "test@example.com"\n'),
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
    const { jj, origin, write } = yield* open(root);
    yield* jj("git", "init", "--colocate");
    yield* jj("git", "remote", "add", "origin", origin);
    yield* jj("describe", "-m", "base");
    yield* write("base.txt", "base\n");
    yield* jj("bookmark", "create", "main", "-r", "@");
    yield* jj("git", "push", "--bookmark", "main");
    yield* execute(origin, [
      "git",
      "worktree",
      "add",
      "--quiet",
      "--detach",
      path.join(root, "github"),
      "main",
    ]);
  });

const baseTemplate: Effect.Effect<string, never, ScratchServices> = templateOf("base", buildBase);

const withRepositoryClients = (
  repository: Layer.Layer<ScratchRepository, never, ScratchServices>,
): Layer.Layer<RepositoryClients | ScratchRepository, never, ScratchServices> =>
  Layer.provideMerge(
    Layer.effectContext(
      Effect.flatMap(ScratchRepository, (built) => built.clientsIn(built.checkout)),
    ),
    repository,
  );

/** `scratchRepository` without its clients, for a fixture that provides its own. */
export const scratchRepositoryWithoutClients: Layer.Layer<
  ScratchRepository,
  never,
  ScratchServices
> = Layer.effect(
  ScratchRepository,
  baseTemplate.pipe(Effect.flatMap(scratchCopyOf), Effect.flatMap(open)),
);

/**
 * A repository with only `main`, pushed, and the `RepositoryClients` in its checkout. The layer's
 * scope removes its directory.
 */
export const scratchRepository: Layer.Layer<
  RepositoryClients | ScratchRepository,
  never,
  ScratchServices
> = withRepositoryClients(scratchRepositoryWithoutClients);

const pushedStackWithoutClients = (
  ...names: readonly string[]
): Layer.Layer<ScratchRepository, never, ScratchServices> =>
  Layer.effect(
    ScratchRepository,
    templateOf(`pushed-${EffectArray.join(names, "-")}`, (root) =>
      Effect.gen(function* () {
        const base = yield* baseTemplate;
        yield* copyRepository(base, root);
        const built = yield* open(root);
        yield* built.stack(...names);
        yield* built.jj(
          "git",
          "push",
          ...EffectArray.flatMap(names, (name) => ["--bookmark", name]),
        );
      }),
    ).pipe(Effect.flatMap(scratchCopyOf), Effect.flatMap(open)),
  );

/**
 * `scratchRepository` with one change per name stacked on `main`, each with its bookmark, pushed.
 */
export const pushedStack = (
  ...names: readonly string[]
): Layer.Layer<RepositoryClients | ScratchRepository, never, ScratchServices> =>
  withRepositoryClients(pushedStackWithoutClients(...names));
