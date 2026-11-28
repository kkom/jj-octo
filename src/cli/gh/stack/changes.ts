import { Array as EffectArray, Effect, Result, Schema, String as EffectString } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { formatJson } from "../../../json";
import type { BookmarkTarget } from "./bookmark-targets";

export class NotAStack extends Schema.TaggedError<NotAStack, { readonly brand: unique symbol }>()(
  "NotAStack",
  { message: Schema.String },
) {}

// Every stack's bottom change. A mutable change off the trunk's history, such as on a release
// branch, is in no stack.
export const STACK_ROOTS = "roots(mutable()) & children(::trunk())";

// The scratch change `jj new` and `jj commit` leave on top, or the one another workspace starts
// from.
export const SCRATCH = '(working_copies() & empty() & description(exact:""))';

// Every change connected to the revision through mutable changes. Stacks meet only at the
// immutable trunk, so this never enters another stack.
export const stackRevset = (revision: string): string =>
  `(reachable(${revision}, mutable()) & (${STACK_ROOTS})::) ~ ${SCRATCH}`;

// For an empty working copy, which the stack leaves out, this starts at the change below.
export const downstackRevset = (revision: string): string =>
  `::(${revision}) & (${stackRevset(revision)})`;

export const upstackRevset = (revision: string): string =>
  `(${revision})+:: & (${stackRevset(revision)})`;

// `none()` gives an empty list a valid revset, where an empty union fails.
export const anyOf = (revsets: readonly string[]): string =>
  EffectArray.join(["none()", ...revsets], " | ");

export const exactPattern = (name: string): string => `exact:${formatJson(name)}`;

// Selects none for a change with no visible commit, where its bare id fails.
export const changeRevset = (change: string): string => `change_id(${change})`;

export const bookmarkRevset = (bookmark: string): string => `bookmarks(${exactPattern(bookmark)})`;

export const lines = (output: string): readonly string[] =>
  EffectArray.filter(EffectString.split(output, "\n"), (line) => line !== "");

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/** A description a template printed with `escape_json()`. */
export const parseDescription = (json: string): string => {
  const parsed = Result.getOrThrow(decodeJson(json));
  return typeof parsed === "string" ? parsed : "";
};

interface ReadLogOptions {
  /** The operation to read the repository at, such as one `Jj.dryRun` returned. */
  readonly atOperation?: string;
  /** Skips the working-copy snapshot, so the read can run beside a jj command that takes one. */
  readonly ignoreWorkingCopy?: boolean;
}

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

export const changesIn = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`change_id.shortest(8) ++ " " ++ description.first_line() ++ "\n"`);

export const commitsAt = (
  revset: string,
  options?: ReadLogOptions,
): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`commit_id ++ "\n"`, options);

export const changeIdsAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`change_id ++ "\n"`);

export const bookmarksAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    // `jj bookmark list` also prints a bookmark's remote copy where it points elsewhere, as a
    // merged branch's does, so the template keeps only the local one.
    const template = String.raw`if(!remote, name ++ "\n")`;
    const listed = yield* jj.read(["bookmark", "list", "-r", revset, "-T", template]);
    return lines(listed);
  });

export const CONFLICTED = "conflicted";

export interface StackChange {
  readonly bookmark: string;
  readonly changeId: string;
  readonly commitId: string;
  /** `jj git push` won't push a change with conflicts. */
  readonly conflict: boolean;
  readonly description: string;
  /** The short change id and the first line of the description. */
  readonly label: string;
}

export type Pushed = "changed since push" | "not pushed" | "pushed";

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
  /** Whether another visible commit has its change id. */
  readonly divergent: boolean;
  /** The short change id and the first line of the description. */
  readonly label: string;
  readonly parents: readonly string[];
}

// One line per change. The description is JSON, so a tab or newline in it can't split a field.
const CHANGE = String.raw`change_id.shortest(8) ++ "\t" ++ change_id ++ "\t" ++ commit_id ++ "\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\t" ++ conflict ++ "\t" ++ divergent ++ "\t" ++ local_bookmarks.map(|b| b.name() ++ if(b.conflict(), "?")).join(" ") ++ "\t" ++ description.escape_json() ++ "\n"`;

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
 * Checks that the logged changes form a chain, and returns them bottom to top, each with its
 * bookmark.
 *
 * A change with conflicts still belongs to the chain; only the commands that push or merge it fail.
 */
export const chainOf = (
  changes: readonly LoggedChange[],
  revision: string,
): Effect.Effect<readonly StackChange[], NotAStack> =>
  Effect.gen(function* () {
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
        "these changes have no bookmark naming their branch:",
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

const chain = (revset: string, revision: string) =>
  Effect.flatMap(loggedChanges(revset), (changes) => chainOf(changes, revision));

export const stackChanges = (
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  chain(stackRevset(revision), revision);

export const downstackChanges = (
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  chain(downstackRevset(revision), revision);

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
