import {
  Array as EffectArray,
  Console,
  Effect,
  Option,
  Schema,
  String as EffectString,
} from "effect";
import { Command, Flag } from "effect/cli";

import {
  Clipboard,
  type ClipboardFailed,
  ClipboardLive,
  type ClipboardWrite,
} from "../../clients/clipboard";
import { GitHub } from "../../clients/github/client";
import type { GitHubFailed } from "../../clients/github/failure";
import type { ListedPullRequest, PullRequestState, StackLink } from "../../clients/github/types";
import { type Jj, JjFailed } from "../../clients/jj";
import { asUserError, provideGitHubFromOrigin, revisionFlag, withHelp } from "../command";
import { bookmarkTargets } from "./stack/bookmark-targets";
import { anyOf, CONFLICTED, lines, type NotAStack, readLog, stackChanges } from "./stack/changes";

export class NoPullRequests extends Schema.TaggedError<
  NoPullRequests,
  { readonly brand: unique symbol }
>()("NoPullRequests", { message: Schema.String }) {}

/** `approved` is a `ready` pull request that GitHub's search lists as approved. */
export type LinkState = PullRequestState | "approved";

const EMOJI: Readonly<Record<LinkState, string>> = {
  approved: "✅",
  closed: "🚫",
  draft: "📝",
  merged: "🏁",
  ready: "👀",
};

const STACK_EMOJI = "📚";

const OPEN: Readonly<Record<LinkState, boolean>> = {
  approved: true,
  closed: false,
  draft: true,
  merged: false,
  ready: true,
};

const COPY_REPORT: Readonly<Record<ClipboardWrite, string>> = {
  copied: "copied the links to the clipboard",
  unreachable:
    "This Claude Code cloud session can't reach the user's clipboard. Copy the lines between the markers into your reply verbatim. Leave out the markers, and add no code block or backticks. The lines then show as links that paste into Slack.",
};

const COPY_PRINT: Readonly<Record<ClipboardWrite, (text: string) => string>> = {
  copied: (text) => text,
  unreachable: (text) =>
    EffectArray.join(
      ["-----BEGIN TEXT TO PASTE VERBATIM-----", text, "-----END TEXT TO PASTE VERBATIM-----"],
      "\n",
    ),
};

interface LineCounts {
  readonly added: number;
  readonly removed: number;
}

const lineCountsAt = (
  commitIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, LineCounts>, JjFailed, Jj> =>
  readLog(
    anyOf(commitIds),
    String.raw`commit_id ++ "\t" ++ diff.stat().total_added() ++ "\t" ++ diff.stat().total_removed() ++ "\n"`,
    { ignoreWorkingCopy: true },
  ).pipe(
    Effect.map(
      (logged) =>
        new Map(
          EffectArray.flatMap(lines(logged), (line) => {
            const [commitId, added = "", removed = ""] = EffectString.split(line, "\t");
            return /^\d+$/u.test(added) && /^\d+$/u.test(removed)
              ? [[commitId, { added: Number(added), removed: Number(removed) }] as const]
              : [];
          }),
        ),
    ),
  );

interface CountedPullRequest extends ListedPullRequest, LineCounts {
  readonly conflict: boolean;
}

export interface LinkedPullRequest extends Omit<CountedPullRequest, "state"> {
  readonly state: LinkState;
}

const lineCounts = ({ added, removed }: LineCounts): string => `+${added}/-${removed}`;

// Reads only open pull requests: a merged one can be in an older stack that `submit` dissolved.
const currentStack = (pullRequests: readonly LinkedPullRequest[]): Option.Option<StackLink> =>
  EffectArray.findFirst(pullRequests, ({ stack, state }) => (OPEN[state] ? stack : Option.none()));

interface LinkFormat {
  readonly code: (text: string) => string;
  readonly link: (text: string, url: string) => string;
}

const linkLines = (
  pullRequests: readonly LinkedPullRequest[],
  { code, link }: LinkFormat,
): readonly string[] => [
  ...EffectArray.map(
    Option.toArray(currentStack(pullRequests)),
    ({ number, url }) => `${STACK_EMOJI} Current stack: ${link(`#${number}`, url)}`,
  ),
  ...EffectArray.map(
    pullRequests,
    (pullRequest) =>
      `${EMOJI[pullRequest.state]} ${link(`#${pullRequest.number} ${pullRequest.title}`, pullRequest.url)} ${code(lineCounts(pullRequest))}${pullRequest.conflict ? ` ${CONFLICTED}` : ""}`,
  ),
];

const MARKDOWN: LinkFormat = {
  code: (text) => `\`${text}\``,
  link: (text, url) => `[${text}](${url})`,
};

const HTML: LinkFormat = {
  code: (text) => `<code>${text}</code>`,
  link: (text, url) => `<a href="${Bun.escapeHTML(url)}">${Bun.escapeHTML(text)}</a>`,
};

export const markdownLinks = (pullRequests: readonly LinkedPullRequest[]): string =>
  EffectArray.join(linkLines(pullRequests, MARKDOWN), "\n");

// The charset keeps emoji intact where an app reads the HTML without one.
export const htmlLinks = (pullRequests: readonly LinkedPullRequest[]): string =>
  `<meta charset="utf-8">${EffectArray.join(linkLines(pullRequests, HTML), "<br>")}`;

// A closed pull request with another head is for an earlier version of the change, or an earlier
// branch of that name.
const pullRequestOf = (
  pullRequests: readonly ListedPullRequest[],
  commitId: string,
  pushed: string | undefined,
): Option.Option<ListedPullRequest> =>
  Option.orElse(
    EffectArray.findFirst(pullRequests, ({ state }) => OPEN[state]),
    () => EffectArray.findFirst(pullRequests, ({ head }) => head === commitId || head === pushed),
  );

export const stackPullRequests = (
  revision: string,
): Effect.Effect<readonly LinkedPullRequest[], GitHubFailed | JjFailed | NotAStack, GitHub | Jj> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* stackChanges(revision);
    const [targets, counts, found] = yield* Effect.all(
      [
        bookmarkTargets,
        lineCountsAt(EffectArray.map(stack, ({ commitId }) => commitId)),
        Effect.forEach(stack, ({ bookmark }) => github.pullRequestsFrom(bookmark), {
          concurrency: "unbounded",
        }),
      ],
      { concurrency: "unbounded" },
    );
    const counted: CountedPullRequest[] = [];
    for (const [index, { bookmark, commitId, conflict }] of stack.entries()) {
      const pullRequest = pullRequestOf(
        found[index] ?? [],
        commitId,
        targets.get(bookmark)?.origin,
      );
      const changed = counts.get(commitId);
      if (Option.isSome(pullRequest)) {
        if (changed === undefined) {
          return yield* JjFailed.make({ message: `jj printed no line counts for ${commitId}` });
        }
        counted.push({ ...pullRequest.value, ...changed, conflict });
      }
    }
    const approved = yield* github.approvedPullRequests(
      EffectArray.filter(counted, ({ state }) => state === "ready"),
    );
    return EffectArray.map(EffectArray.reverse(counted), (pullRequest): LinkedPullRequest =>
      approved.has(pullRequest.number) ? { ...pullRequest, state: "approved" } : pullRequest,
    );
  });

