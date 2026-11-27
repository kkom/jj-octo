import { describe, expect, it } from "bun:test";
import path from "node:path";

import { Schema } from "effect";

const root = path.join(import.meta.dirname, "..");

// The parts of `.oxlintrc.jsonc` that set rules.
const Rules = Schema.Record(Schema.String, Schema.Unknown);
const Config = Schema.Struct({
  overrides: Schema.optionalKey(Schema.Array(Schema.Struct({ rules: Schema.optionalKey(Rules) }))),
  rules: Schema.optionalKey(Rules),
});

// The part of the schema @effect/tsgo publishes for its oxlint config that names its rules. The
// plugin is native, so it exports no rules a script can import.
const PluginSchema = Schema.Struct({
  definitions: Schema.Struct({ DummyRuleMap: Schema.Struct({ properties: Rules }) }),
});

const listConfiguredRules = async () => {
  const config = Schema.decodeUnknownSync(Config)(
    Bun.JSONC.parse(await Bun.file(path.join(root, ".oxlintrc.jsonc")).text()),
  );
  return new Set(
    [config.rules ?? {}, ...(config.overrides ?? []).map(({ rules }) => rules ?? {})].flatMap(
      (rules) => Object.keys(rules),
    ),
  );
};

const listEffectTsgoRules = async () => {
  const manifest = Bun.resolveSync("@effect/tsgo/package.json", root);
  const schema = Schema.decodeUnknownSync(PluginSchema)(
    await Bun.file(path.join(path.dirname(manifest), "oxlint-schema.json")).json(),
  );
  return Object.keys(schema.definitions.DummyRuleMap.properties).filter((rule) =>
    rule.startsWith("effecttsgo/"),
  );
};

describe(".oxlintrc.jsonc", () => {
  // Every category is "error", which turns on each rule of a native plugin the file lists. So a
  // rule a new @effect/tsgo release adds would turn on without anyone deciding so. Each rule is
  // set, to "error" or to "off", somewhere in the file.
  it("sets every effecttsgo rule, and no rule the plugin lacks", async () => {
    const configured = await listConfiguredRules();
    const exported = new Set(await listEffectTsgoRules());

    expect({
      unknown: [...configured].filter(
        (rule) => rule.startsWith("effecttsgo/") && !exported.has(rule),
      ),
      unset: [...exported].filter((rule) => !configured.has(rule)),
    }).toStrictEqual({ unknown: [], unset: [] });
  });
});
