import { describe, expect } from "bun:test";

import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Record as EffectRecord,
  Schema,
  String as EffectString,
} from "effect";

import { itEffect } from "../src/testing/it-effect";

const repositoryRoot = Effect.map(Path.Path, (path) => path.join(import.meta.dirname, ".."));

const Severities = Schema.Record(Schema.String, Schema.Unknown);

// The part of tsconfig.json that holds the compiler's plugins.
const Tsconfig = Schema.Struct({
  compilerOptions: Schema.Struct({
    plugins: Schema.Array(
      Schema.Struct({
        diagnosticSeverity: Schema.optionalKey(Severities),
        name: Schema.String,
      }),
    ),
  }),
});

// The part of the schema @effect/tsgo publishes for its tsconfig entry that names its rules.
const Rule = Schema.Struct({ description: Schema.optionalKey(Schema.String) });
const PluginSchema = Schema.Struct({
  definitions: Schema.Struct({
    effectLanguageServicePluginDiagnosticSeverityDefinition: Schema.Struct({
      properties: Schema.Record(Schema.String, Rule),
    }),
  }),
});

const listConfiguredRules = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repositoryRoot;
  const text = yield* fs.readFileString(path.join(root, "tsconfig.json"));
  // A parse failure is a defect, which fails the test.
  const parsed = yield* Effect.sync(() => Bun.JSONC.parse(text));
  const tsconfig = yield* Schema.decodeUnknownEffect(Tsconfig)(parsed);
  const severities = EffectArray.findFirst(
    tsconfig.compilerOptions.plugins,
    ({ name }) => name === "@effect/language-service",
  ).pipe(
    Option.flatMapNullishOr(({ diagnosticSeverity }) => diagnosticSeverity),
    Option.getOrElse(() => ({})),
  );
  return EffectArray.sort(EffectRecord.keys(severities), Order.String);
});

// The plugin's rules but the deprecated ones. A rule whose description opens with "Deprecated" is
// kept only for configs that still name it.
const listCurrentPluginRules = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repositoryRoot;
  const manifest = Bun.resolveSync("@effect/tsgo/package.json", root);
  const json = yield* fs.readFileString(path.join(path.dirname(manifest), "schema.json"));
  const schema = yield* Schema.decodeEffect(Schema.fromJsonString(PluginSchema))(json);
  const current = EffectArray.filter(
    EffectRecord.toEntries(
      schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition.properties,
    ),
    ([, { description }]) =>
      description === undefined || !EffectString.startsWith("Deprecated")(description),
  );
  return EffectArray.sort(
    EffectArray.map(current, ([name]) => name),
    Order.String,
  );
});

describe("tsconfig.json's Effect diagnostics", () => {
  // A rule the map leaves out runs at the plugin's default, which is on for some, so a rule a new
  // release adds would otherwise run without anyone deciding so. A deprecated rule is left out,
  // since the type check warns on a config that names one.
  itEffect("sets every rule of the plugin but the deprecated ones, and no other", () =>
    Effect.gen(function* () {
      const [configured, rules] = yield* Effect.all([listConfiguredRules, listCurrentPluginRules], {
        concurrency: "unbounded",
      });
      expect(rules.length).toBeGreaterThan(0);

      expect(configured).toStrictEqual(rules);
    }),
  );
});
