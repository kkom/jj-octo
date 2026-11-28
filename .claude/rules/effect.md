---
paths:
  - "**/*.{ts,tsx}"
---

# Effect

`effect` is the standard library here for typed errors, schemas and effectful composition.

## Follow Effect's idiom before designing a pattern

Before you design a pattern of your own, find how Effect solves the problem, and use that. Depart from it only where it can't do the job, and say why beside the code.

That's because Effect's idioms fit its types and its other modules, and a reader who knows Effect already knows them.

- ❌ A module swapped at build time, to give tests a different clock
- ✅ `Clock` provided where the program is run, chosen from the configuration it starts with
- ❌ The current time passed as a parameter through every function, so a test can set it
- ✅ A function that reads `Clock`, and a test that provides its own

## Use the unstable modules too

`effect/*` (http, http-api, cli, …) is in bounds. Unstable means the API may shift between releases, not that it's off limits — a version bump that breaks something shows up as type errors, and that cost is accepted.

## Look in `effect` before writing a helper

Core modules first, then unstable. Base64, schema decoding, HTTP clients, retry policies, command-line parsing, credential parsing: the library ships them, and a hand-rolled copy re-derives edge cases it already handles.

## Prefix a module named after a global

`String`, `Number`, `Array`, `Date`: imported bare, the module shadows the global for the whole file — a type error where the names collide, and a silent bug where they don't.

✅ `import { String as EffectString } from "effect"`

## Retry with a `Schedule`, release with `acquireUseRelease`

- Waiting and retrying: a `Schedule` passed to `Effect.retry`, with `while` naming the failures worth waiting out. ❌ Not a recursive helper counting attempts down.
- Acquire/use/release: `Effect.acquireUseRelease`, which releases once and on interruption. ❌ Not a release repeated across `try` and `catch`.

## Ask for dependencies through the R channel

Yield a `Context.Service` rather than threading a first parameter, so adding a dependency doesn't edit everything between it and the entry point. Provide it once, where the program is run.

## Send outbound HTTP through `HttpClient`

From `effect/http`, with `FetchHttpClient.layer` provided at the entry point.

## Build a CLI with `Command`

From `effect/cli`, run with its runtime's platform services. An invocation the CLI can't make sense of is a `CliError.UserError`, so it's rendered like a bad flag rather than as a thrown stack trace.

## Parse `unknown` with `Schema`

Decoded types are readonly by construction, so they need no wrapper for the readonly-parameters rule.

Code that still validates with another schema library keeps it until it's migrated. ❌ Don't advertise one schema and validate with another.

## Write a test's body as an Effect with `itEffect`

`itEffect` from `src/testing/it-effect.ts` runs the test's effect on bun's runner, in a scope that closes when it ends, with Bun's platform services, a `TestClock` that starts at 0, a `TestConsole` and an empty environment. A failure fails the test. Where bun stops waiting, such as at the test's timeout, the effect is interrupted and its finalizers run. A test with no effect stays a plain `it`.

That's because the test then composes the code under test as production does: it provides layers, and reads a failure as a value. bun's `it.each` spreads an array row, so `itEffect.each` takes object rows.

- ❌ `it("…", async () => { const failure = await Effect.runPromise(Effect.flip(program)); … })`
- ✅ `itEffect("…", () => Effect.gen(function* () { const failure = yield* Effect.flip(program); … }))`
- ✅ `TestClock.adjust` in the test, where the code under test sleeps or repeats on a `Schedule`

## Provide a test's fixtures as layers

`layer(fixture)` from `src/testing/it-effect.ts` defines a `describe` block. Its tests ask for the fixture's services with `yield*`. Each test builds its own fixture, so no two tests share its state. `scratchRepository` and `pushedStack(…)` provide a repository with its git, jj and pull request description clients, and `gitClone()` provides those clients in a plain git clone of its `origin`. A test that needs GitHub merges in `fakeGitHub`. Set up a state that only some tests need inside those tests, such as what `setUpGitHub` gives the fake GitHub. A program that runs in another directory, such as a workspace or a worktree, gets its clients there as a `Context` from `clientsIn`, which `Effect.provide` takes.

That's because the test then gets its fixtures as production code gets its services. `strictEffectProvide` fails a layer provided with `Effect.provide` outside an entry point, and allows a `Context`.

- ❌ `program.pipe(Effect.provide(fixtureLayer))` inside a test
- ✅ `layer(gitHubThroughProxy)("cancelRun", (it) => { it("…", () => Effect.gen(function* () { const outcome = yield* callGitHub(…); … })) })`
- ✅ `const clients = yield* repository.clientsIn(workspace); yield* program.pipe(Effect.provide(clients))`

## Use the real type where Effect code meets other code

If you're tempted to wrap a value in `Promise.resolve`, narrow the type instead. A genuinely asynchronous API is different: its real type is a promise. Convert it with `tryPromise` wherever the call can reject with a failure the caller can act on, and with `Effect.promise` only where every rejection is a defect, leaving the failure channel `never`.
