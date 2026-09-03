/* oxlint-disable anti-slop/no-runtime-typeof -- Console warnings are untyped process output; this boundary recognizes only AJV's exact message. */
import {
  fromJsonSchema,
  type JsonSchemaType,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/client";

const ignoredFormatWarning = /^unknown format "[^"]+" ignored in schema at path ".*"$/u;

/** Compile an MCP JSON Schema without leaking AJV's harmless unknown-format warnings into Pi. */
export function compileMcpJsonSchema<T>(schema: JsonSchemaType): StandardSchemaWithJSON<T, T> {
  const warn = console.warn;
  console.warn = (...arguments_) => {
    const [message] = arguments_;
    if (
      arguments_.length === 1 &&
      typeof message === "string" &&
      ignoredFormatWarning.test(message)
    ) {
      return;
    }
    warn(...arguments_);
  };
  try {
    // ponytail: The SDK has no logger hook for its dialect-aware validator; remove this synchronous shim when it adds one.
    return fromJsonSchema<T>(schema);
  } finally {
    console.warn = warn;
  }
}
