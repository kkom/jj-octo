import { Result, Schema } from "effect";

const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/**
 * `value`'s JSON text, as `JSON.stringify` writes it, for a value no schema types, such as a name
 * a jj revset or a message quotes. Throws a `SchemaError` where `JSON.stringify` would throw or
 * write nothing.
 */
export const formatJson = (value: unknown): string => Result.getOrThrow(encodeJson(value));
