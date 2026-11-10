# Language

Applies to prose everywhere: communication with the user, rules, READMEs, code comments, docstrings, and PR descriptions. The precision rules also apply to names in code.

## Follow the Google Developer Documentation Style Guide

Above all: active voice, present tense, second person, sentence-case headings, and conditions before instructions.

- ❌ "The migration will be run by the deploy pipeline."
- ✅ "The deploy pipeline runs the migration."

## Use ASD-STE100-derived precision rules

Simplified Technical English is written so that instructions can't be misread. Borrow its precision rules:

- One idea per sentence, ideally under 20 words.
- One term per concept, and one concept per term. This applies to names in code too.
- Name the actual file, command, type, or value, not a category word like "surface" or "shape".
- Use verbs that say what code does (fails, reads, raises), not what it intends (refuses, vouches for).
- No idioms, metaphors, or wordplay.

- ❌ "The hook keeps the GraphQL seam honest."
- ✅ "The pre-commit hook regenerates `internal.graphql` and typechecks the frontend against it."
- ❌ `Org`, `Company`, and `Organization` for the same entity
- ✅ `Organization` everywhere

## Apply Zinsser's four principles

From *On Writing Well*:

- **Clarity**: the reader gets the point on the first read.
- **Simplicity**: plain words over impressive ones, and plain claims over aphorisms.
- **Brevity**: cut background, hedging, repetition, and closing summaries.
- **Humanity**: write as you'd explain it to a colleague.

- ❌ "It's worth noting that, in order to ensure robust and seamless rate limiting, we leverage Valkey."
- ✅ "The rate limiter stores its counters in Valkey."

## Don't use "fence" and "seam" as metaphors

Name the check, boundary or interface itself. That covers the words' other forms, such as "fenced off" and "seamless". A term for the literal thing keeps its name, such as a code fence in Markdown.

That's because, used as metaphors, they name no file, check or value, so each reader guesses what they stand for.

- ❌ "The lockfile check is a fence around the release."
- ✅ "`bun install --frozen-lockfile` fails the release when `bun.lock` is out of date."
- ❌ "Inject the clock at the seam."
- ✅ "Pass the `Clock` service to `createSession` as a parameter."
