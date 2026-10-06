import { readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { documentLines } from "./lsp-position-encoding.js";
import { normalizeLspFilePath } from "./lsp-server-manager.js";
import type { LspOperationName } from "./lsp-tool-contract.js";
import { formatLspToolValue } from "./lsp-tool-output.js";

const LOCATION_OPERATIONS = [
  "declaration",
  "goto_definition",
  "goto_type_definition",
  "goto_implementation",
  "find_references",
  "document_highlights",
] as const satisfies readonly LspOperationName[];

/** Read operations whose model-visible text lists locations (ADR-0003: derived from the Structured Result). */
export type LspLocationOperation = (typeof LOCATION_OPERATIONS)[number];

const LOCATION_OPERATION_SET: ReadonlySet<LspOperationName> = new Set(LOCATION_OPERATIONS);

/** Report whether an operation's model-visible text uses the readable location format. */
export function isLspLocationOperation(
  operation: LspOperationName,
): operation is LspLocationOperation {
  return LOCATION_OPERATION_SET.has(operation);
}

/** Decodes strict UTF-8, rejecting invalid bytes, without stripping a byte-order mark. */
export const LSP_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Longest source line shown after a location before it is shortened. */
const SOURCE_LINE_MAX_CHARACTERS = 200;

/** One-based Unicode code-point position, as normalized protocol results carry them. */
export const LspNormalizedPositionSchema = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  character: Type.Integer({ minimum: 1 }),
});
const RangeSchema = Type.Object({ start: LspNormalizedPositionSchema });
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
export interface LspTextLocation {
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
  const path = normalizeLspFilePath(filePath);
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
export class LspSourceLines {
  readonly #files = new Map<string, Promise<readonly string[] | undefined>>();

  async line(path: string, oneBasedLine: number): Promise<string | undefined> {
    let lines = this.#files.get(path);
    if (lines === undefined) {
      lines = readSourceLines(path);
      this.#files.set(path, lines);
    }
    const line = (await lines)?.[oneBasedLine - 1]?.trim();
    if (line === undefined || line === "") return undefined;
    return shortenLspText(line);
  }
}

/** Shorten text longer than a source line may be shown, marking the cut with `…`. */
export function shortenLspText(text: string): string {
  const characters = Array.from(text);
  return characters.length > SOURCE_LINE_MAX_CHARACTERS
    ? `${characters.slice(0, SOURCE_LINE_MAX_CHARACTERS).join("")}…`
    : text;
}

/** Collapse whitespace, such as a multi-line message, onto one line. */
export function collapseLspWhitespace(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

/** Collapse whitespace, such as a multi-line detail, onto one shortened line. */
export function compactLspText(text: string): string {
  return shortenLspText(collapseLspWhitespace(text));
}

async function readSourceLines(path: string): Promise<readonly string[] | undefined> {
  if (!isAbsolute(path)) return undefined;
  try {
    return documentLines(LSP_UTF8_DECODER.decode(await readFile(path)));
  } catch {
    return undefined;
  }
}

/** Display one location as `path:line:col` with a display path. */
export function lspDisplayPosition(
  cwd: string,
  location: Pick<LspTextLocation, "path" | "line" | "character">,
): string {
  return `${lspDisplayPath(cwd, location.path)}:${location.line}:${location.character}`;
}

/** Render one location as `path:line:col[ kind]  <trimmed source line>`. */
export async function formatLspLocationLine(
  location: LspTextLocation,
  cwd: string,
  sources: LspSourceLines,
): Promise<string> {
  const position = lspDisplayPosition(cwd, location);
  const head = location.label === undefined ? position : `${position} ${location.label}`;
  const source = await sources.line(location.path, location.line);
  return source === undefined ? head : `${head}  ${source}`;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalized protocol items are opaque until one location schema matches.
function parseLocationItem(item: unknown, documentPath: string): LspTextLocation | undefined {
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
function parseLocations(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A server response may be a location, a list of them, null, or something unexpected.
  value: unknown,
  documentPath: string,
): readonly LspTextLocation[] | undefined {
  if (value === null || value === undefined) return [];
  const items: readonly unknown[] = Array.isArray(value) ? value : [value];
  const locations = items.map((item) => parseLocationItem(item, documentPath));
  return locations.every((location) => location !== undefined) ? locations : undefined;
}

function emptyMessage(operation: LspLocationOperation): string {
  if (operation === "find_references") return "No references found.";
  if (operation === "document_highlights") return "No highlights found.";
  return "No locations found.";
}

/** One server's successful response to a read. */
export interface LspRead {
  readonly server_id: string;
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- Normalized server responses stay opaque; recognized location shapes are checked while rendering.
  readonly value: unknown;
}

/** The inputs of one location read's model-visible text. */
export interface LspLocationReadTextInput {
  readonly operation: LspLocationOperation;
  /** Pi's working directory; paths inside it are shown relative to it. */
  readonly cwd: string;
  /** Absolute path of the queried document, which document highlights refer to. */
  readonly documentPath: string;
  readonly reads: readonly LspRead[];
  readonly warnings: readonly string[];
  /** Lines shown before the locations, such as the queried position and searched workspace roots. */
  readonly scope?: readonly string[];
  /** The line shown for a server that found no locations, replacing the operation's default. */
  readonly emptyMessage?: ((read: LspRead) => string) | undefined;
}

/** The rendered lines of one server's response. */
export interface LspReadTextBlock {
  readonly server_id: string;
  readonly lines: readonly string[];
}

/**
 * Assemble a read's model-visible text: optional scope lines, then each server's lines (grouped
 * under its server ID only when more than one server answered), then failures as warnings.
 */
export function assembleLspReadText(input: {
  readonly blocks: readonly LspReadTextBlock[];
  readonly warnings: readonly string[];
  readonly scope?: readonly string[];
}): string {
  const grouped = input.blocks.length > 1;
  const lines = input.blocks.flatMap((block) =>
    grouped ? [`${block.server_id}:`, ...block.lines.map((line) => `  ${line}`)] : block.lines,
  );
  const warnings = input.warnings.map((warning) => `Warning: ${warning}`);
  const scope = input.scope ?? [];
  return [
    ...(scope.length === 0 ? [] : [...scope, ""]),
    ...lines,
    ...(warnings.length === 0 ? [] : ["", ...warnings]),
  ].join("\n");
}

/**
 * Render a location read as agent-friendly text: one `path:line:col  <source line>` line per
 * location, with one-based positions and paths relative to Pi's working directory. Results are
 * grouped by server only when more than one server answered, and server failures follow as
 * warnings. Scope lines, when given, precede the locations. A response that is not
 * location-shaped is shown as compact JSON instead.
 */
export async function formatLspLocationReadText(input: LspLocationReadTextInput): Promise<string> {
  const sources = new LspSourceLines();
  const blocks = await Promise.all(
    input.reads.map(async (read): Promise<LspReadTextBlock> => {
      const locations = parseLocations(read.value, input.documentPath);
      let lines: readonly string[];
      if (locations === undefined) lines = [formatLspToolValue(read.value)];
      else if (locations.length === 0) {
        lines = [input.emptyMessage?.(read) ?? emptyMessage(input.operation)];
      } else {
        lines = await Promise.all(
          locations.map((location) => formatLspLocationLine(location, input.cwd, sources)),
        );
      }
      return { server_id: read.server_id, lines };
    }),
  );
  return assembleLspReadText({ blocks, warnings: input.warnings, scope: input.scope ?? [] });
}
