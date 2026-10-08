/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: Model tool arguments and JSON Schemas are untyped JSON by nature. Every read narrows with isEntry/Array.isArray before use, and the table test in test/null-optional-arguments.test.ts exercises each shape. */
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Models trained on tool schemas that declare an optional parameter as `T | null` habitually pass
 * `null` for "not given". Pi validates tool arguments against the declared schema, so a plain
 * `Type.Optional(T)` rejects that `null` and the call fails. The helpers here treat `null` as an
 * omitted optional parameter, before validation, without changing the schema the model sees.
 *
 * Scope, shared by every package so behaviour is identical:
 *
 * - A property is dropped only when its value is `null`, it is not `required`, and its own schema
 *   rejects `null`. Where `null` has a meaning (`Type.Union([T, Type.Null()])`, `Type.Unknown()`),
 *   it is kept. A schema that cannot be evaluated on its own, such as a dangling `$ref`, is kept.
 * - Nested optional properties are normalized too: through `properties`, array `items` and
 *   `prefixItems`, `allOf`, and `anyOf`/`oneOf` branches. Models write `null` for a nested optional
 *   field (a breakpoint's `condition`) as readily as for a top-level one, and a `null` that the
 *   schema rejects can only ever fail the call. A union value that already satisfies a branch is
 *   never rewritten; otherwise the first branch whose normalized value validates is used.
 * - Values of records (`additionalProperties`, `patternProperties`) are left alone: their entries
 *   are not optional parameters, and dropping one would silently change which keys the tool sees.
 * - Required `null`s are never repaired; validation reports them as before.
 */

type Entry = Readonly<Record<string, unknown>>;

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function satisfies(schema: unknown, value: unknown): boolean {
  try {
    // SAFETY: Value.Check accepts any JSON Schema object; a malformed one throws and counts as unsatisfied.
    return Value.Check(schema as TSchema, value);
  } catch {
    return false;
  }
}

/** Whether `null` is a legal value of `schema`; an unevaluable schema counts as legal, keeping `null`. */
function acceptsNull(schema: unknown): boolean {
  // A reference cannot be resolved against its parent here, so it is kept, as Pi's own handling does.
  if (isEntry(schema) && typeof schema.$ref === "string") return true;
  try {
    // SAFETY: Value.Check accepts any JSON Schema object; a malformed one throws and keeps the null.
    return Value.Check(schema as TSchema, null);
  } catch {
    return true;
  }
}

function normalizeUnion(branches: readonly unknown[], value: unknown): unknown {
  if (branches.some((branch) => satisfies(branch, value))) return value;
  for (const branch of branches) {
    const candidate = normalize(branch, value);
    if (candidate !== value && satisfies(branch, candidate)) return candidate;
  }
  return value;
}

function normalizeElements(schema: Entry, items: readonly unknown[]): unknown {
  const { prefixItems, items: itemSchema } = schema;
  const positional = Array.isArray(prefixItems)
    ? prefixItems
    : Array.isArray(itemSchema)
      ? itemSchema
      : [];
  const rest = Array.isArray(itemSchema) ? schema.additionalItems : itemSchema;
  let copy: unknown[] | undefined;
  for (const [index, item] of items.entries()) {
    const normalized = normalize(positional[index] ?? rest, item);
    if (normalized === item) continue;
    copy ??= [...items];
    copy[index] = normalized;
  }
  return copy ?? items;
}

function normalizeProperties(schema: Entry, value: Entry): unknown {
  const { properties } = schema;
  if (!isEntry(properties)) return value;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let copy: Record<string, unknown> | undefined;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const current = value[key];
    if (current === null && !required.has(key) && !acceptsNull(propertySchema)) {
      copy ??= { ...value };
      delete copy[key];
      continue;
    }
    const normalized = normalize(propertySchema, current);
    if (normalized === current) continue;
    copy ??= { ...value };
    copy[key] = normalized;
  }
  return copy ?? value;
}

function normalize(schema: unknown, value: unknown): unknown {
  if (!isEntry(schema)) return value;
  let next = value;
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) next = normalize(member, next);
  }
  for (const union of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(union)) next = normalizeUnion(union, next);
  }
  if (Array.isArray(next)) return normalizeElements(schema, next);
  return isEntry(next) ? normalizeProperties(schema, next) : next;
}

/**
 * `args` with every `null` for an optional parameter of `schema` removed, as if the model had
 * omitted it. Returns `args` itself when nothing changes and never mutates it.
 */
export function omitNullOptionalArguments(schema: unknown, args: unknown): unknown {
  return normalize(schema, args);
}

interface ToolWithParameters {
  readonly parameters: unknown;
  readonly prepareArguments?: (args: unknown) => unknown;
}

/**
 * Make `tool` accept `null` for its optional parameters by normalizing the arguments in
 * `prepareArguments`, which Pi runs before schema validation for model calls and for nested calls
 * from codemode scripts alike. A `prepareArguments` the tool already has runs on the normalized
 * arguments, so it sees optional parameters omitted rather than `null`.
 *
 * Only `prepareArguments` is added: the tool's schema, description, and every other field are
 * unchanged, so the declaration the model sees (and any provider prompt-cache prefix) is stable.
 */
export function acceptNullForOptionalArguments<TTool extends ToolWithParameters>(
  tool: TTool,
): TTool & { readonly prepareArguments: (args: unknown) => unknown } {
  const { parameters, prepareArguments } = tool;
  return {
    ...tool,
    prepareArguments: (args: unknown) => {
      const normalized = omitNullOptionalArguments(parameters, args);
      return prepareArguments === undefined ? normalized : prepareArguments(normalized);
    },
  };
}
