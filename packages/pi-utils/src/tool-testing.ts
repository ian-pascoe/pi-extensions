/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: Test helpers over arbitrary tool definitions and their untyped JSON arguments; they only compare and serialize values. */
import { validateToolArguments, type JsonValue, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** The part of a Pi tool definition these test helpers read. */
export interface ToolUnderTest {
  readonly name: string;
  readonly parameters: TSchema;
  readonly prepareArguments?: (args: unknown) => unknown;
}

export interface ToolRecorder {
  readonly pi: ExtensionAPI;
  readonly tools: ToolUnderTest[];
}

/**
 * A stand-in for the `ExtensionAPI` handed to an extension factory that records every
 * `registerTool` call in order. Any other `pi.*` method is a no-op that returns `undefined`, so the
 * factory can run without a Pi session.
 */
export function recordToolRegistrations(): ToolRecorder {
  const tools: ToolUnderTest[] = [];
  const pi = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "registerTool"
          ? (tool: ToolUnderTest) => {
              tools.push(tool);
            }
          : () => undefined,
    },
  );
  // SAFETY: The proxy answers every method a factory may call, which a structural type cannot express.
  return { pi: pi as ExtensionAPI, tools };
}

/**
 * `factory` registering every tool without its `prepareArguments`: the extension as it was before
 * it accepted `null` for optional parameters. A test loads both into real Pi sessions and compares
 * what each declares to the model, since only `prepareArguments` may differ.
 */
export function withoutPreparedArguments(factory: ExtensionFactory): ExtensionFactory {
  return (pi) => {
    const plain: ExtensionAPI = Object.create(pi);
    Object.defineProperty(plain, "registerTool", {
      value: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        const { prepareArguments: _omitted, ...rest } = tool;
        pi.registerTool(rest);
      },
    });
    return factory(plain);
  };
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level optional parameters of `schema` that reject `null`, in declaration order. */
export function optionalParametersRejectingNull(schema: TSchema): string[] {
  // SAFETY: Tool parameters are JSON Schema objects; each field is narrowed below before use.
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (!isEntry(properties)) return [];
  const requiredNames = new Set(Array.isArray(required) ? required : []);
  return Object.entries(properties)
    .filter(
      ([name, property]) =>
        !requiredNames.has(name) &&
        !Value.Check(
          // SAFETY: Each property of a tool's parameter schema is itself a schema.
          property as TSchema,
          null,
        ),
    )
    .map(([name]) => name);
}

/** A schema's own value, which JSON Schema keywords such as `const` and `enum` hold as JSON. */
function json(value: unknown): JsonValue {
  // SAFETY: Only called with `const`/`enum` members and values built here, all of them JSON.
  return value as JsonValue;
}

function sample(schema: unknown): JsonValue {
  if (!isEntry(schema)) return null;
  if ("const" in schema) return json(schema.const);
  if (Array.isArray(schema.enum)) return json(schema.enum[0]);
  for (const union of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(union) && union.length > 0) return sample(union[0]);
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((member) => sample(member)));
  }
  switch (schema.type) {
    case "string":
      return "x".repeat(typeof schema.minLength === "number" ? Math.max(1, schema.minLength) : 1);
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return typeof schema.minItems === "number" && schema.minItems > 0
        ? Array.from({ length: schema.minItems }, () => sample(schema.items))
        : [];
    case "object":
      // SAFETY: The schema declares `type: "object"`, so it is a JSON Schema object.
      return sampleRequiredArguments(schema as TSchema);
    default:
      return null;
  }
}

/**
 * A call that sets only the required parameters of `schema`, each to a minimal valid value, so a
 * table over every tool needs no hand-written arguments. Throws when the result does not satisfy
 * the schema; pass explicit arguments for such a tool.
 */
export function sampleRequiredArguments(schema: TSchema): ToolCall["arguments"] {
  // SAFETY: Tool parameters are JSON Schema objects; each field is narrowed below before use.
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  const result: ToolCall["arguments"] = {};
  if (isEntry(properties) && Array.isArray(required)) {
    for (const name of required) {
      if (typeof name === "string") result[name] = sample(properties[name]);
    }
  }
  return result;
}

function prepared(tool: ToolUnderTest, args: ToolCall["arguments"]): string {
  const input = structuredClone(args);
  const prepare = tool.prepareArguments?.(input) ?? input;
  const validated = validateToolArguments(
    { name: tool.name, description: "", parameters: tool.parameters },
    {
      type: "toolCall",
      id: "tool-testing",
      name: tool.name,
      // SAFETY: A tool's prepared arguments are a JSON object, as Pi requires of prepareArguments.
      arguments: prepare as ToolCall["arguments"],
    },
  );
  return JSON.stringify({ prepare, validated });
}

/**
 * Throw unless `tool` treats `null` for each of its optional parameters that reject `null` exactly
 * like omitting it: the same `prepareArguments` output and the same validated arguments. `args`
 * must be a valid call that sets only required parameters; by default it is sampled from the schema.
 * `skip` names optional parameters the call cannot do without, such as one of two exclusive selectors. Returns the parameters it proved, so a
 * test can assert the tool had optional parameters to prove.
 */
export function expectNullOptionalArgumentsOmitted(
  tool: ToolUnderTest,
  args: ToolCall["arguments"] = sampleRequiredArguments(tool.parameters),
  skip: readonly string[] = [],
): string[] {
  if (!Value.Check(tool.parameters, args))
    throw new Error(`${tool.name}: ${JSON.stringify(args)} is not a valid call; pass arguments`);
  const names = optionalParametersRejectingNull(tool.parameters).filter(
    (name) => !skip.includes(name),
  );
  const omitted = prepared(tool, args);
  for (const name of names) {
    const withNull = prepared(tool, { ...args, [name]: null });
    if (withNull !== omitted)
      throw new Error(
        `${tool.name}: null for optional "${name}" differs from omitting it:\n  null:    ${withNull}\n  omitted: ${omitted}`,
      );
  }
  return names;
}

/**
 * The model-visible declaration of each tool, as one JSON string that is compared byte for byte:
 * names, descriptions, and parameter schemas in registration order.
 */
export function toolDeclarations(
  tools: readonly { name: string; description: string; parameters: unknown }[],
): string {
  return JSON.stringify(
    tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    undefined,
    2,
  );
}
