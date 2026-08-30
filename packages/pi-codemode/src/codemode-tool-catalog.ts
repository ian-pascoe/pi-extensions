import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  CODEMODE_SEARCH_TOOL_NAME,
  isCodeModeJsonObject,
  isReservedCodeModeToolName,
  type CodeModeJsonObject,
  type CodeModeJsonValue,
  type CodeModeToolSearchPage,
  type CodeModeToolSearchParameters,
  CodeModeToolSearchParametersSchema,
} from "./codemode-tool-contract.js";

const CODEMODE_CATALOGUE_LIMIT_BYTES = 1024 * 1024;
const CODEMODE_CATALOGUE_TOKEN_BUDGET = 2_000;
const CODEMODE_CATALOGUE_GROUP_SUMMARY_TOKEN_BUDGET = 256;
const CODEMODE_JSDOC_LIMIT_BYTES = 2 * 1024;
const CODEMODE_GROUP_LIMIT_BYTES = 512;
const CODEMODE_SCHEMA_DEPTH_LIMIT = 16;
const CODEMODE_SEARCH_DEFAULT_LIMIT = 10;
const CODEMODE_SEARCH_INDEX_LIMIT_BYTES = 8 * 1024;
const CODEMODE_SEARCH_RESULT_LIMIT_BYTES = 1024 * 1024;

/** A structural JSON Schema document accepted from TypeBox or another producer. */
export type CodeModeToolSchema = boolean | object;

/** One CodeMode-callable Pi tool and its structural input/output schemas. */
export type CodeModeToolCatalogueTool = {
  readonly name: string;
  /** Stable display-only source group; it never changes the exact flat tool name. */
  readonly group: string;
  readonly inputSchema: CodeModeToolSchema;
  readonly outputSchema?: CodeModeToolSchema;
  readonly description?: string;
};

/** One complete declaration retained for progressive CodeMode tool search. */
export type CodeModeToolSearchEntry = {
  readonly name: string;
  readonly group: string;
  readonly description?: string;
  readonly declaration: string;
  /** Pre-normalized bounded terms used only by the parent-side search index. */
  readonly searchIndex?: string;
};

/** A bounded inline catalogue plus every searchable complete declaration. */
export type CodeModeToolCatalogueResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly complete: boolean;
      readonly shownCount: number;
      readonly totalCount: number;
      readonly searchEntries: readonly CodeModeToolSearchEntry[];
    }
  | { readonly ok: false; readonly reason: "catalogue-exceeds-outer-limit" };

/** Successfully rendered progressive CodeMode tool catalogue. */
export type CodeModeToolCatalogue = Extract<CodeModeToolCatalogueResult, { readonly ok: true }>;

/** Expected progressive declaration search outcome at the guest input boundary. */
export type CodeModeToolSearchResult =
  | { readonly ok: true; readonly page: CodeModeToolSearchPage }
  | { readonly ok: false; readonly code: "validation" | "serialization"; readonly message: string };

type ParsedCodeModeToolSchema = boolean | CodeModeJsonObject;
type RenderedTool = {
  readonly name: string;
  readonly group: string;
  readonly description: string | undefined;
  readonly input: string;
  readonly output: string;
};
const JsonStringSchema = Type.String();
const JsonNumberSchema = Type.Number();
const JsonBooleanSchema = Type.Boolean();
const StructuralJsonObjectSchema = Type.Object({}, { additionalProperties: true });

function isJsonString(value: CodeModeJsonValue): value is string {
  return Value.Check(JsonStringSchema, value);
}

function parseStructuralJsonValue(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: This is the catalogue's sole structural JSON ingress; the TypeBox, non-TypeBox, and boolean-schema test proves supported producers remain accepted without invoking schema accessors.
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): CodeModeJsonValue | undefined {
  if (depth > CODEMODE_SCHEMA_DEPTH_LIMIT * 4) return undefined;
  if (value === null) return null;
  if (Value.Check(JsonStringSchema, value) || Value.Check(JsonBooleanSchema, value)) return value;
  if (Value.Check(JsonNumberSchema, value)) return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      const output: CodeModeJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) return undefined;
        const item = parseStructuralJsonValue(descriptor.value, seen, depth + 1);
        if (item === undefined) return undefined;
        output.push(item);
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
  if (!Value.Check(StructuralJsonObjectSchema, value) || seen.has(value)) return undefined;
  seen.add(value);
  try {
    const output: Array<readonly [string, CodeModeJsonValue]> = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const property = parseStructuralJsonValue(descriptor.value, seen, depth + 1);
      if (property !== undefined) output.push([key, property]);
    }
    return Object.fromEntries(output);
  } finally {
    seen.delete(value);
  }
}

