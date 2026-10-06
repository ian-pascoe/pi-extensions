import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  assembleLspReadText,
  compactLspText,
  formatLspLocationLine,
  lspDisplayPath,
  lspDisplayPosition,
  LspNormalizedPositionSchema,
  LspSourceLines,
  type LspRead,
  type LspReadTextBlock,
} from "./lsp-location-text.js";
import type { LspCodePointPosition } from "./lsp-position-encoding.js";
import type { LspOperationName } from "./lsp-tool-contract.js";
import { formatLspToolValue } from "./lsp-tool-output.js";

const STRUCTURE_OPERATIONS = [
  "document_symbols",
  "workspace_symbols",
  "call_hierarchy",
  "incoming_calls",
  "outgoing_calls",
  "type_hierarchy",
  "supertypes",
  "subtypes",
  "selection_ranges",
  "folding_ranges",
] as const satisfies readonly LspOperationName[];

/** Read operations whose model-visible text lists symbols, hierarchy items, or ranges (ADR-0003: derived from the Structured Result). */
export type LspStructureOperation = (typeof STRUCTURE_OPERATIONS)[number];

const STRUCTURE_OPERATION_SET: ReadonlySet<LspOperationName> = new Set(STRUCTURE_OPERATIONS);

/** Report whether an operation's model-visible text uses the readable structure format. */
export function isLspStructureOperation(
  operation: LspOperationName,
): operation is LspStructureOperation {
  return STRUCTURE_OPERATION_SET.has(operation);
}

/** `SymbolKind` names; the protocol encodes them as numbers starting at 1. */
const SYMBOL_KIND_NAMES = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
] as const;

/** `SymbolTag.Deprecated`, the only symbol tag the protocol defines. */
const DEPRECATED_SYMBOL_TAG = 1;

const RangeSchema = Type.Object({
  start: LspNormalizedPositionSchema,
  end: LspNormalizedPositionSchema,
});
const OptionalTextSchema = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const SymbolFieldsSchema = Type.Object({
  name: Type.String(),
  kind: Type.Integer(),
  tags: Type.Optional(Type.Union([Type.Array(Type.Integer()), Type.Null()])),
  deprecated: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  detail: OptionalTextSchema,
});
const DocumentSymbolSchema = Type.Intersect([
  SymbolFieldsSchema,
  Type.Object({
    selectionRange: RangeSchema,
    children: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()])),
  }),
]);
const SymbolInformationSchema = Type.Intersect([
  SymbolFieldsSchema,
  Type.Object({
    containerName: OptionalTextSchema,
    location: Type.Object({ uri: Type.String(), range: Type.Optional(RangeSchema) }),
  }),
]);
const HierarchyItemSchema = Type.Intersect([
  SymbolFieldsSchema,
  Type.Object({ uri: Type.String(), selectionRange: RangeSchema }),
]);
const IncomingCallSchema = Type.Object({
  from: HierarchyItemSchema,
  fromRanges: Type.Array(RangeSchema),
});
const OutgoingCallSchema = Type.Object({
  to: HierarchyItemSchema,
  fromRanges: Type.Array(RangeSchema),
});
const SelectionRangeSchema = Type.Object({
  range: RangeSchema,
  parent: Type.Optional(Type.Unknown()),
});
const FoldingRangeSchema = Type.Object({
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  kind: OptionalTextSchema,
});

type SymbolFields = Static<typeof SymbolFieldsSchema>;
/** A normalized outgoing call, as the model-visible text reads it. */
export type LspTextOutgoingCall = Static<typeof OutgoingCallSchema>;
type Range = Static<typeof RangeSchema>;

/** The inputs of one structure read's model-visible text. */
export interface LspStructureReadTextInput {
  readonly operation: LspStructureOperation;
  /** Pi's working directory; paths inside it are shown relative to it. */
  readonly cwd: string;
  /** Absolute path of the queried document, which document symbols, call sites, and ranges refer to. */
  readonly documentPath: string;
  readonly reads: readonly LspRead[];
  readonly warnings: readonly string[];
  /** Requested selection-range positions, which head each list when there are several. */
  readonly positions?: readonly LspCodePointPosition[] | undefined;
  /**
   * The file of an outgoing call's sites: the prepared item it was requested for, as a path or a
   * non-`file:` URI. Without one, the sites are placed in the queried document.
   */
  readonly outgoingCallSitePath?: (call: LspTextOutgoingCall) => string | undefined;
  /** Lines shown before the items, such as the queried position. */
  readonly scope?: readonly string[];
  /** The line shown for a server that found nothing, replacing the operation's default. */
  readonly emptyMessage?: ((read: LspRead) => string) | undefined;
}

