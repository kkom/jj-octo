import { Array as EffectArray, Effect, Result, Schema, String as EffectString } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { formatJson } from "../../../json";
import type { BookmarkTarget } from "./bookmark-targets";

export class NotAStack extends Schema.TaggedError<NotAStack, { readonly brand: unique symbol }>()(
  "NotAStack",
  { message: Schema.String },
) {}

// The bottom change of every stack. A mutable change on anything but the trunk's history, such as
// one on a release branch, is in no stack.
export const STACK_ROOTS = "roots(mutable()) & children(::trunk())";

// The scratch change `jj new` and `jj commit` leave on top, or the one another workspace starts from.
export const SCRATCH = '(working_copies() & empty() & description(exact:""))';

// Every change connected to the revision through mutable changes. Separate stacks meet only at
// the trunk, which is immutable, so this never reaches into another one.
export const stackRevset = (revision: string): string =>
  `(reachable(${revision}, mutable()) & (${STACK_ROOTS})::) ~ ${SCRATCH}`;

// For an empty working copy, which the stack leaves out, this starts at the change below it.
export const downstackRevset = (revision: string): string =>
  `::(${revision}) & (${stackRevset(revision)})`;

/** The changes of the revision's stack that are above it. */
export const upstackRevset = (revision: string): string =>
  `(${revision})+:: & (${stackRevset(revision)})`;

/** The commits of any of the revsets. With none, no commits, where an empty union fails. */
export const anyOf = (revsets: readonly string[]): string =>
  EffectArray.join(["none()", ...revsets], " | ");

/** A jj string pattern that matches the name alone. */
export const exactPattern = (name: string): string => `exact:${formatJson(name)}`;

/** The commits of a change. A change with no visible commit selects none, where its bare id fails. */
export const changeRevset = (change: string): string => `change_id(${change})`;

/** The change a bookmark is on. */
export const bookmarkRevset = (bookmark: string): string => `bookmarks(${exactPattern(bookmark)})`;

export const lines = (output: string): readonly string[] =>
  EffectArray.filter(EffectString.split(output, "\n"), (line) => line !== "");

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** A description that a template printed with `escape_json()`. */
export const parseDescription = (json: string): string => {
  const parsed = Result.getOrThrow(decodeJson(json));
  return typeof parsed === "string" ? parsed : "";
};

interface ReadLogOptions {
  /** The operation to read the repository at, such as one that `Jj.dryRun` returned. */
  readonly atOperation?: string;
  readonly ignoreWorkingCopy?: boolean;
}

/**
 * What `jj log` prints for the revset's commits with the template, bottom first.
 * `ignoreWorkingCopy` skips the snapshot of the working copy, so the read can run alongside another
 * jj command that takes one.
 */
export const readLog = (
  revset: string,
  template: string,
  { atOperation, ignoreWorkingCopy = false }: ReadLogOptions = {},
): Effect.Effect<string, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    return yield* jj.read([
      "log",
      ...(atOperation === undefined ? [] : ["--at-operation", atOperation]),
      ...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
      "--no-graph",
      "--reversed",
      "-r",
      revset,
      "-T",
      template,
    ]);
  });

export const logLines = (
  revset: string,
  template: string,
  options?: ReadLogOptions,
): Effect.Effect<readonly string[], JjFailed, Jj> =>
  readLog(revset, template, options).pipe(Effect.map(lines));

/** Each of the revset's changes as its short id and the first line of its description. */
export const changesIn = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`change_id.shortest(8) ++ " " ++ description.first_line() ++ "\n"`);

export const commitsAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`commit_id ++ "\n"`);

export const changeIdsAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`change_id ++ "\n"`);

/** The names of the local bookmarks on the revset's commits. */
export const bookmarksAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    // `jj bookmark list` also prints a bookmark's remote copy where it points elsewhere, as a
    // merged branch's does, so the template keeps the local one alone.
    const template = String.raw`if(!remote, name ++ "\n")`;
    const listed = yield* jj.read(["bookmark", "list", "-r", revset, "-T", template]);
    return lines(listed);
  });

/** What the commands that show a stack print beside a change with conflicts. */
export const CONFLICTED = "conflicted";

/** One change of a stack, with the bookmark that names its branch. */
export interface StackChange {
  readonly bookmark: string;
  readonly changeId: string;
  readonly commitId: string;
  /** Whether the change has conflicts, which `jj git push` won't push. */
  readonly conflict: boolean;
  readonly description: string;
  /** The short change id and the first line of the description. */
  readonly label: string;
}

export type Pushed = "changed since push" | "not pushed" | "pushed";

/** Whether a change is the commit its bookmark's branch has. */
export const pushedState = (
  target: BookmarkTarget | undefined,
  { commitId }: StackChange,
): Pushed => {
  const onOrigin = target?.origin;
  if (onOrigin === undefined) {
    return "not pushed";
  }
  return onOrigin === commitId ? "pushed" : "changed since push";
};

export interface LoggedChange {
  /** Local bookmark names, a conflicted one ending in `?`. */
  readonly bookmarks: readonly string[];
  readonly changeId: string;
  readonly commitId: string;
  readonly conflict: boolean;
  readonly description: string;
  /** Whether another visible commit has the same change id. */
  readonly divergent: boolean;
  /** The short change id and the first line of the description. */
  readonly label: string;
  readonly parents: readonly string[];
}

