import { describe, it, onTestFinished } from "bun:test";

import { BunServices } from "@effect/platform-bun";
import { Array as EffectArray, Cause, Clock, Effect, Layer, type Scope } from "effect";
import { constVoid } from "effect/Function";
import { TestClock, TestConsole } from "effect/testing";

import { environment } from "./environment";

/** The services every test's fixtures may ask for. */
export type FixtureServices =
  | BunServices.BunServices
  | TestClock.TestClock
  | TestConsole.TestConsole;

/** What every test's effect may ask for, besides the services its fixtures provide. */
export type TestServices = FixtureServices | Scope.Scope;

const testServices = Layer.mergeAll(
  BunServices.layer,
  TestConsole.layer,
  TestClock.layer(),
  environment,
);

/**
 * Sets the `TestClock` to the real time, for a test whose code compares the clock with a time
 * that it can't fake, such as a file's modification time.
 */
export const setTestClockToLiveTime: Effect.Effect<void, never, TestClock.TestClock> =
  TestClock.withLive(Clock.currentTimeMillis).pipe(Effect.flatMap(TestClock.setTime));

/**
 * Runs a test's effect in a scope that closes when it ends, with a `TestClock` that starts at 0, a
 * `TestConsole`, and a fixture built for this test alone. A failure fails the test with its first
 * error, and logs any others the cause holds. Called inside a test: where bun stops waiting for
 * it, such as at its timeout, the effect is interrupted, and the test ends once its finalizers have
 * run.
 */
const runTest = <A, E, R, E2>(
  fixture: Layer.Layer<R, E2, FixtureServices>,
  effect: Effect.Effect<A, E, R | TestServices>,
): Promise<A> => {
  const controller = new AbortController();
  const promise = Effect.runPromise(
    // The fixture is built in the test's scope, so the handler also gets the failures of building
    // and closing it. The test's own finalizers run first, since the scope closes in reverse.
    Layer.build(Layer.provideMerge(fixture, testServices)).pipe(
      Effect.flatMap((services) => Effect.provide(effect, services)),
      Effect.scoped,
      // The test fails with the cause's first error, and the log gets the rest. Rejecting with
      // the cause itself would report its first typed failure, ahead of a defect before it.
      Effect.catchCause((cause) =>
        EffectArray.match(Cause.prettyErrors(cause), {
          onEmpty: () => Effect.failCause(cause),
          onNonEmpty: ([first, ...rest]) =>
            Effect.forEach(rest, Effect.logError, { concurrency: 1, discard: true }).pipe(
              Effect.andThen(Effect.die(first)),
            ),
        }),
      ),
    ),
    { signal: controller.signal },
  );
  onTestFinished(() => {
    controller.abort();
    return promise.then(constVoid, constVoid);
  });
  return promise;
};

/** Defines tests whose bodies are effects that may ask for the services `R`. */
export interface EffectTest<R> {
  <A, E>(name: string, body: () => Effect.Effect<A, E, R | TestServices>): void;
  /**
   * One test per row, each named from the row's fields as `$field`, as bun's `it.each` names it.
   * A row is an object, since bun's `it.each` spreads an array row into separate arguments.
   */
  readonly each: <const Row extends Readonly<Record<string, unknown>>>(
    rows: readonly Row[],
  ) => <A, E>(name: string, body: (row: Row) => Effect.Effect<A, E, R | TestServices>) => void;
}

const effectTest = <R, E2>(fixture: Layer.Layer<R, E2, FixtureServices>): EffectTest<R> =>
  Object.assign(
    <A, E>(name: string, body: () => Effect.Effect<A, E, R | TestServices>): void => {
      it(name, () => runTest(fixture, Effect.suspend(body)));
    },
    {
      each:
        <const Row extends Readonly<Record<string, unknown>>>(rows: readonly Row[]) =>
        <A, E>(name: string, body: (row: Row) => Effect.Effect<A, E, R | TestServices>): void => {
          it.each([...rows])(name, (row) =>
            runTest(
              fixture,
              Effect.suspend(() => body(row)),
            ),
          );
        },
    },
  );

/**
 * A test whose body is an effect, which `runTest` runs. bun:test has no Effect integration, and
 * `@effect/vitest`'s `it.effect` needs vitest's runner.
 */
export const itEffect: EffectTest<never> = effectTest(Layer.empty);

/**
 * A `describe` block whose tests may also ask for what `fixture` provides. Each test builds its
 * own fixture, so no two tests share its state, and closing the test's scope releases it. Unlike
 * `@effect/vitest`'s `layer`, it doesn't build the fixture once for the whole block.
 */
export const layer =
  <ROut, E>(fixture: Layer.Layer<ROut, E, FixtureServices>) =>
  (name: string, tests: (it: EffectTest<ROut>) => void): void => {
    describe(name, () => {
      tests(effectTest(fixture));
    });
  };
