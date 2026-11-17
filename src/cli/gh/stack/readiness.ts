import { Data, Effect, Option } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { lines } from "./changes";
import { titleAndBody } from "./plan";

export class DescriptionsNotReady extends Data.TaggedError("DescriptionsNotReady")<{
  readonly message: string;
}> {}

/** A change whose pull request would be published, and the description it would have. */
export interface Publishing {
  readonly description: string;
  /** The short change id and the first line of the description. */
  readonly label: string;
}

// Where GitHub looks for a pull request template, in the order one is taken from.
const TEMPLATE_DIRECTORIES = [".github/", "", "docs/"];
const TEMPLATE_NAME = "pull_request_template.md";

/** The trunk's pull request template, where it has one. GitHub matches the name in any case. */
const pullRequestTemplate: Effect.Effect<Option.Option<string>, JjFailed, Jj> = Effect.gen(
  function* () {
    const jj = yield* Jj;
    const patterns = TEMPLATE_DIRECTORIES.map(
      (directory) => `root-glob-i:"${directory}${TEMPLATE_NAME}"`,
    );
    const found = lines(yield* jj.read(["file", "list", "-r", "trunk()", ...patterns]));
    const [template] = TEMPLATE_DIRECTORIES.flatMap((directory) =>
      found.filter((file) => file.toLowerCase() === `${directory}${TEMPLATE_NAME}`),
    );
    return template === undefined
      ? Option.none()
      : Option.some(yield* jj.read(["file", "show", "-r", "trunk()", `root:"${template}"`]));
  },
);

const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const HEADING = /^#{1,6}(?:\s|$)/u;

/** The Markdown's heading lines outside HTML comments, without the space around them. */
const headings = (markdown: string): readonly string[] =>
  markdown
    .replaceAll(HTML_COMMENT, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => HEADING.test(line));

/** What the description lacks to be ready for review, or nothing where it is ready. */
const lacking = (description: string, template: Option.Option<string>): Option.Option<string> => {
  const { body } = titleAndBody(description);
  if (body.trim() === "") {
    return Option.some("has no body");
  }
  const present = new Set(headings(body));
  const missing = Option.match(template, {
    onNone: () => [],
    onSome: (text) => headings(text).filter((heading) => !present.has(heading)),
  });
  return missing.length === 0
    ? Option.none()
    : Option.some(`lacks ${missing.map((heading) => `\`${heading}\``).join(", ")}`);
};

/**
 * Each change whose description isn't ready for review, as its label and what the description
 * lacks. A description is ready where it has a body, and the body has every heading of the trunk's
 * pull request template.
 */
const unreadyDescriptions = (
  changes: readonly Publishing[],
): Effect.Effect<readonly string[], JjFailed, Jj> =>
  changes.length === 0
    ? Effect.succeed([])
    : Effect.map(pullRequestTemplate, (template) =>
        changes.flatMap(({ description, label }) =>
          Option.toArray(Option.map(lacking(description, template), (what) => `${label}: ${what}`)),
        ),
      );

const DESCRIBE_HINT =
  "write each with `jj describe -r <change id>`, then run `jj gh submit` before publishing";

/**
 * Fails where the changes are about to be published and a description isn't ready for review.
 * Otherwise returns the warning to print about the ones that aren't, where any aren't.
 */
export const checkDescriptions = (
  changes: readonly Publishing[],
  { publishing }: { readonly publishing: boolean },
): Effect.Effect<Option.Option<string>, DescriptionsNotReady | JjFailed, Jj> =>
  Effect.flatMap(unreadyDescriptions(changes), (unready) => {
    if (unready.length === 0) {
      return Effect.succeed(Option.none());
    }
    if (publishing) {
      return Effect.fail(
        new DescriptionsNotReady({
          message: ["these descriptions aren't ready for review:", ...unready, DESCRIBE_HINT].join(
            "\n",
          ),
        }),
      );
    }
    return Effect.succeed(
      Option.some(
        [
          "`jj gh publish` fails until these descriptions are ready for review:",
          ...unready,
          DESCRIBE_HINT,
        ].join("\n"),
      ),
    );
  });
