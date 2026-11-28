import { Result, Schema } from "effect";

const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

/**
 * `JSON.stringify(value)`, for a value no schema types, such as a name a jj revset quotes. Throws a
 * `SchemaError` where `JSON.stringify` would throw or return nothing.
 */
export const formatJson = (value: unknown): string => Result.getOrThrow(encodeJson(value));
