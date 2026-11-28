---
paths:
  - "**/*.{ts,tsx}"
---

# Effect

`effect` is the standard library here.

## Follow Effect's idiom before designing a pattern

Use Effect's own solution. Depart from it only where it can't do the job, and say why beside the code.

That's because Effect readers already know its idioms.

- ❌ The current time passed through every function, so a test can set it
- ✅ A function that reads `Clock`, and a test that provides its own

## Look in `effect` before writing a helper

Check the core modules, then the unstable `effect/*` ones, which are allowed. We accept the cost of their breaking changes.

## Prefix a module named after a global

That's because `String`, `Number`, `Array` or `Date` imported bare shadows the global for the whole file.

- ❌ `import { String } from "effect"`
- ✅ `import { String as EffectString } from "effect"`

## Retry with a `Schedule`, release with `acquireUseRelease`

- ❌ A recursive helper that counts attempts down
- ✅ `Effect.retry` with a `Schedule` whose `while` names the failures worth waiting out
- ❌ A release repeated in `try` and `catch`
- ✅ `Effect.acquireUseRelease`

## Ask for dependencies through the R channel

Yield a `Context.Service`, and provide it once, where the program runs.

That's because a new dependency then doesn't edit every function between it and the entry point.

## Use `effect/http` and `effect/cli`

Send HTTP through `HttpClient`, with `FetchHttpClient.layer` provided at the entry point. Build the CLI with `Command`, and fail an invocation it can't parse with a `CliError.UserError`, which prints like a bad flag.

## Parse `unknown` with `Schema`

❌ Don't advertise one schema library and validate with another.

## Write a test's body as an Effect with `itEffect`

Use `itEffect` from `src/testing/it-effect.ts`, and `TestClock.adjust` where the code sleeps. A test with no effect stays a plain `it`.

That's because the test then composes the code as production does.

- ❌ `it("…", async () => { const failure = await Effect.runPromise(Effect.flip(program)); … })`
- ✅ `itEffect("…", () => Effect.gen(function* () { const failure = yield* Effect.flip(program); … }))`

## Provide a test's fixtures as layers

Define the tests in a `layer(fixture)` block, with a fixture from `src/testing/`. For another directory, such as a workspace, provide the `Context` that `clientsIn` returns. Set up state that only some tests need inside those tests.

That's because the test then gets fixtures as production gets services, and `strictEffectProvide` fails a layer passed to `Effect.provide` outside an entry point.

- ❌ `program.pipe(Effect.provide(fixtureLayer))` inside a test
- ✅ `layer(gitHubThroughProxy)("cancelRun", (it) => { it("…", () => Effect.gen(function* () { const outcome = yield* callGitHub(…); … })) })`

## Use the real type where Effect code meets other code

Narrow the type rather than wrap a value in `Promise.resolve`. Convert a promise with `tryPromise` where the caller can act on its rejection, and with `Effect.promise` only where every rejection is a defect.
