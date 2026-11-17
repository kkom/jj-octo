import { moveTrunkOnGitHub } from "./branch-changes";
import type { ScratchRepository } from "./scratch-repository";

/** A pull request template with two headings, and one inside an HTML comment. */
export const TEMPLATE = [
  "<!-- Fill in each section.",
  "## Notes",
  "-->",
  "",
  "## Summary",
  "",
  "<!-- Why the change is needed. -->",
  "",
  "## Verification",
  "",
].join("\n");

/** A body with every heading `TEMPLATE` requires. */
export const FILLED = "## Summary\n\nIt's needed.\n\n## Verification\n\nTests.";

/** Gives each change of a bookmark its name as the title and the body. */
export const describeChanges = (
  repository: ScratchRepository,
  bodies: Readonly<Record<string, string>>,
): void => {
  for (const [bookmark, body] of Object.entries(bodies)) {
    repository.jj("describe", "-r", bookmark, "-m", `${bookmark}\n\n${body}`);
  }
};

/** Describes the changes as `describeChanges` does, then pushes them. */
export const describeAndPush = (
  repository: ScratchRepository,
  bodies: Readonly<Record<string, string>>,
): void => {
  describeChanges(repository, bodies);
  repository.jj(
    "git",
    "push",
    ...Object.keys(bodies).flatMap((bookmark) => ["--bookmark", bookmark]),
  );
};

/** Adds the pull request template to `main` on GitHub, and fetches it. */
export const templateOnTrunk = (
  repository: ScratchRepository,
  file = ".github/pull_request_template.md",
): void => {
  moveTrunkOnGitHub(repository, file, TEMPLATE);
  repository.jj("git", "fetch");
};