function isStructuralJsonObject(value: CodeModeJsonValue | undefined): value is CodeModeJsonObject {
  return Value.Check(StructuralJsonObjectSchema, value);
}

function schemaRecord(value: CodeModeJsonValue | undefined): CodeModeJsonObject | undefined {
  return value !== undefined && isCodeModeJsonObject(value) ? value : undefined;
}

function quotedName(name: string): string {
  return JSON.stringify(name);
}

function boundedDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  let output = "";
  let bytes = 0;
  for (const character of description) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > CODEMODE_JSDOC_LIMIT_BYTES) break;
    output += character;
    bytes += characterBytes;
  }
  return output.replaceAll("*/", "*\\/");
}

function boundedGroup(group: string): string {
  let output = "";
  let bytes = 0;
  for (const character of group) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > CODEMODE_GROUP_LIMIT_BYTES) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function boundedSearchIndex(value: string): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > CODEMODE_SEARCH_INDEX_LIMIT_BYTES) break;
    output += character;
    bytes += characterBytes;
  }
  return normalizeSearchText(output);
}

function jsdoc(description: string | undefined): string {
  if (description === undefined || description.length === 0) return "";
  return `  /** ${description.replaceAll("\n", " ")} */\n`;
}

function schemaType(
  schema: CodeModeJsonValue | undefined,
  root: CodeModeJsonObject | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  if (depth > CODEMODE_SCHEMA_DEPTH_LIMIT) return "unknown";
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  const record = schemaRecord(schema);
  if (record === undefined) return "unknown";

  const reference = record.$ref;
  if (reference !== undefined && isJsonString(reference)) {
    const referenced = resolveLocalReference(reference, root);
    if (referenced === undefined || seen.has(reference)) return "unknown";
    return schemaType(referenced, root, new Set([...seen, reference]), depth + 1);
  }

  const constant = record.const;
  if (Object.hasOwn(record, "const") && constant !== undefined) {
    return JSON.stringify(constant) ?? "unknown";
  }
  const enumValues = Array.isArray(record.enum)
    ? record.enum.map((value) => JSON.stringify(value))
    : undefined;
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
    const types = type.filter(isJsonString);
    return types.length === type.length && types.length > 0
      ? types
          .map((entry) => primitiveOrStructuredType(entry, record, root, seen, depth))
          .join(" | ")
      : "unknown";
  }
  return type !== undefined && isJsonString(type)
    ? primitiveOrStructuredType(type, record, root, seen, depth)
    : hasObjectKeywords(record)
      ? objectType(record, root, seen, depth)
      : hasArrayKeywords(record)
        ? arrayType(record, root, seen, depth)
        : "unknown";
}

function resolveLocalReference(
  reference: string,
  root: CodeModeJsonObject | undefined,
): CodeModeJsonValue | undefined {
  if (root === undefined || !reference.startsWith("#/$defs/")) return undefined;
  const name = reference.slice("#/$defs/".length);
  if (name.length === 0 || name.includes("/")) return undefined;
  const definitions = schemaRecord(root.$defs);
  return definitions?.[name];
}

function unionType(
  value: CodeModeJsonValue | undefined,
  root: CodeModeJsonObject | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((entry) => schemaType(entry, root, seen, depth + 1)).join(" | ");
}

function intersectionType(
  value: CodeModeJsonValue | undefined,
  root: CodeModeJsonObject | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((entry) => schemaType(entry, root, seen, depth + 1)).join(" & ");
}

function primitiveOrStructuredType(
  type: string,
  record: CodeModeJsonObject,
  root: CodeModeJsonObject | undefined,
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
    case "undefined":
      return "undefined";
    case "object":
      return objectType(record, root, seen, depth);
    case "array":
      return arrayType(record, root, seen, depth);
    default:
      return "unknown";
  }
}

function hasObjectKeywords(record: CodeModeJsonObject): boolean {
  return (
    Object.hasOwn(record, "properties") ||
    Object.hasOwn(record, "additionalProperties") ||
    Object.hasOwn(record, "required")
  );
}

function hasArrayKeywords(record: CodeModeJsonObject): boolean {
  return Object.hasOwn(record, "items") || Object.hasOwn(record, "prefixItems");
}

