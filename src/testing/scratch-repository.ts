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
 * A jj repository with `main` pushed to a bare `origin`, for tests that run the real jj. A second,
 * plain git clone of `origin` stands in for GitHub changing branches by itself. A command that
 * fails is a defect, since it's the test's own setup that failed.
 */
export class ScratchRepository extends Context.Service<
  ScratchRepository,
  {
    /** The names of the branches on `origin`, with the commit each points at. */
    readonly branches: Effect.Effect<Readonly<Record<string, string>>>;
    /** The directory of the jj repository. */
    readonly checkout: string;
    /**
     * Builds the git, jj and pull request description clients in the directory, such as a
     * workspace's, for `Effect.provide`.
     */
    readonly clientsIn: (
      directory: string,
    ) => Effect.Effect<Context.Context<RepositoryClients>, never, Scope.Scope>;
    /** The id of the commit the revision names. */
    readonly commitOf: (revision: string) => Effect.Effect<string>;
    /** The label of each change with conflicts, as `labels` gives it, top first. */
    readonly conflicted: Effect.Effect<string>;
    /** The revision's description, without its trailing newline. */
    readonly description: (revision: string) => Effect.Effect<string>;
    /**
     * Runs jj in a second jj clone of `origin`, made on first use. It stands in for another
     * checkout of the same person, whose pushes keep each change's id.
     */
    readonly elsewhere: (...args: readonly string[]) => Effect.Effect<string>;
    /** The environment that jj and the clients run in, in the jj repository. */
    readonly env: Readonly<Record<string, string>>;
    /** The files in the revision, sorted. */
    readonly files: (revision: string) => Effect.Effect<readonly string[]>;
    /** Runs git in the clone standing in for GitHub. */
    readonly git: (...args: readonly string[]) => Effect.Effect<string>;
    /** Runs jj in the repository, and returns what it printed. */
    readonly jj: (...args: readonly string[]) => Effect.Effect<string>;
    /**
     * The change each revision names, as a command lists it: its short id and its description's
     * first line. One line per revision, in the order given.
     */
    readonly labels: (...revisions: readonly string[]) => Effect.Effect<string>;
    /** Each described change above the trunk, bottom to top, as `description [bookmarks]`. */
    readonly log: Effect.Effect<readonly string[]>;
    /** The path of the bare `origin.git`. */
    readonly origin: string;
    /** What the jj commands that the clients ran to change something printed, in order. */
    readonly printed: Effect.Effect<string>;
    /** Adds one change per name on top of `main`, each with a file and a bookmark of that name. */
    readonly stack: (...names: readonly string[]) => Effect.Effect<void>;
    /** Writes a file into the working copy of the second jj clone. */
    readonly writeElsewhere: (file: string, content: string) => Effect.Effect<void>;
    /** Writes a file into the clone standing in for GitHub. */
    readonly writeOnGitHub: (file: string, content: string) => Effect.Effect<void>;
    /** Writes a file into the jj working copy. */
    readonly write: (file: string, content: string) => Effect.Effect<void>;
  }
>()("jj-octo/testing/scratch-repository/ScratchRepository") {}

// A change's label: its short id and its description's first line.
const LABEL = String.raw`change_id.shortest(8) ++ " " ++ description.first_line() ++ "\n"`;

// The repository in a directory that already holds one: `origin.git`, `repository`, `github`
// and the jj configuration.
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
    yield* execute(root, ["git", "clone", "--quiet", origin, "github"]);
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

/**
 * The repository of `scratchRepository`, without its clients, for a fixture that provides clients
 * of its own.
 */
export const scratchRepositoryWithoutClients: Layer.Layer<
  ScratchRepository,
  never,
  ScratchServices
> = Layer.effect(
  ScratchRepository,
  baseTemplate.pipe(Effect.flatMap(scratchCopyOf), Effect.flatMap(open)),
);

/**
 * A repository with only `main`, pushed, and the git, jj and pull request description clients in
 * its checkout. Its directory is removed when the layer's scope closes.
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
 * A repository with one change per name stacked on `main`, each pushed with its bookmark, and the
 * git, jj and pull request description clients in its checkout. Its directory is removed when the
 * layer's scope closes.
 */
export const pushedStack = (
  ...names: readonly string[]
): Layer.Layer<RepositoryClients | ScratchRepository, never, ScratchServices> =>
  withRepositoryClients(pushedStackWithoutClients(...names));
