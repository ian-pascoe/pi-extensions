/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- This module is the deliberately structural JSON Schema parser boundary; JSON Schema values have no closed TypeScript shape and are refined before rendering. */
import { Buffer } from "node:buffer";
import { isReservedCodeModeToolName } from "./codemode-tool-contract.js";

const CODEMODE_CATALOGUE_LIMIT_BYTES = 1024 * 1024;
const CODEMODE_JSDOC_LIMIT_BYTES = 2 * 1024;
const CODEMODE_SCHEMA_DEPTH_LIMIT = 16;

/** One CodeMode-callable Pi tool and its untrusted structural input schema. */
export type CodeModeToolCatalogueTool = {
  readonly name: string;
  readonly inputSchema: unknown;
  readonly description?: string;
};

/** A complete catalogue or an explicit refusal before exposure changes. */
export type CodeModeToolCatalogueResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "names-exceed-catalogue-limit" };

type SchemaRecord = Readonly<Record<string, unknown>>;
type RenderedTool = {
  readonly name: string;
  readonly description: string | undefined;
  readonly input: string;
};
type CodeModeCatalogueDescriptionMode = "include-descriptions" | "omit-descriptions";

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaRecord(value: unknown): SchemaRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function jsonLiteral(value: unknown): string | undefined {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? undefined : rendered;
  } catch {
    return undefined;
  }
}

function quotedName(name: string): string {
  return JSON.stringify(name);
}

function boundedDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  let output = "";
  for (const character of description) {
    if (Buffer.byteLength(output + character, "utf8") > CODEMODE_JSDOC_LIMIT_BYTES) break;
    output += character;
  }
  return output.replaceAll("*/", "*\\/");
}

function jsdoc(description: string | undefined): string {
  if (description === undefined || description.length === 0) return "";
  return `  /** ${description.replaceAll("\n", " ")} */\n`;
}

function schemaType(
  schema: unknown,
  root: SchemaRecord | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  if (depth > CODEMODE_SCHEMA_DEPTH_LIMIT) return "unknown";
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  const record = schemaRecord(schema);
  if (record === undefined) return "unknown";

  const reference = record.$ref;
  if (typeof reference === "string") {
    const referenced = resolveLocalReference(reference, root);
    if (referenced === undefined || seen.has(reference)) return "unknown";
    return schemaType(referenced, root, new Set([...seen, reference]), depth + 1);
  }

  if (Object.hasOwn(record, "const")) return jsonLiteral(record.const) ?? "unknown";
  const enumValues = Array.isArray(record.enum) ? record.enum.map(jsonLiteral) : undefined;
  if (
    enumValues !== undefined &&
    enumValues.length > 0 &&
    enumValues.every((value) => value !== undefined)
  ) {
    return enumValues.join(" | ");
  }

  const union =
    unionType(record.anyOf, root, seen, depth) ?? unionType(record.oneOf, root, seen, depth);
  if (union !== undefined) return union;
  const intersection = intersectionType(record.allOf, root, seen, depth);
  if (intersection !== undefined) return intersection;

  const type = record.type;
  if (Array.isArray(type)) {
    const types = type.filter((entry): entry is string => typeof entry === "string");
    return types.length === type.length && types.length > 0
      ? types
          .map((entry) => primitiveOrStructuredType(entry, record, root, seen, depth))
          .join(" | ")
      : "unknown";
  }
  return typeof type === "string"
    ? primitiveOrStructuredType(type, record, root, seen, depth)
    : hasObjectKeywords(record)
      ? objectType(record, root, seen, depth)
      : hasArrayKeywords(record)
        ? arrayType(record, root, seen, depth)
        : "unknown";
}

function resolveLocalReference(reference: string, root: SchemaRecord | undefined): unknown {
  if (root === undefined || !reference.startsWith("#/$defs/")) return undefined;
  const name = reference.slice("#/$defs/".length);
  if (name.length === 0 || name.includes("/")) return undefined;
  const definitions = schemaRecord(root.$defs);
  return definitions?.[name];
}

function unionType(
  value: unknown,
  root: SchemaRecord | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((entry) => schemaType(entry, root, seen, depth + 1)).join(" | ");
}

function intersectionType(
  value: unknown,
  root: SchemaRecord | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((entry) => schemaType(entry, root, seen, depth + 1)).join(" & ");
}