function objectType(
  record: CodeModeJsonObject,
  root: CodeModeJsonObject | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  const properties = schemaRecord(record.properties);
  const required = new Set(
    Array.isArray(record.required) ? record.required.filter(isJsonString) : [],
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
      members.length === 0 && schemaRecord(additional) !== undefined
        ? schemaType(additional, root, seen, depth + 1)
        : "unknown";
    members.push(`readonly [key: string]: ${additionalType};`);
  }
  return members.length === 0 ? "Readonly<Record<string, never>>" : `{ ${members.join(" ")} }`;
}

function arrayType(
  record: CodeModeJsonObject,
  root: CodeModeJsonObject | undefined,
  seen: ReadonlySet<string>,
  depth: number,
): string {
  const prefixItems = record.prefixItems;
  if (Array.isArray(prefixItems)) {
    const tuple = prefixItems.map((item) => schemaType(item, root, seen, depth + 1));
    const items = record.items;
    if (schemaRecord(items) !== undefined || items === true) {
      tuple.push(`...${items === true ? "unknown" : schemaType(items, root, seen, depth + 1)}[]`);
    }
    return `readonly [${tuple.join(", ")}]`;
  }
  return `readonly ${schemaType(record.items, root, seen, depth + 1)}[]`;
}

function renderTool(tool: RenderedTool): string {
  return `${jsdoc(tool.description)}  readonly [${quotedName(tool.name)}]: (input: ${tool.input}) => Promise<PiToolResult<${tool.output}>>;\n`;
}

function isWithinCatalogueLimit(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= CODEMODE_CATALOGUE_LIMIT_BYTES;
}

function renderSchema(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Registered schema metadata is parsed structurally here before catalogue rendering.
  schema: unknown,
): string {
  const parsed = parseStructuralJsonValue(schema);
  const structural: ParsedCodeModeToolSchema | undefined =
    parsed === true || parsed === false || isStructuralJsonObject(parsed) ? parsed : undefined;
  return schemaType(structural, schemaRecord(structural), new Set(), 0);
}

function estimatedTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

type CodeModeToolGroupSelection = {
  readonly group: string;
  readonly tools: readonly RenderedTool[];
  readonly selectedNames: ReadonlySet<string>;
};

function selectInlineToolNames(tools: readonly RenderedTool[]): ReadonlySet<string> {
  const groups = new Map<string, RenderedTool[]>();
  for (const tool of tools) {
    const group = groups.get(tool.group) ?? [];
    group.push(tool);
    groups.set(tool.group, group);
  }
  const queues = [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, groupedTools]) => ({
      group,
      tools: groupedTools
        .map((tool) => ({ tool, declaration: renderTool(tool) }))
        .sort(
          (left, right) =>
            estimatedTokens(left.declaration) - estimatedTokens(right.declaration) ||
            left.tool.name.localeCompare(right.tool.name),
        ),
    }));
  const selected = new Set<string>();
  const selectionOrder: string[] = [];
  let usedTokens = estimatedTokens(renderCatalogue(tools, selected));
  let active = queues.filter(({ tools: groupedTools }) => groupedTools.length > 0);
  while (active.length > 0) {
    const nextActive: typeof active = [];
    for (const queue of active) {
      const candidate = queue.tools[0];
      if (candidate === undefined) continue;
      const cost = estimatedTokens(candidate.declaration);
      if (usedTokens + cost > CODEMODE_CATALOGUE_TOKEN_BUDGET) continue;
      queue.tools.shift();
      selected.add(candidate.tool.name);
      selectionOrder.push(candidate.tool.name);
      usedTokens += cost;
      if (queue.tools.length > 0) nextActive.push(queue);
    }
    active = nextActive;
  }
  while (estimatedTokens(renderCatalogue(tools, selected)) > CODEMODE_CATALOGUE_TOKEN_BUDGET) {
    const removed = selectionOrder.pop();
    if (removed === undefined) break;
    selected.delete(removed);
  }
  return selected;
}

function groupSelections(
  tools: readonly RenderedTool[],
  selectedNames: ReadonlySet<string>,
): readonly CodeModeToolGroupSelection[] {
  const groups = new Map<string, RenderedTool[]>();
  for (const tool of tools) {
    const group = groups.get(tool.group) ?? [];
    group.push(tool);
    groups.set(tool.group, group);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, groupedTools]) => ({
      group,
      tools: groupedTools,
      selectedNames: new Set(
        groupedTools.filter((tool) => selectedNames.has(tool.name)).map((tool) => tool.name),
      ),
    }));
}