// One line per change. The description is JSON, so a tab or a newline in it can't split a field.
const CHANGE = String.raw`change_id.shortest(8) ++ "\t" ++ change_id ++ "\t" ++ commit_id ++ "\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\t" ++ conflict ++ "\t" ++ divergent ++ "\t" ++ local_bookmarks.map(|b| b.name() ++ if(b.conflict(), "?")).join(" ") ++ "\t" ++ description.escape_json() ++ "\n"`;

/** The revset's changes, each after the changes below it. */
export const loggedChanges = (
  revset: string,
  options?: ReadLogOptions,
): Effect.Effect<readonly LoggedChange[], JjFailed, Jj> =>
  logLines(revset, CHANGE, options).pipe(
    Effect.map((logged) =>
      EffectArray.map(logged, (line): LoggedChange => {
        const [
          shortId,
          changeId = "",
          commitId = "",
          parents = "",
          conflict,
          divergent,
          bookmarks = "",
          json = '""',
        ] = EffectString.split(line, "\t");
        const description = parseDescription(json);
        return {
          bookmarks: bookmarks === "" ? [] : EffectString.split(bookmarks, " "),
          changeId,
          commitId,
          conflict: conflict === "true",
          description,
          divergent: divergent === "true",
          label: `${shortId} ${EffectArray.headNonEmpty(EffectString.split(description, "\n"))}`,
          parents: EffectString.split(parents, ","),
        };
      }),
    ),
  );

const notAStack = (message: string, changes: readonly string[]) =>
  Effect.fail(NotAStack.make({ message: EffectArray.join([message, ...changes], "\n") }));

const labels = (changes: readonly LoggedChange[]): readonly string[] =>
  EffectArray.map(changes, ({ label }) => label);

/**
 * The changes of the revset, bottom to top, each with its bookmark. A GitHub stack must be a
 * chain, but jj allows any history: one head and no merges means the changes form a chain. Each
 * change becomes one pull request, so it needs exactly one bookmark to name its branch. A change
 * with conflicts is still part of the chain, which only a command that pushes or merges it fails on.
 */
const chain = (
  revset: string,
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  Effect.gen(function* () {
    const changes = yield* loggedChanges(revset);
    if (changes.length === 0) {
      return yield* notAStack(
        `\`${revision}\` is on no stack; name a change of one that is based on the trunk, or run \`jj new\` on its top`,
        [],
      );
    }
    const heads = EffectArray.filter(
      changes,
      ({ commitId }) => !EffectArray.some(changes, ({ parents }) => parents.includes(commitId)),
    );
    if (heads.length !== 1) {
      return yield* notAStack(
        "the stack has several heads, and a GitHub stack must be a chain:",
        labels(heads),
      );
    }
    const merges = EffectArray.filter(changes, ({ parents }) => parents.length > 1);
    if (merges.length > 0) {
      return yield* notAStack("merge commits can't be pull requests in a stack:", labels(merges));
    }
    const unnamed = EffectArray.filter(changes, ({ bookmarks }) => bookmarks.length === 0);
    if (unnamed.length > 0) {
      return yield* notAStack(
        "every change needs a bookmark naming its branch; these have none:",
        labels(unnamed),
      );
    }
    const conflicted = EffectArray.flatMap(changes, ({ bookmarks }) =>
      EffectArray.map(
        EffectArray.filter(bookmarks, (name) => EffectString.endsWith("?")(name)),
        (name) => EffectString.slice(0, -1)(name),
      ),
    );
    if (conflicted.length > 0) {
      return yield* notAStack(
        "these bookmarks point at two changes, one local and one from GitHub; keep one with `jj bookmark set <name> -r <revision>`:",
        conflicted,
      );
    }
    const several = EffectArray.filter(changes, ({ bookmarks }) => bookmarks.length > 1);
    if (several.length > 0) {
      return yield* notAStack(
        "a pull request has one branch, and these changes have several bookmarks:",
        EffectArray.map(several, ({ bookmarks }) => EffectArray.join(bookmarks, " ")),
      );
    }
    return EffectArray.map(
      changes,
      ({ bookmarks, changeId, commitId, conflict, description, label }) => ({
        bookmark: bookmarks[0] ?? "",
        changeId,
        commitId,
        conflict,
        description,
        label,
      }),
    );
  });

/** The whole stack containing the revision, bottom to top. */
export const stackChanges = (
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  chain(stackRevset(revision), revision);

/** The revision's change and the ones below it in its stack, bottom to top. */
export const downstackChanges = (
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  chain(downstackRevset(revision), revision);

/**
 * The changes, where none has conflicts. A command that pushes or merges changes checks the ones it
 * acts on, before it touches the remote.
 */
export const withoutConflicts = (
  changes: readonly StackChange[],
): Effect.Effect<readonly StackChange[], NotAStack> => {
  const conflicted = EffectArray.filter(changes, ({ conflict }) => conflict);
  return conflicted.length > 0
    ? notAStack(
        "resolve the conflicts first:",
        EffectArray.map(conflicted, ({ label }) => label),
      )
    : Effect.succeed(changes);
};