export const links = ({
  copy,
  revision,
}: {
  readonly copy: boolean;
  readonly revision: string;
}): Effect.Effect<
  void,
  ClipboardFailed | GitHubFailed | JjFailed | NoPullRequests | NotAStack,
  Clipboard | GitHub | Jj
> =>
  Effect.gen(function* () {
    // Failing leaves the clipboard unchanged, not as if it held the links.
    const pullRequests = yield* stackPullRequests(revision).pipe(
      Effect.filterOrFail(
        (found) => found.length > 0,
        () => NoPullRequests.make({ message: "no change of the stack has a pull request" }),
      ),
    );
    const text = markdownLinks(pullRequests);
    if (copy) {
      const clipboard = yield* Clipboard;
      // The links still reach the terminal where the clipboard fails.
      const written = yield* clipboard
        .write({ html: htmlLinks(pullRequests), text })
        .pipe(Effect.tapError(() => Console.log(text)));
      yield* Console.log(COPY_PRINT[written](text));
      yield* Console.error(COPY_REPORT[written]);
    } else {
      yield* Console.log(text);
    }
  });

export const linksCommand = Command.make(
  "links",
  {
    copy: Flag.Boolean("copy").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Also copy the links to the clipboard"),
    ),
    revision: revisionFlag("A change of the stack to list"),
  },
  (options) => asUserError(links(options)),
).pipe(
  provideGitHubFromOrigin,
  Command.provide(ClipboardLive),
  withHelp(
    "Print the stack's pull requests as Markdown links",
    "Prints a link to the open pull requests' GitHub stack, as \"Current stack\", if they are in one. Then one line per pull request, top first: 📝 draft, 👀 ready for review, ✅ approved, 🏁 merged, 🚫 closed. Each line has a Markdown link with the number and title, then the change's added and removed lines, such as `+123/-45`. A change with conflicts ends its line with `conflicted`.",
    "A pull request is approved where GitHub's search lists it as approved. Search answers from an index, so a new review can take seconds to show.",
    "A change's pull request is the open one from its branch, else the newest closed one whose head is the change or its pushed commit. Leaves out changes with no pull request, and ones `sync` abandoned after their pull request merged. Fails where no change has one.",
    "`--copy` copies the links as HTML, which Slack pastes as links. It uses `osascript` on macOS, or `wl-copy` or `xclip` on Linux. On macOS, it also copies the Markdown as plain text.",
    "In a Claude Code cloud session (`CLAUDE_CODE_REMOTE` is `true`), `--copy` copies nothing. It prints the Markdown between markers and tells the agent to copy it into its reply, where the Claude app shows links that paste into Slack.",
    "Changes nothing, locally or on GitHub.",
  ),
);