function groupSummaryLines(selections: readonly CodeModeToolGroupSelection[]): readonly string[] {
  const lines = ["// Groups:"];
  let shownGroups = 0;
  for (const { group, tools, selectedNames } of selections) {
    const line = `// - ${JSON.stringify(group)}: ${selectedNames.size} of ${tools.length} shown`;
    const remaining = selections.length - shownGroups - 1;
    const candidate = [
      ...lines,
      line,
      ...(remaining > 0 ? [`// - ... ${remaining} more groups`] : []),
    ].join("\n");
    if (estimatedTokens(candidate) > CODEMODE_CATALOGUE_GROUP_SUMMARY_TOKEN_BUDGET) break;
    lines.push(line);
    shownGroups += 1;
  }
  const omittedGroups = selections.length - shownGroups;
  if (omittedGroups > 0) lines.push(`// - ... ${omittedGroups} more groups`);
  return lines;
}

function renderCatalogue(
  tools: readonly RenderedTool[],
  selectedNames: ReadonlySet<string>,
): string {
  const selectedTools = tools.filter((tool) => selectedNames.has(tool.name));
  const complete = selectedTools.length === tools.length;
  const groups = groupSelections(tools, selectedNames);
  const summary = [
    `// CodeMode tool catalogue: ${complete ? "COMPLETE" : "PARTIAL"} (${selectedTools.length} of ${tools.length} declarations shown).`,
    ...(complete
      ? []
      : [
          '// Find omitted tools with tools.codemode_search({ query: "<intent or exact name>" }).',
          "// Call a returned exact flat name with tools[result.name](input); groups are display-only.",
        ]),
    ...groupSummaryLines(groups),
  ].join("\n");
  return `${summary}\n\ntype PiToolResult<Output = unknown> = {\n  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> ;\n  details?: Output;\n};\n\ntype CodeModeToolSearchItem = {\n  readonly name: string;\n  readonly group: string;\n  readonly description?: string;\n  readonly declaration?: string;\n  readonly declarationError?: string;\n};\n\ntype CodeModeToolSearchPage = {\n  readonly items: readonly CodeModeToolSearchItem[];\n  readonly total: number;\n  readonly hasMore: boolean;\n  readonly nextOffset: number | null;\n};\n\ndeclare const tools: Readonly<{\n  /** Search every CodeMode-exposed Pi tool and return complete declarations for exact flat names. */\n  readonly [${quotedName(CODEMODE_SEARCH_TOOL_NAME)}]: (input: { readonly query?: string; readonly group?: string; readonly limit?: number; readonly offset?: number }) => Promise<CodeModeToolSearchPage>;\n${selectedTools.map((tool) => renderTool(tool)).join("")}}>;\n`;
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

function searchTerms(query: string): readonly string[] {
  return normalizeSearchText(query).split(" ").filter(Boolean);
}

function searchScore(entry: CodeModeToolSearchEntry, terms: readonly string[]): number {
  const name = normalizeSearchText(entry.name);
  const group = normalizeSearchText(entry.group);
  const description = normalizeSearchText(entry.description ?? "");
  const declaration = entry.searchIndex ?? boundedSearchIndex(entry.declaration);
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 20;
    else if (name.split(" ").includes(term)) score += 12;
    else if (name.includes(term)) score += 8;
    if (description.includes(term)) score += 4;
    if (group.includes(term)) score += 2;
    if (declaration.includes(term)) score += 1;
  }
  return score;
}

function summarySearchItem(
  entry: CodeModeToolSearchEntry,
): CodeModeToolSearchPage["items"][number] {
  return {
    name: entry.name,
    group: entry.group,
    ...(entry.description !== undefined && { description: entry.description }),
  };
}

function declarationSearchItem(
  entry: CodeModeToolSearchEntry,
): CodeModeToolSearchPage["items"][number] {
  return entry.description === undefined
    ? {
        name: entry.name,
        group: entry.group,
        declaration: entry.declaration,
      }
    : {
        name: entry.name,
        group: entry.group,
        description: entry.description,
        declaration: entry.declaration,
      };
}

function unavailableDeclarationSearchItem(
  entry: CodeModeToolSearchEntry,
): CodeModeToolSearchPage["items"][number] {
  return {
    name: entry.name,
    group: entry.group,
    ...(entry.description !== undefined && { description: entry.description }),
    declarationError: "Complete declaration exceeds the 1 MiB CodeMode search result limit",
  };
}

