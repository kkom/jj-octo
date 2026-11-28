import {
  Array as EffectArray,
  Console,
  Effect,
  Match,
  Option,
  Schema,
  String as EffectString,
} from "effect";

import { Git, type GitFailed } from "../../../clients/git";
import type { PullRequest } from "../../../clients/github/types";
import { Jj, type JjFailed } from "../../../clients/jj";
import { PrDescriptions } from "../../../clients/pr-descriptions";
import { bookmarkRevset, lines, parseDescription, readLog, type StackChange } from "./changes";
import {
  agreedDescription,
  descriptionFrom,
  descriptionSyncFor,
  normalizedDescription,
} from "./plan";

export class DescriptionConflict extends Schema.TaggedError<
  DescriptionConflict,
  { readonly brand: unique symbol }
>()("DescriptionConflict", { message: Schema.String }) {}

export interface SyncedDescription {
  readonly send: boolean;
  readonly text: string;
}

const kept = (text: string): SyncedDescription => ({ send: false, text });
const sent = (text: string): SyncedDescription => ({ send: true, text });

interface DescriptionOptions {
  readonly ignoreClaudeCodeFooter: boolean;
  readonly overwriteDescriptions: boolean;
  /** The commit on `origin`'s branch, if any. */
  readonly pushedCommit: string | undefined;
  readonly pushedDescription: string;
}

export const descriptionsOf = (
  commits: readonly string[],
): Effect.Effect<ReadonlyMap<string, string>, JjFailed, Jj> =>
  commits.length === 0
    ? Effect.succeed(new Map<string, string>())
    : readLog(
        EffectArray.join(commits, " | "),
        String.raw`commit_id ++ "\t" ++ description.escape_json() ++ "\n"`,
      ).pipe(
        Effect.map(
          (output) =>
            new Map(
              EffectArray.map(lines(output), (line): [string, string] => {
                const [commit, json = '""'] = EffectString.split(line, "\t");
                return [commit, parseDescription(json)];
              }),
            ),
        ),
      );

interface Evolution {
  readonly commit: string;
  readonly description: string;
  /** Whether jj took the commit from git, as a fetch does, rather than making it. */
  readonly isImported: boolean;
  readonly predecessors: readonly string[];
}

/**
 * Newest first. Leaves out commits squashed in from other changes, and what the change had before
 * `jj split` gave it a new id.
 */
const ownHistory = (
  bookmark: string,
  changeId: string,
): Effect.Effect<readonly Evolution[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const output = yield* jj.read([
      "evolog",
      "--no-graph",
      "-r",
      bookmarkRevset(bookmark),
      "-T",
      String.raw`commit.change_id() ++ "\t" ++ commit.commit_id() ++ "\t" ++ predecessors.map(|p| p.commit_id()).join(",") ++ "\t" ++ if(operation, operation.description()) ++ "\t" ++ commit.description().escape_json() ++ "\n"`,
    ]);
    return EffectArray.flatMap(lines(output), (line) => {
      const [change, commit = "", predecessors = "", operation = "", json = '""'] =
        EffectString.split(line, "\t");
      const isImported =
        EffectString.startsWith("fetch from git")(operation) ||
        EffectString.startsWith("import git")(operation);
      return change === changeId
        ? [
            {
              commit,
              description: parseDescription(json),
              isImported,
              predecessors: predecessors === "" ? [] : EffectString.split(predecessors, ","),
            },
          ]
        : [];
    });
  });

/**
 * Whether the change evolved from the commit without taking another description from git since, as
 * another clone's rewrite of the branch brings in. A commit from git keeps the description where a
 * predecessor had it.
 */
const isDescribedHereFrom = (history: readonly Evolution[], commit: string): boolean => {
  const descriptions = new Map(
    EffectArray.map(history, (entry) => [entry.commit, entry.description]),
  );
  return Option.exists(
    EffectArray.findFirstIndex(history, (entry) => entry.commit === commit),
    (since) =>
      EffectArray.every(
        history.slice(0, since),
        ({ description, isImported, predecessors }) =>
          !isImported ||
          EffectArray.some(predecessors, (each) => descriptions.get(each) === description),
      ),
  );
};

