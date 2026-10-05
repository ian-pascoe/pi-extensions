import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { Position } from "vscode-languageserver-protocol";
import { lspDisplayPath, LSP_UTF8_DECODER } from "./lsp-location-text.js";
import {
  convertLspProtocolLinePosition,
  documentLines,
  type LspCodePointPosition,
  type LspPositionEncoding,
} from "./lsp-position-encoding.js";

/** An opaque protocol record, whose inspected fields are validated where read. */
const ProtocolRecordSchema = Type.Record(Type.String(), Type.Unknown());
export const ProtocolStringSchema = Type.String();
const ProtocolFoldingRangeSchema = Type.Object(
  {
    startLine: Type.Integer({ minimum: 0 }),
    startCharacter: Type.Optional(Type.Integer({ minimum: 0 })),
    endLine: Type.Integer({ minimum: 0 }),
    endCharacter: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);

/** Most files an approximate-positions warning names before counting the rest. */
const MAX_NAMED_APPROXIMATE_FILES = 5;

/** The requested document, whose positions convert against the text the server was synced with. */
export interface LspRequestedDocumentText {
  readonly uri: string;
  readonly text: string;
}

/** One server response with one-based Unicode code-point positions. */
export interface LspNormalizedProtocolResult {
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- Normalization preserves dynamic payloads without claiming a method-specific result type.
  readonly value: unknown;
  /**
   * Files whose text was unavailable, named as the result names them (a path for a `file:` URI),
   * so their positions are approximate.
   */
  readonly approximateFiles: readonly string[];
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Protocol records retain unknown fields; consumers validate each inspected value rather than promising a complete response type.
type ProtocolRecord = Readonly<Record<string, unknown>>;

/** Chooses the file whose text converts one field's positions, given the record and its file. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- The record is an opaque protocol record whose inspected fields are validated where read.
type FieldFile = (record: ProtocolRecord, file: string | undefined) => string | undefined;

/** The URI of the record's `targetUri` file, which a LocationLink's target ranges lie in. */
const targetFile: FieldFile = (record, file) => protocolString(record.targetUri) ?? file;

/**
 * The file whose text converts each field's positions. Every other field uses its record's own
 * file: its `uri`, else its `targetUri`, else the file its parent's positions use. The requested
 * document is the file of a response's top level.
 */
const PROTOCOL_FIELD_FILES: ReadonlyMap<string, FieldFile> = new Map([
  // An incoming call's sites lie in its caller's file, which its `from` item names. An outgoing
  // call has no `from`; its sites lie in the prepared item's file, which callers pass as its file.
  ["fromRanges", (record, file) => protocolString(protocolRecord(record.from)?.uri) ?? file],
  // A LocationLink's origin lies in the requested file, not its target.
  ["originSelectionRange", (_record, file) => file],
  ["targetRange", targetFile],
  ["targetSelectionRange", targetFile],
]);

function recordFile(record: ProtocolRecord, file: string | undefined): string | undefined {
  return protocolString(record.uri) ?? protocolString(record.targetUri) ?? file;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Protocol fields are opaque until checked here.
export function protocolString(value: unknown): string | undefined {
  return Value.Check(ProtocolStringSchema, value) ? value : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Protocol records retain unknown fields; consumers validate each inspected value.
export function protocolRecord(value: unknown): ProtocolRecord | undefined {
  return Value.Check(ProtocolRecordSchema, value) ? value : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only validated, exact position objects are rewritten during normalization.
function protocolPositionValue(value: unknown): Position | undefined {
  if (
    !Position.is(value) ||
    !Number.isSafeInteger(value.line) ||
    !Number.isSafeInteger(value.character) ||
    Object.keys(value).some((key) => key !== "line" && key !== "character")
  ) {
    return undefined;
  }
  return { line: value.line, character: value.character };
}

/** Display a protocol URI as results name it: a path for a `file:` URI, otherwise the URI. */
export function lspProtocolUriPath(uri: string): string {
  return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
}

/** Read a `file:` URI as UTF-8 text; any other URI, a failed read, or invalid UTF-8 has none. */
export async function readLspProtocolUriText(uri: string): Promise<string | undefined> {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return LSP_UTF8_DECODER.decode(await readFile(fileURLToPath(uri)));
  } catch {
    return undefined;
  }
}

/** What one normalization needs beyond the response. */
export interface LspProtocolResultOptions {
  readonly encoding: LspPositionEncoding;
  /** The requested document; workspace reads have none. */
  readonly document?: LspRequestedDocumentText | undefined;
  /** Reads the text of a URI other than the requested document's. */
  readonly readText?: (uri: string) => Promise<string | undefined>;
}

/**
 * Converts the positions of one server's result from zero-based protocol units to one-based Unicode
 * code points, each against the text of the file it lies in. Each file is read at most once, and the
 * requested document uses the text the server was synced with. A position whose file text is
 * unavailable (a non-`file:` URI, a failed read, or invalid UTF-8) is never converted against
 * another file's text: its line and character are approximated by adding 1, and, unless the
 * negotiated encoding counts code points (where adding 1 is exact), its file is named in
 * `approximateFiles`. A position with no file in scope, such as one in server-private `data` of a
 * workspace read, is not a document position and stays unchanged.
 */
export class LspProtocolResultNormalizer {
  readonly #options: LspProtocolResultOptions;
  readonly #lines = new Map<string, Promise<readonly string[] | undefined>>();
  readonly #approximateFiles = new Set<string>();

  constructor(options: LspProtocolResultOptions) {
    this.#options = options;
  }

  /** Files whose positions so far were approximated, as the result names them, in sorted order. */
  get approximateFiles(): readonly string[] {
    return [...this.#approximateFiles].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }

  /** Normalize a response whose top-level positions lie in the requested document, if any. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Protocol responses stay opaque; normalization validates each position it rewrites.
  normalize(value: unknown): Promise<unknown> {
    return this.#normalize(value, this.#options.document?.uri);
  }

  /** Normalize a value whose top-level positions lie in the file `uri` names. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Protocol values stay opaque; normalization validates each position it rewrites.
  normalizeInFile(value: unknown, uri: string): Promise<unknown> {
    return this.#normalize(value, uri);
  }

  /** Normalize a value whose top-level positions lie in `file`; with no file they stay unchanged. */
  async #normalize(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recursive protocol values are opaque except for locally validated positions, ranges, and URI fields.
    value: unknown,
    file: string | undefined,
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Normalization preserves dynamic payloads without claiming a method-specific result type.
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => this.#normalize(entry, file)));
    }
    if (value instanceof Map) {
      const entries: [unknown, unknown][] = [...value.entries()];
      return Promise.all(
        entries
          .sort(([left], [right]) => String(left).localeCompare(String(right)))
          .map(async ([key, entryValue]) => {
            const uri = protocolString(key);
            return {
              uri: uri === undefined ? key : lspProtocolUriPath(uri),
              value: await this.#normalize(entryValue, uri),
            };
          }),
      );
    }
    const position = protocolPositionValue(value);
    if (position !== undefined) return file === undefined ? value : this.#position(position, file);
    if (Value.Check(ProtocolFoldingRangeSchema, value)) {
      return file === undefined ? value : this.#foldingRange(value, file);
    }
    const record = protocolRecord(value);
    if (record === undefined) return value;
    const entries = await Promise.all(
      Object.entries(record).map(async ([key, entryValue]) => {
        const uri = protocolString(entryValue);
        if ((key === "uri" || key === "targetUri") && uri !== undefined) {
          return [key, lspProtocolUriPath(uri)] as const;
        }
        const fieldFile = PROTOCOL_FIELD_FILES.get(key) ?? recordFile;
        return [key, await this.#normalize(entryValue, fieldFile(record, file))] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /** The lines of a file's text, read and split at most once per result. */
  #fileLines(file: string): Promise<readonly string[] | undefined> {
    let lines = this.#lines.get(file);
    if (lines === undefined) {
      const { document, readText = readLspProtocolUriText } = this.#options;
      const text = file === document?.uri ? Promise.resolve(document.text) : readText(file);
      lines = text.then((value) => (value === undefined ? undefined : documentLines(value)));
      this.#lines.set(file, lines);
    }
    return lines;
  }

  async #position(position: Position, file: string): Promise<LspCodePointPosition> {
    const lines = await this.#fileLines(file);
    if (lines !== undefined) {
      return convertLspProtocolLinePosition(lines, position, this.#options.encoding);
    }
    // Adding 1 is exact when characters count code points.
    if (this.#options.encoding !== "utf-32") this.#approximateFiles.add(lspProtocolUriPath(file));
    return { line: position.line + 1, character: position.character + 1 };
  }

  async #foldingRange(value: Static<typeof ProtocolFoldingRangeSchema>, file: string) {
    const start = await this.#position(
      { line: value.startLine, character: value.startCharacter ?? 0 },
      file,
    );
    const end = await this.#position(
      { line: value.endLine, character: value.endCharacter ?? 0 },
      file,
    );
    const normalized = { ...value, startLine: start.line, endLine: end.line };
    if (value.startCharacter !== undefined && value.endCharacter !== undefined) {
      return { ...normalized, startCharacter: start.character, endCharacter: end.character };
    }
    if (value.startCharacter !== undefined) {
      return { ...normalized, startCharacter: start.character };
    }
    if (value.endCharacter !== undefined) return { ...normalized, endCharacter: end.character };
    return normalized;
  }
}

/** Normalize one server's response whose top-level positions lie in the requested document. */
export async function normalizeLspProtocolResult(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Protocol responses stay opaque; normalization validates each position it rewrites.
  value: unknown,
  options: LspProtocolResultOptions,
): Promise<LspNormalizedProtocolResult> {
  const normalizer = new LspProtocolResultNormalizer(options);
  return {
    value: await normalizer.normalize(value),
    approximateFiles: normalizer.approximateFiles,
  };
}

/**
 * The model-visible warning that a server's result holds approximate positions, naming up to five
 * of their files, or undefined when every position was converted exactly.
 */
export function lspApproximatePositionsWarning(
  serverId: string,
  files: readonly string[],
  cwd: string,
): string | undefined {
  if (files.length === 0) return undefined;
  const named = files
    .slice(0, MAX_NAMED_APPROXIMATE_FILES)
    .map((file) => lspDisplayPath(cwd, file));
  const rest = files.length - named.length;
  const list = rest === 0 ? named.join(", ") : `${named.join(", ")}, and ${rest} more`;
  return `${serverId}: positions in ${list} are approximate because their text could not be read; lines are exact, but columns may be off after non-ASCII text.`;
}