function createSearchPage(
  ranked: readonly CodeModeToolSearchEntry[],
  input: CodeModeToolSearchParameters,
  includeDeclarations = false,
): CodeModeToolSearchResult {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? CODEMODE_SEARCH_DEFAULT_LIMIT;
  const items: CodeModeToolSearchPage["items"][number][] = [];
  for (const entry of ranked.slice(offset, offset + limit)) {
    let item = includeDeclarations ? declarationSearchItem(entry) : summarySearchItem(entry);
    let nextItems = [...items, item];
    const consumed = offset + nextItems.length;
    let candidate: CodeModeToolSearchPage = {
      items: nextItems,
      total: ranked.length,
      hasMore: consumed < ranked.length,
      nextOffset: consumed < ranked.length ? consumed : null,
    };
    if (
      "declaration" in item &&
      Buffer.byteLength(JSON.stringify(candidate), "utf8") > CODEMODE_SEARCH_RESULT_LIMIT_BYTES
    ) {
      if (items.length > 0) break;
      item = unavailableDeclarationSearchItem(entry);
      nextItems = [...items, item];
      candidate = { ...candidate, items: nextItems };
    }
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > CODEMODE_SEARCH_RESULT_LIMIT_BYTES) {
      return {
        ok: false,
        code: "serialization",
        message: `Pi CodeMode search metadata exceeds the 1 MiB result limit: ${entry.name}`,
      };
    }
    items.push(item);
  }
  const consumed = offset + items.length;
  return {
    ok: true,
    page: {
      items,
      total: ranked.length,
      hasMore: consumed < ranked.length,
      nextOffset: consumed < ranked.length ? consumed : null,
    },
  };
}

/** Searches compact tool summaries and returns a complete declaration only for an exact name. */
export function searchCodeModeToolCatalogue(
  entries: readonly CodeModeToolSearchEntry[],
  input: CodeModeJsonValue,
): CodeModeToolSearchResult {
  if (!Value.Check(CodeModeToolSearchParametersSchema, input)) {
    return {
      ok: false,
      code: "validation",
      message:
        "Pi CodeMode search input must be an object with optional query, group, limit (1-20), and offset fields",
    };
  }
  const scoped =
    input.group === undefined ? entries : entries.filter((entry) => entry.group === input.group);
  const query = input.query?.trim() ?? "";
  const exact = scoped.find(
    (entry) => entry.name === query || `tools[${quotedName(entry.name)}]` === query,
  );
  if (exact !== undefined) return createSearchPage([exact], input, true);
  const terms = searchTerms(query);
  const ranked =
    terms.length === 0
      ? [...scoped].sort((left, right) => left.name.localeCompare(right.name))
      : scoped
          .map((entry) => ({ entry, score: searchScore(entry, terms) }))
          .filter(({ score }) => score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.entry.name.localeCompare(right.entry.name),
          )
          .map(({ entry }) => entry);
  return createSearchPage(ranked, input);
}

/** Renders a token-budgeted inline catalogue and retains complete declarations for search. */
export function renderCodeModeToolCatalogue(
  tools: readonly CodeModeToolCatalogueTool[],
): CodeModeToolCatalogueResult {
  const candidates = tools
    .filter((tool) => !isReservedCodeModeToolName(tool.name))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.group.localeCompare(right.group),
    );
  const unique = candidates.filter(
    (tool, index) => index === 0 || tool.name !== candidates[index - 1]?.name,
  );
  const rendered = unique.map((tool) => ({
    name: tool.name,
    group: boundedGroup(tool.group),
    description: boundedDescription(tool.description),
    input: renderSchema(tool.inputSchema),
    output: renderSchema(tool.outputSchema),
  }));
  const selectedNames = selectInlineToolNames(rendered);
  const text = renderCatalogue(rendered, selectedNames);
  if (!isWithinCatalogueLimit(text)) {
    return { ok: false, reason: "catalogue-exceeds-outer-limit" };
  }
  const searchEntries = rendered.map((tool) => ({
    name: tool.name,
    group: tool.group,
    ...(tool.description !== undefined && { description: tool.description }),
    declaration: renderTool(tool),
    searchIndex: boundedSearchIndex(
      `${tool.name}\n${tool.group}\n${tool.description ?? ""}\n${tool.input}\n${tool.output}`,
    ),
  }));
  return {
    ok: true,
    text,
    complete: selectedNames.size === rendered.length,
    shownCount: selectedNames.size,
    totalCount: rendered.length,
    searchEntries,
  };
}
