import { ConfigProvider, Effect, type Layer } from "effect";

const holding = (env: Readonly<Record<string, string>>) =>
  // `fromEnv` takes a mutable record.
  ConfigProvider.fromEnv({ env: { ...env } });

/** An empty environment, so the tests' own can't change what the code reads through `Config`. */
export const environment: Layer.Layer<never> = ConfigProvider.layer(holding({}));

/** Runs the effect in an environment holding only `env`, in place of `environment`. */
export const withEnvironment =
  (env: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, ConfigProvider.ConfigProvider, holding(env));
