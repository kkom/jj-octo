import { describe, expect, it } from "bun:test";
import path from "node:path";

import {
  Array as EffectArray,
  Option,
  Order,
  Record as EffectRecord,
  Result,
  Schema,
  String as EffectString,
} from "effect";

const root = path.join(import.meta.dirname, "..");

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

const listConfiguredRules = async () => {
  const tsconfig = Result.getOrThrow(
    Schema.decodeUnknownResult(Tsconfig)(
      Bun.JSONC.parse(await Bun.file(path.join(root, "tsconfig.json")).text()),
    ),
  );
  const severities = EffectArray.findFirst(
    tsconfig.compilerOptions.plugins,
    ({ name }) => name === "@effect/language-service",
  ).pipe(
    Option.flatMapNullishOr(({ diagnosticSeverity }) => diagnosticSeverity),
    Option.getOrElse(() => ({})),
  );
  return EffectArray.sort(EffectRecord.keys(severities), Order.String);
};

// The plugin's rules but the deprecated ones. A rule whose description opens with "Deprecated" is
// kept only for configs that still name it.
const listCurrentPluginRules = async () => {
  const manifest = Bun.resolveSync("@effect/tsgo/package.json", root);
  const schema = Result.getOrThrow(
    Schema.decodeUnknownResult(PluginSchema)(
      await Bun.file(path.join(path.dirname(manifest), "schema.json")).json(),
    ),
  );
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
};

describe("tsconfig.json's Effect diagnostics", () => {
  // A rule the map leaves out runs at the plugin's default, which is on for some, so a rule a new
  // release adds would otherwise run without anyone deciding so. A deprecated rule is left out,
  // since the type check warns on a config that names one.
  it("sets every rule of the plugin but the deprecated ones, and no other", async () => {
    const [configured, rules] = await Promise.all([
      listConfiguredRules(),
      listCurrentPluginRules(),
    ]);
    expect(rules.length).toBeGreaterThan(0);

    expect(configured).toStrictEqual(rules);
  });
});