function primitiveOrStructuredType(
  type: string,
  record: SchemaRecord,
  root: SchemaRecord | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object":
      return objectType(record, root, seen, depth);
    case "array":
      return arrayType(record, root, seen, depth);
    default:
      return "unknown";
  }
}

function hasObjectKeywords(record: SchemaRecord): boolean {
  return (
    Object.hasOwn(record, "properties") ||
    Object.hasOwn(record, "additionalProperties") ||
    Object.hasOwn(record, "required")
  );
}

function hasArrayKeywords(record: SchemaRecord): boolean {
  return Object.hasOwn(record, "items") || Object.hasOwn(record, "prefixItems");
}

function objectType(
  record: SchemaRecord,
  root: SchemaRecord | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  const properties = schemaRecord(record.properties);
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const members = Object.entries(properties ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, property]) =>
        `readonly [${quotedName(name)}]${required.has(name) ? "" : "?"}: ${schemaType(property, root, seen, depth + 1)};`,
    );
  const additional = record.additionalProperties;
  if (additional !== false) {
    const additionalType =
      members.length === 0 && isRecord(additional)
        ? schemaType(additional, root, seen, depth + 1)
        : "unknown";
    members.push(`readonly [key: string]: ${additionalType};`);
  }
  return members.length === 0 ? "Readonly<Record<string, never>>" : `{ ${members.join(" ")} }`;
}

function arrayType(
  record: SchemaRecord,
  root: SchemaRecord | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  const prefixItems = record.prefixItems;
  if (Array.isArray(prefixItems)) {
    const tuple = prefixItems.map((item) => schemaType(item, root, seen, depth + 1));
    const items = record.items;
    if (isRecord(items) || items === true) {
      tuple.push(`...${items === true ? "unknown" : schemaType(items, root, seen, depth + 1)}[]`);
    }
    return `readonly [${tuple.join(", ")}]`;
  }
  return `readonly ${schemaType(record.items, root, seen, depth + 1)}[]`;
}

function renderTool(tool: RenderedTool, descriptionMode: CodeModeCatalogueDescriptionMode): string {
  return `${descriptionMode === "include-descriptions" ? jsdoc(tool.description) : ""}  readonly [${quotedName(tool.name)}]: (input: ${tool.input}) => Promise<PiToolResult>;\n`;
}

function renderCatalogue(
  tools: readonly RenderedTool[],
  descriptionMode: CodeModeCatalogueDescriptionMode,
): string {
  return `type PiToolResult = {\n  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> ;\n  details?: unknown;\n};\n\ndeclare const tools: Readonly<{\n${tools.map((tool) => renderTool(tool, descriptionMode)).join("")}}>;\n`;
}

function isWithinCatalogueLimit(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= CODEMODE_CATALOGUE_LIMIT_BYTES;
}

/** Renders all guest-callable names once or refuses a name-only overflow. */
export function renderCodeModeToolCatalogue(
  tools: readonly CodeModeToolCatalogueTool[],
): CodeModeToolCatalogueResult {
  const candidates = tools
    .filter((tool) => !isReservedCodeModeToolName(tool.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const unique = candidates.filter(
    (tool, index) => index === 0 || tool.name !== candidates[index - 1]?.name,
  );
  const rendered = unique.map((tool) => ({
    name: tool.name,
    description: boundedDescription(tool.description),
    input: schemaType(tool.inputSchema, schemaRecord(tool.inputSchema), new Set(), 0),
  }));

  let text = renderCatalogue(rendered, "include-descriptions");
  if (isWithinCatalogueLimit(text)) return { ok: true, text };

  const simplified = [...rendered];
  const schemaOrder = simplified
    .map((tool, index) => ({
      index,
      bytes: Buffer.byteLength(tool.input, "utf8"),
      name: tool.name,
    }))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  for (const candidate of schemaOrder) {
    const current = simplified[candidate.index];
    if (current === undefined) continue;
    simplified[candidate.index] = { ...current, input: "unknown" };
    text = renderCatalogue(simplified, "include-descriptions");
    if (isWithinCatalogueLimit(text)) return { ok: true, text };
  }

  text = renderCatalogue(simplified, "omit-descriptions");
  return isWithinCatalogueLimit(text)
    ? { ok: true, text }
    : { ok: false, reason: "names-exceed-catalogue-limit" };
}
