import { Type } from "typebox";
import { Value } from "typebox/value";
import { assembleLspReadText, compactLspText, type LspReadTextBlock } from "./lsp-location-text.js";
import { documentLines, type LspCodePointPosition } from "./lsp-position-encoding.js";
import { formatLspStructureReadBlocks } from "./lsp-structure-text.js";
import { formatLspToolValue } from "./lsp-tool-output.js";

/** Trailing identifier characters: letters, digits, marks, `_`, and `$`. */
const IDENTIFIER_FRAGMENT = /[\p{L}\p{M}\p{N}_$]+$/u;
/** Leading sigils such as `#` or `@`, which the identifier before the position never includes. */
const LEADING_NON_IDENTIFIER = /^[^\p{L}\p{M}\p{N}_$]+/u;

const CompletionItemSchema = Type.Object({
  label: Type.String(),
  kind: Type.Optional(Type.Integer()),
  detail: Type.Optional(Type.String()),
  labelDetails: Type.Optional(
    Type.Object({
      detail: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
  ),
  filterText: Type.Optional(Type.String()),
  sortText: Type.Optional(Type.String()),
});
const CompletionListSchema = Type.Object({
  isIncomplete: Type.Boolean(),
  items: Type.Array(Type.Unknown()),
});
/** `CompletionItemKind` names; the protocol encodes them as numbers. */
const COMPLETION_KIND_NAMES: readonly string[] = [
  "text",
  "method",
  "function",
  "constructor",
  "field",
  "variable",
  "class",
  "interface",
  "module",
  "property",
  "unit",
  "value",
  "enum",
  "keyword",
  "snippet",
  "color",
  "file",
  "reference",
  "folder",
  "enum member",
  "constant",
  "struct",
  "event",
  "operator",
  "type parameter",
];

function completionKindName(kind: number): string {
  return COMPLETION_KIND_NAMES[kind - 1] ?? `kind ${kind}`;
}

/** The identifier fragment that ends just before a one-based position, or "" when none does. */
export function completionPrefixAt(documentText: string, position: LspCodePointPosition): string {
  const line = documentLines(documentText)[position.line - 1] ?? "";
  const before = Array.from(line)
    .slice(0, position.character - 1)
    .join("");
  return IDENTIFIER_FRAGMENT.exec(before)?.[0] ?? "";
}

/** One server's response cut to its limit, and how many matching items were left out. */
export interface LspBoundedItems {
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- The response keeps its protocol shape; only its item list is cut.
  readonly value: unknown;
  readonly omitted: number;
}

/** Options that select the completions one server returns. */
export interface LspCompletionBounds {
  /**
   * Case-insensitive prefix of each item's filter text (its label by default), with or without the
   * text's leading sigils; "" keeps all.
   */
  readonly prefix: string;
  readonly limit: number;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Completion items are opaque until the item schema matches.
function completionSortKey(item: unknown): string {
  if (!Value.Check(CompletionItemSchema, item)) return "";
  return item.sortText ?? item.label;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Completion items are opaque until the item schema matches.
function matchesPrefix(item: unknown, prefix: string): boolean {
  if (prefix === "") return true;
  if (!Value.Check(CompletionItemSchema, item)) return false;
  const text = (item.filterText ?? item.label).toLowerCase();
  const wanted = prefix.toLowerCase();
  return text.startsWith(wanted) || text.replace(LEADING_NON_IDENTIFIER, "").startsWith(wanted);
}

function boundCompletionItems(items: readonly unknown[], bounds: LspCompletionBounds) {
  const matching = items
    .filter((item) => matchesPrefix(item, bounds.prefix))
    .map((item) => ({ item, key: completionSortKey(item) }))
    .sort((left, right) => {
      if (left.key === right.key) return 0;
      return left.key < right.key ? -1 : 1;
    })
    .map(({ item }) => item);
  return {
    items: matching.slice(0, bounds.limit),
    omitted: Math.max(0, matching.length - bounds.limit),
  };
}

/**
 * Keep the completions whose filter text starts with the prefix, ordered by the server's sort
 * text, up to the limit. The response keeps its shape: an item array or a completion list.
 */
export function boundLspCompletions(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A completion response may be an item array, a completion list, or null.
  value: unknown,
  bounds: LspCompletionBounds,
): LspBoundedItems {
  if (Array.isArray(value)) {
    const { items, omitted } = boundCompletionItems(value, bounds);
    return { value: items, omitted };
  }
  if (Value.Check(CompletionListSchema, value)) {
    const { items, omitted } = boundCompletionItems(value.items, bounds);
    return { value: { ...value, items }, omitted };
  }
  return { value, omitted: 0 };
}

/** Keep the first symbols of a workspace-symbol response, in the server's order, up to the limit. */
export function boundLspWorkspaceSymbols(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A workspace-symbol response may be a symbol array or null.
  value: unknown,
  limit: number,
): LspBoundedItems {
  if (!Array.isArray(value)) return { value, omitted: 0 };
  return { value: value.slice(0, limit), omitted: Math.max(0, value.length - limit) };
}

/**
 * Render an item without its server-private `data`, which only the server's resolve request
 * understands.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Unrecognized items are opaque protocol values.
function unrecognizedItemLine(item: unknown): string {
  if (Value.Check(Type.Record(Type.String(), Type.Unknown()), item)) {
    const { data: _data, ...visible } = item;
    return formatLspToolValue(visible);
  }
  return formatLspToolValue(item);
}

/** Render `label (kind)  detail`, like a symbol's `name (kind)`, omitting absent parts. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Completion items are opaque until the item schema matches.
function completionLine(item: unknown): string {
  if (!Value.Check(CompletionItemSchema, item)) return unrecognizedItemLine(item);
  const label = compactLspText(`${item.label}${item.labelDetails?.detail ?? ""}`);
  const head = item.kind === undefined ? label : `${label} (${completionKindName(item.kind)})`;
  const detail = item.detail ?? item.labelDetails?.description;
  return detail === undefined || detail.trim() === "" ? head : `${head}  ${compactLspText(detail)}`;
}

/** One server's bounded completion or workspace-symbol response. */
export interface LspItemListRead {
  readonly server_id: string;
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- Normalized server responses stay opaque; recognized item shapes are checked while rendering.
  readonly value: unknown;
  /** Matching items left out by the limit. */
  readonly omitted: number;
  /** The completion prefix the items were filtered by; workspace symbols have none. */
  readonly prefix?: string | undefined;
}

/** The inputs of one completion or workspace-symbol read's model-visible text. */
export interface LspItemListTextInput {
  readonly operation: "completion" | "workspace_symbols";
  /** Pi's working directory; symbol paths inside it are shown relative to it. */
  readonly cwd: string;
  /** Absolute path of the queried document. */
  readonly documentPath: string;
  readonly reads: readonly LspItemListRead[];
  readonly warnings: readonly string[];
  /** Lines shown before the items, such as the queried position. */
  readonly scope?: readonly string[];
  /** The described queried position, which an empty completion result names. */
  readonly position?: string | undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- A response may be an item array, a completion list, or null; its items stay opaque.
function completionItems(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (Value.Check(CompletionListSchema, value)) return value.items;
  return [];
}

function completionLines(read: LspItemListRead, position: string | undefined): string[] {
  const items = completionItems(read.value);
  const prefix = read.prefix ?? "";
  if (items.length === 0) {
    const empty = prefix === "" ? "No completions" : `No completions start with "${prefix}"`;
    return [position === undefined ? `${empty}.` : `${empty} at ${position}.`];
  }
  const header = prefix === "" ? [] : [`Completions starting with "${prefix}":`];
  const incomplete =
    Value.Check(CompletionListSchema, read.value) && read.value.isIncomplete
      ? ["The server's list is incomplete; a longer prefix may return other items."]
      : [];
  return [...header, ...items.map(completionLine), ...omittedLines(read, "prefix"), ...incomplete];
}

function omittedLines(read: LspItemListRead, refinement: "prefix" | "query"): string[] {
  if (read.omitted === 0) return [];
  return [`${read.omitted} more omitted; raise limit or refine the ${refinement} to see them.`];
}

async function serverBlocks(input: LspItemListTextInput): Promise<readonly LspReadTextBlock[]> {
  if (input.operation === "completion") {
    return input.reads.map((read) => ({
      server_id: read.server_id,
      lines: completionLines(read, input.position),
    }));
  }
  // Workspace symbols read like every other symbol result; only the omitted count is added.
  const blocks = await formatLspStructureReadBlocks({ ...input, operation: "workspace_symbols" });
  return blocks.map((block, index) => {
    const read = input.reads[index];
    return read === undefined
      ? block
      : { ...block, lines: [...block.lines, ...omittedLines(read, "query")] };
  });
}

/**
 * Render bounded completions or workspace symbols with one line per item and named kinds:
 * `label (kind)  detail` for completions, and the shared symbol format `name (kind)
 * path:line:col  in Container` for workspace symbols. Server-private resolve `data` is never
 * shown. The count of matching items left out by the limit follows the items. Results are grouped
 * by server only when more than one server answered, and server failures follow as warnings.
 */
export async function formatLspItemListText(input: LspItemListTextInput): Promise<string> {
  return assembleLspReadText({
    blocks: await serverBlocks(input),
    warnings: input.warnings,
    scope: input.scope ?? [],
  });
}