/**
 * Makes a change's description and its pull request's title and body the same text, and returns
 * that text and whether GitHub needs it sent.
 *
 * Who changed the description is judged against the text both sides last agreed on, which `submit`
 * records per pull request with its commit. A record counts while the change evolved from that
 * commit without taking another description from git, as another clone's rewrite of the branch
 * brings in. Without one, the pushed description counts, unless the pull request has an earlier
 * description of the change, which a push without `submit`, such as `jj git push`, leaves. A
 * never-pushed bookmark merges from empty text.
 */
export const syncDescription = (
  { bookmark, changeId, description }: StackChange,
  pullRequest: PullRequest,
  {
    ignoreClaudeCodeFooter,
    overwriteDescriptions,
    pushedCommit,
    pushedDescription,
  }: DescriptionOptions,
): Effect.Effect<
  SyncedDescription,
  DescriptionConflict | GitFailed | JjFailed,
  Git | Jj | PrDescriptions
> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const jj = yield* Jj;
    const records = yield* PrDescriptions;
    const describe = (text: string) =>
      jj.run(["describe", "-r", bookmarkRevset(bookmark), "-m", text]);
    const footer = { ignoreClaudeCodeFooter };
    const normalized = (text: string) => normalizedDescription(text, footer);
    const local = normalized(description);
    const onGitHub = normalized(descriptionFrom(pullRequest));
    const pushed = normalized(pushedDescription);
    const record = yield* records.read(pullRequest.number, bookmark);
    // Where the sides differ, only a record or a GitHub text other than the pushed one needs the
    // evolog.
    const history =
      local === onGitHub || (Option.isNone(record) && onGitHub === pushed)
        ? []
        : yield* ownHistory(bookmark, changeId);
    const age = (commit: string | undefined) =>
      EffectArray.findFirstIndex(history, (entry) => entry.commit === commit);
    // A pull request synced to a commit the change evolved from since the record, as another
    // clone's submit of this clone's push does, last agreed on that commit's description.
    const pushedAge = age(pushedCommit);
    const isPushedAgreedSince = (commit: string) =>
      onGitHub === pushed &&
      Option.exists(pushedAge, (pushedIndex) =>
        Option.exists(age(commit), (index) => pushedIndex < index),
      );
    const recorded = record.pipe(
      Option.filter(
        ({ commit }) => isDescribedHereFrom(history, commit) && !isPushedAgreedSince(commit),
      ),
      Option.map(({ description: text }) => normalized(text)),
    );
    const isOwnEarlier =
      onGitHub !== pushed &&
      EffectArray.some(history, (entry) => normalized(entry.description) === onGitHub);
    const agreed = agreedDescription({ isOwnEarlier, onGitHub, pushed, recorded });

    return yield* Match.value(descriptionSyncFor({ agreed, local, onGitHub })).pipe(
      Match.tag("InSync", () => Effect.succeed(kept(local))),
      Match.tag("TakeGitHub", () =>
        describe(onGitHub).pipe(
          Effect.andThen(
            Console.error(`took the description of #${pullRequest.number} from GitHub`),
          ),
          Effect.as(kept(onGitHub)),
        ),
      ),
      Match.tag("SendLocal", () => Effect.succeed(sent(local))),
      Match.tag("Merge", () =>
        Effect.gen(function* () {
          if (overwriteDescriptions) {
            return sent(local);
          }
          const merged = yield* git.mergeText({ base: agreed, local, remote: onGitHub });
          if (merged.conflicted) {
            return yield* DescriptionConflict.make({
              message: EffectArray.join(
                [
                  `the description of ${bookmark} changed here and in #${pullRequest.number}, in the same lines:`,
                  "",
                  merged.text,
                  "",
                  `Write the one to keep with \`jj describe -r ${bookmark}\`, then run \`jj gh submit --overwrite-descriptions\`.`,
                ],
                "\n",
              ),
            });
          }
          yield* describe(merged.text);
          return sent(merged.text);
        }),
      ),
      Match.exhaustive,
    );
  });
