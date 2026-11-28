import { it, onTestFinished } from "bun:test";

import { Array as EffectArray, Cause, Clock, Effect, Layer, type Scope } from "effect";
import { constVoid } from "effect/Function";
import { TestClock, TestConsole } from "effect/testing";

/** What every test's effect may ask for, besides the layers it provides itself. */
export type TestServices = Scope.Scope | TestClock.TestClock | TestConsole.TestConsole;

const testServices = Layer.mergeAll(TestConsole.layer, TestClock.layer());

/**
 * Sets the `TestClock` to the real time, for a test whose code compares the clock with a time
 * that it can't fake, such as a file's modification time.
 */
export const setTestClockToLiveTime: Effect.Effect<void, never, TestClock.TestClock> =
  TestClock.withLive(Clock.currentTimeMillis).pipe(Effect.flatMap(TestClock.setTime));

/**
 * Runs a test's effect in a scope that closes when it ends, with a `TestClock` that starts at 0
 * and a `TestConsole`. A failure fails the test with its first error, and logs any others the
 * cause holds. Called inside a test: where bun stops waiting for it, such as at its timeout, the
 * effect is interrupted, and the test ends once its finalizers have run.
 */
const runTest = <A, E>(effect: Effect.Effect<A, E, TestServices>): Promise<A> => {
  const controller = new AbortController();
  const promise = Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(testServices),
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

/**
 * A test whose body is an effect, which `runTest` runs. bun:test has no Effect integration, and
 * @effect/vitest's `it.effect` needs vitest's runner.
 */
export const itEffect = Object.assign(
  <A, E>(name: string, body: () => Effect.Effect<A, E, TestServices>): void => {
    it(name, () => runTest(body()));
  },
  {
    /**
     * One test per row, each named from the row's fields as `$field`, as bun's `it.each` names it.
     * A row is an object, since bun's `it.each` spreads an array row into separate arguments.
     */
    each:
      <const Row extends Readonly<Record<string, unknown>>>(rows: readonly Row[]) =>
      <A, E>(name: string, body: (row: Row) => Effect.Effect<A, E, TestServices>): void => {
        it.each([...rows])(name, (row) => runTest(body(row)));
      },
  },
);
