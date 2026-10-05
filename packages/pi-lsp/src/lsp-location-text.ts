import { readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { documentLines } from "./lsp-position-encoding.js";
import type { LspOperationName } from "./lsp-tool-contract.js";
import { formatLspToolValue } from "./lsp-tool-output.js";

/** Read operations whose model-visible text lists locations (ADR-0003: derived from the Structured Result). */
export type LspLocationOperation = Extract<
  LspOperationName,
  | "declaration"
  | "goto_definition"
  | "goto_type_definition"
  | "goto_implementation"
  | "find_references"
  | "document_highlights"
>;

const LOCATION_OPERATIONS: ReadonlySet<LspOperationName> = new Set<LspLocationOperation>([
  "declaration",
  "goto_definition",
  "goto_type_definition",
  "goto_implementation",
  "find_references",
  "document_highlights",
]);

/** Report whether an operation's model-visible text uses the readable location format. */
export function isLspLocationOperation(
  operation: LspOperationName,
): operation is LspLocationOperation {
  return LOCATION_OPERATIONS.has(operation);
}

/** Longest source line shown after a location before it is shortened. */
const SOURCE_LINE_MAX_CHARACTERS = 200;

/** One-based Unicode code-point position, as normalized protocol results carry them. */
const PositionSchema = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  character: Type.Integer({ minimum: 1 }),
});
const RangeSchema = Type.Object({ start: PositionSchema });
const LocationSchema = Type.Object({ uri: Type.String(), range: RangeSchema });
const LocationLinkSchema = Type.Object({
  targetUri: Type.String(),
  targetSelectionRange: RangeSchema,
});
const DocumentHighlightSchema = Type.Object({
  range: RangeSchema,
  kind: Type.Optional(Type.Integer()),
});

/** `DocumentHighlightKind` names; the protocol encodes them as numbers. */
const HIGHLIGHT_KIND_NAMES: ReadonlyMap<number, string> = new Map([
  [1, "text"],
  [2, "read"],
  [3, "write"],
]);

/** One location in a model-visible result, with an optional kind label. */
interface LspTextLocation {
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly label?: string;
}

/**
 * Display a file path relative to Pi's working directory, or absolute when it lies outside it.
 * A leading `@`, accepted in tool arguments, is ignored.
 */
export function lspDisplayPath(cwd: string, filePath: string): string {
  const path = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (!isAbsolute(path)) return path;
  const relativePath = relative(cwd, path);
  const outside =
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);
  return outside ? path : relativePath;
}

/** Cached source lines of files named by one result; unreadable files have none. */
class SourceLines {
  readonly #files = new Map<string, Promise<readonly string[] | undefined>>();

  async line(path: string, oneBasedLine: number): Promise<string | undefined> {
    let lines = this.#files.get(path);
    if (lines === undefined) {
      lines = readSourceLines(path);
      this.#files.set(path, lines);
    }
    const line = (await lines)?.[oneBasedLine - 1]?.trim();
    if (line === undefined || line === "") return undefined;
    const characters = Array.from(line);
    return characters.length > SOURCE_LINE_MAX_CHARACTERS
      ? `${characters.slice(0, SOURCE_LINE_MAX_CHARACTERS).join("")}…`
      : line;
  }
}

async function readSourceLines(path: string): Promise<readonly string[] | undefined> {
  if (!isAbsolute(path)) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(path),
    );
    return documentLines(text);
  } catch {
    return undefined;
  }
}

/** Render locations as `path:line:col[ kind]  <trimmed source line>`, one per line. */
async function formatLocationLines(
  locations: readonly LspTextLocation[],
  cwd: string,
  sources: SourceLines,
): Promise<string[]> {
  return Promise.all(
    locations.map(async (location) => {
      const position = `${lspDisplayPath(cwd, location.path)}:${location.line}:${location.character}`;
      const head = location.label === undefined ? position : `${position} ${location.label}`;
      const source = await sources.line(location.path, location.line);
      return source === undefined ? head : `${head}  ${source}`;
    }),
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalized protocol items are opaque until one location schema matches.
function textLocation(item: unknown, documentPath: string): LspTextLocation | undefined {
  if (Value.Check(LocationSchema, item)) {
    return { path: item.uri, ...item.range.start };
  }
  if (Value.Check(LocationLinkSchema, item)) {
    return { path: item.targetUri, ...item.targetSelectionRange.start };
  }
  if (Value.Check(DocumentHighlightSchema, item)) {
    const location = { path: documentPath, ...item.range.start };
    if (item.kind === undefined) return location;
    return { ...location, label: HIGHLIGHT_KIND_NAMES.get(item.kind) ?? `kind ${item.kind}` };
  }
  return undefined;
}

/** Locations of one server response, or undefined when any item is not location-shaped. */
function textLocations(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A server response may be a location, a list of them, null, or something unexpected.
  value: unknown,
  documentPath: string,
): readonly LspTextLocation[] | undefined {
  if (value === null || value === undefined) return [];
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  const locations = items.map((item) => textLocation(item, documentPath));
  return locations.every((location) => location !== undefined) ? locations : undefined;
}

function emptyMessage(operation: LspLocationOperation): string {
  if (operation === "find_references") return "No references found.";
  if (operation === "document_highlights") return "No highlights found.";
  return "No locations found.";
}

/** One server's successful response to a location read. */
export interface LspLocationRead {
  readonly server_id: string;
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- Normalized server responses stay opaque; recognized location shapes are checked while rendering.
  readonly value: unknown;
}

/** The inputs of one location read's model-visible text. */
export interface LspLocationReadText {
  readonly operation: LspLocationOperation;
  /** Pi's working directory; paths inside it are shown relative to it. */
  readonly cwd: string;
  /** Absolute path of the queried document, which document highlights refer to. */
  readonly documentPath: string;
  readonly reads: readonly LspLocationRead[];
  readonly warnings: readonly string[];
}

/**
 * Render a location read as agent-friendly text: one `path:line:col  <source line>` line per
 * location, with one-based positions and paths relative to Pi's working directory. Results are
 * grouped by server only when more than one server answered, and server failures follow as
 * warnings. A response that is not location-shaped is shown as compact JSON instead.
 */
export async function formatLspLocationReadText(input: LspLocationReadText): Promise<string> {
  const sources = new SourceLines();
  const grouped = input.reads.length > 1;
  const blocks = await Promise.all(
    input.reads.map(async (read) => {
      const locations = textLocations(read.value, input.documentPath);
      let lines: string[];
      if (locations === undefined) lines = [formatLspToolValue(read.value)];
      else if (locations.length === 0) lines = [emptyMessage(input.operation)];
      else lines = await formatLocationLines(locations, input.cwd, sources);
      return grouped ? [`${read.server_id}:`, ...lines.map((line) => `  ${line}`)] : lines;
    }),
  );
  const warnings = input.warnings.map((warning) => `Warning: ${warning}`);
  return [...blocks.flat(), ...(warnings.length === 0 ? [] : ["", ...warnings])].join("\n");
}