/** Shared rendering state of one read. */
interface RenderContext {
  readonly input: LspStructureReadTextInput;
  readonly sources: LspSourceLines;
}

/** Name a protocol `SymbolKind`, or `kind N` for a number outside its named values. */
export function lspSymbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind - 1] ?? `kind ${kind}`;
}

/** Render `name (kind[, deprecated]) location[  suffix]`. */
function symbolLine(symbol: SymbolFields, location: string, suffix?: string | null): string {
  const deprecated = symbol.deprecated === true || symbol.tags?.includes(DEPRECATED_SYMBOL_TAG);
  const kind = deprecated
    ? `${lspSymbolKindName(symbol.kind)}, deprecated`
    : lspSymbolKindName(symbol.kind);
  const head = `${compactLspText(symbol.name)} (${kind}) ${location}`;
  const extra = suffix === undefined || suffix === null ? "" : compactLspText(suffix);
  return extra === "" ? head : `${head}  ${extra}`;
}

function rangePosition(path: string, range: Range) {
  return { path, line: range.start.line, character: range.start.character };
}

function documentSymbolLines(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Document symbol children are opaque until each matches the symbol schema.
  value: unknown,
  context: RenderContext,
  depth: number,
): string[] | undefined {
  if (!Value.Check(DocumentSymbolSchema, value)) return undefined;
  const location = lspDisplayPosition(
    context.input.cwd,
    rangePosition(context.input.documentPath, value.selectionRange),
  );
  const lines = [`${"  ".repeat(depth)}${symbolLine(value, location, value.detail)}`];
  for (const child of value.children ?? []) {
    const childLines = documentSymbolLines(child, context, depth + 1);
    if (childLines === undefined) return undefined;
    lines.push(...childLines);
  }
  return lines;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A symbol response item is opaque until it matches a symbol schema.
function symbolLines(item: unknown, context: RenderContext): string[] | undefined {
  if (Value.Check(SymbolInformationSchema, item)) {
    const { uri, range } = item.location;
    const location =
      range === undefined
        ? lspDisplayPath(context.input.cwd, uri)
        : lspDisplayPosition(context.input.cwd, rangePosition(uri, range));
    const container =
      item.containerName === undefined || item.containerName === null || item.containerName === ""
        ? undefined
        : `in ${item.containerName}`;
    return [symbolLine(item, location, container)];
  }
  return documentSymbolLines(item, context, 0);
}

function hierarchyItemLine(item: Static<typeof HierarchyItemSchema>, cwd: string): string {
  return symbolLine(
    item,
    lspDisplayPosition(cwd, rangePosition(item.uri, item.selectionRange)),
    item.detail,
  );
}

async function callLines(
  item: Static<typeof HierarchyItemSchema>,
  sitePath: string,
  sites: readonly Range[],
  context: RenderContext,
): Promise<string[]> {
  const siteLines = await Promise.all(
    sites.map((site) =>
      formatLspLocationLine(rangePosition(sitePath, site), context.input.cwd, context.sources),
    ),
  );
  return [hierarchyItemLine(item, context.input.cwd), ...siteLines.map((line) => `  ${line}`)];
}

async function hierarchyLines(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A hierarchy response item is opaque until it matches the operation's schema.
  item: unknown,
  context: RenderContext,
): Promise<string[] | undefined> {
  switch (context.input.operation) {
    case "incoming_calls":
      // An incoming call's sites lie in its caller's file.
      if (!Value.Check(IncomingCallSchema, item)) return undefined;
      return callLines(item.from, item.from.uri, item.fromRanges, context);
    case "outgoing_calls":
      // An outgoing call's sites lie in the prepared item's file.
      if (!Value.Check(OutgoingCallSchema, item)) return undefined;
      return callLines(
        item.to,
        context.input.outgoingCallSitePath?.(item) ?? context.input.documentPath,
        item.fromRanges,
        context,
      );
    default:
      if (!Value.Check(HierarchyItemSchema, item)) return undefined;
      return [hierarchyItemLine(item, context.input.cwd)];
  }
}

function formatRange(range: Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

/** One selection range and its ancestors, innermost first. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Each nested parent is opaque until it matches the selection-range schema.
function selectionRangeChain(value: unknown): string[] | undefined {
  const lines: string[] = [];
  let current = value;
  while (current !== undefined && current !== null) {
    if (!Value.Check(SelectionRangeSchema, current)) return undefined;
    lines.push(formatRange(current.range));
    current = current.parent;
  }
  return lines;
}

function selectionRangeLines(
  items: readonly unknown[],
  context: RenderContext,
): string[] | undefined {
  const chains = items.map(selectionRangeChain);
  if (!chains.every((chain) => chain !== undefined)) return undefined;
  if (chains.length === 1) return chains[0];
  const positions = context.input.positions;
  return chains.flatMap((chain, index) => {
    const position = positions?.length === chains.length ? positions[index] : undefined;
    const header =
      position === undefined ? `Position ${index + 1}:` : `${position.line}:${position.character}:`;
    return [header, ...chain.map((line) => `  ${line}`)];
  });
}

async function foldingRangeLine(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A folding-range item is opaque until it matches the folding-range schema.
  item: unknown,
  context: RenderContext,
): Promise<string | undefined> {
  if (!Value.Check(FoldingRangeSchema, item)) return undefined;
  const lines = `${item.startLine}-${item.endLine}`;
  const head = item.kind === undefined || item.kind === null ? lines : `${lines} ${item.kind}`;
  const source = await context.sources.line(context.input.documentPath, item.startLine);
  return source === undefined ? head : `${head}  ${source}`;
}

/** Lines of one server's items, or undefined when any item is not of the operation's shape. */
async function itemLines(
  items: readonly unknown[],
  context: RenderContext,
): Promise<readonly string[] | undefined> {
  const { operation } = context.input;
  let rendered: readonly (readonly string[] | undefined)[];
  switch (operation) {
    case "document_symbols":
    case "workspace_symbols":
      rendered = items.map((item) => symbolLines(item, context));
      break;
    case "selection_ranges":
      return selectionRangeLines(items, context);
    case "folding_ranges":
      rendered = await Promise.all(
        items.map(async (item) => {
          const line = await foldingRangeLine(item, context);
          return line === undefined ? undefined : [line];
        }),
      );
      break;
    default:
      rendered = await Promise.all(items.map((item) => hierarchyLines(item, context)));
  }
  return rendered.every((lines) => lines !== undefined) ? rendered.flat() : undefined;
}

function emptyMessage(operation: LspStructureOperation): string {
  switch (operation) {
    case "document_symbols":
    case "workspace_symbols":
      return "No symbols found.";
    case "call_hierarchy":
      return "No call hierarchy items found.";
    case "type_hierarchy":
      return "No type hierarchy items found.";
    case "incoming_calls":
      return "No incoming calls found.";
    case "outgoing_calls":
      return "No outgoing calls found.";
    case "supertypes":
      return "No supertypes found.";
    case "subtypes":
      return "No subtypes found.";
    case "selection_ranges":
      return "No selection ranges found.";
    case "folding_ranges":
      return "No folding ranges found.";
  }
}

/**
 * Render a symbol, hierarchy, or range read as agent-friendly text with one-based positions and
 * paths relative to Pi's working directory:
 *
 * - symbols: an outline of `name (kind) path:line:col[  detail | in Container]` lines, children
 *   indented under their parent;
 * - hierarchy items: `name (kind) path:line:col`, with each call site indented below a call as
 *   `path:line:col  <source line>`;
 * - selection ranges: `line:col-line:col`, innermost to outermost;
 * - folding ranges: `startLine-endLine[ kind]  <first source line>`.
 *
 * Results are grouped by server only when more than one server answered, and server failures
 * follow as warnings. Scope lines, when given, precede the items. A response that does not match
 * the operation's shape is shown as compact JSON instead.
 */
export async function formatLspStructureReadText(
  input: LspStructureReadTextInput,
): Promise<string> {
  return assembleLspReadText({
    blocks: await formatLspStructureReadBlocks(input),
    warnings: input.warnings,
    scope: input.scope ?? [],
  });
}

/** Render each server's lines of a structure read, before grouping and warnings are added. */
export async function formatLspStructureReadBlocks(
  input: LspStructureReadTextInput,
): Promise<readonly LspReadTextBlock[]> {
  const context: RenderContext = { input, sources: new LspSourceLines() };
  return Promise.all(
    input.reads.map(async (read): Promise<LspReadTextBlock> => {
      const empty = input.emptyMessage?.(read) ?? emptyMessage(input.operation);
      if (read.value === null || read.value === undefined) {
        return { server_id: read.server_id, lines: [empty] };
      }
      const items: readonly unknown[] = Array.isArray(read.value) ? read.value : [read.value];
      const lines = items.length === 0 ? [empty] : await itemLines(items, context);
      return { server_id: read.server_id, lines: lines ?? [formatLspToolValue(read.value)] };
    }),
  );
}
