import { Effect } from "effect";

import { type SubmitFailed, submit } from "../cli/gh/stack/push";
import type { GitHub } from "../clients/github/client";
import type { RepositoryClients } from "./scratch-process";
import { ScratchRepository } from "./scratch-repository";

/** Submits the revision, `@` by default, as drafts unless `draft` is false. */
export const submitting = ({
  draft = true,
  overwriteDescriptions = false,
  revision = "@",
}: {
  readonly draft?: boolean;
  readonly overwriteDescriptions?: boolean;
  readonly revision?: string;
} = {}): Effect.Effect<void, SubmitFailed, GitHub | RepositoryClients> =>
  submit(revision, { draft, overwriteDescriptions });

/** Describes `a`, of the pushed stack `a`, `b`, as three paragraphs, and pushes it again. */
export const describeAInParagraphs: Effect.Effect<void, never, ScratchRepository> =
  ScratchRepository.use((repository) =>
    Effect.gen(function* () {
      yield* repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond");
      yield* repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
    }),
  );
