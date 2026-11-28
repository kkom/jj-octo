# Language

Applies to all prose. The precision rules also apply to names in code.

## Follow the Google Developer Documentation Style Guide

Above all: active voice, present tense, second person, sentence-case headings, and conditions before instructions.

- ❌ "The migration will be run by the deploy pipeline."
- ✅ "The deploy pipeline runs the migration."

## Use ASD-STE100-derived precision rules

- One idea per sentence, ideally under 20 words.
- One term per concept, and one concept per term.
- Name the actual file, command, type or value, not a category word like "surface".
- Use verbs for what code does (fails, reads), not what it intends (refuses, vouches for).
- No idioms, metaphors or wordplay.

- ❌ "The hook keeps the GraphQL seam honest."
- ✅ "The pre-commit hook regenerates `internal.graphql` and typechecks the frontend against it."

## Apply Zinsser's four principles

From *On Writing Well*: clarity, simplicity, brevity and humanity. Cut background, hedging, repetition and closing summaries, and write as you'd explain it to a colleague.

- ❌ "It's worth noting that, in order to ensure robust and seamless rate limiting, we leverage Valkey."
- ✅ "The rate limiter stores its counters in Valkey."

## Don't use "fence" and "seam" as metaphors

Name the check, boundary or interface itself. This covers "fenced off" and "seamless", but not a literal Markdown code fence.

That's because the metaphors name no file, check or value, so each reader guesses.

- ❌ "Inject the clock at the seam."
- ✅ "Pass the `Clock` service to `createSession` as a parameter."
