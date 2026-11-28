import { ConfigProvider, Effect, type Layer } from "effect";

const holding = (env: Readonly<Record<string, string>>) =>
  // `fromEnv` takes a mutable record.
  ConfigProvider.fromEnv({ env: { ...env } });

/**
 * An environment holding only `env`, so whatever the tests run in can't change what the code
 * reads through `Config`.
 */
export const environment = (env: Readonly<Record<string, string>> = {}): Layer.Layer<never> =>
  ConfigProvider.layer(holding(env));

/** Runs the effect in an environment holding only `env`, as `environment` does. */
export const withEnvironment =
  (env: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, ConfigProvider.ConfigProvider, holding(env));
