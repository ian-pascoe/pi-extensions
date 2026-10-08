import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { LSP_MEMBER_CONTAINER_SYMBOL_KINDS } from "./lsp-tool-contract.js";
import type { PostEditDiagnosticOutcome } from "./lsp-post-edit-diagnostics.js";

/** Most dependent files whose diagnostics one edit pulls; the rest are counted, not checked. */
export const MAX_DEPENDENT_FILES = 20;
/** Most touched declarations whose references one edit asks for. */
export const MAX_TOUCHED_DECLARATIONS = 10;
/** Time the pre-edit dependent scan may delay one edit call before it is abandoned. */
export const DEPENDENT_SCAN_BUDGET_MS = 20_000;

const ERROR_SEVERITY = 1;
const MEMBER_CONTAINER_KINDS: ReadonlySet<number> = new Set(
  Object.values(LSP_MEMBER_CONTAINER_SYMBOL_KINDS),
);

/** An inclusive range of zero-based line numbers. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The lines an edit touched, or `"all"` when they cannot be told apart (a whole-file write). */
export type TouchedLines = readonly LineRange[] | "all";

/** What the pre-edit scan keeps for one tool call until its result arrives. */
export interface DependentBaseline {
  /** Absolute paths of dependent files whose diagnostics were pulled before the edit, sorted. */
  readonly files: readonly string[];
  /** Dependent files left unchecked: beyond the cap, or with no baseline. */
  readonly omittedFiles: number;
  /** Error keys each checked dependent file already had before the edit. */
  readonly errorKeys: ReadonlyMap<string, ReadonlySet<string>>;
  /** The scan ran out of its time budget, so the dependents are unknown rather than absent. */
  readonly scanTimedOut: boolean;
}

/** New errors an edit caused in dependent files, and how many dependent files went unchecked. */
export interface DependentDiagnosticsReport {
  readonly outcomes: readonly PostEditDiagnosticOutcome[];
  readonly omittedFiles: number;
  /** The pre-edit scan ran out of its time budget, so dependent files could not be checked. */
  readonly scanTimedOut: boolean;
}

const PositionSchema = Type.Object({ line: Type.Number(), character: Type.Number() });
const RangeSchema = Type.Object({ start: PositionSchema, end: PositionSchema });
const DocumentSymbolSchema = Type.Object({
  kind: Type.Number(),
  range: RangeSchema,
  selectionRange: RangeSchema,
  children: Type.Optional(Type.Unknown()),
});
const LocationSchema = Type.Object({ uri: Type.String() });
const EditsInputSchema = Type.Object({
  path: Type.String(),
  edits: Type.Optional(
    Type.Array(Type.Object({ oldText: Type.String() }, { additionalProperties: true })),
  ),
});

type SymbolPosition = Static<typeof PositionSchema>;

function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset;) {
    line++;
    index = text.indexOf("\n", index + 1);
  }
  return line;
}

/**
 * The lines of `text` that a native `edit` call's `oldText` blocks cover. An `oldText` the file
 * does not contain, or a call without any, cannot be located and counts as touching everything.
 */
export function touchedLinesOfEdit(
  text: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A tool call's input is opaque until it matches the edit schema.
  input: unknown,
): TouchedLines {
  if (!Value.Check(EditsInputSchema, input) || input.edits === undefined) return "all";
  const ranges: LineRange[] = [];
  for (const { oldText } of input.edits) {
    const offset = text.indexOf(oldText);
    if (oldText === "" || offset === -1) return "all";
    ranges.push({ start: lineAt(text, offset), end: lineAt(text, offset + oldText.length) });
  }
  return ranges.length === 0 ? "all" : ranges;
}

function intersects(touched: TouchedLines, start: number, end: number): boolean {
  return touched === "all" || touched.some((range) => range.start <= end && start <= range.end);
}

/**
 * Positions of the declarations a touched range reaches, in document order and capped. A member
 * container is included when the touch reaches its header (up to its name), and its members when
 * the touch reaches them; locals inside function bodies are never selected. A response that is
 * not a hierarchical symbol list selects nothing.
 */
export function touchedDeclarationPositions(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A documentSymbol response is opaque until it matches the symbol schema.
  symbols: unknown,
  touched: TouchedLines,
  limit = MAX_TOUCHED_DECLARATIONS,
): SymbolPosition[] {
  const positions: SymbolPosition[] = [];
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Children are opaque until each matches the symbol schema.
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const symbol of list) {
      if (positions.length >= limit) return;
      if (!Value.Check(DocumentSymbolSchema, symbol)) continue;
      const { range, selectionRange } = symbol;
      if (!intersects(touched, range.start.line, range.end.line)) continue;
      if (MEMBER_CONTAINER_KINDS.has(symbol.kind)) {
        if (intersects(touched, range.start.line, selectionRange.end.line)) {
          positions.push(selectionRange.start);
        }
        visit(symbol.children);
      } else positions.push(selectionRange.start);
    }
  };
  visit(symbols);
  return positions.slice(0, limit);
}

/** Absolute `file:` paths named by a `textDocument/references` response, minus `exclude` and `node_modules`. */
export function referencedFilePaths(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A references response is opaque until each item matches the location schema.
  locations: unknown,
  exclude: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(locations)) return [];
  const paths = new Set<string>();
  for (const location of locations) {
    if (!Value.Check(LocationSchema, location) || !location.uri.startsWith("file:")) continue;
    let path: string;
    try {
      path = fileURLToPath(location.uri);
    } catch {
      continue;
    }
    if (!exclude.has(path) && !path.split(/[\\/]/u).includes("node_modules")) paths.add(path);
  }
  return [...paths];
}

/** The files of a capped candidate list to check, and how many fell past the cap. */
export interface CappedDependentFiles {
  readonly files: readonly string[];
  readonly omittedFiles: number;
}

/** Cap a candidate list: sorted, at most `MAX_DEPENDENT_FILES`, with the rest counted. */
export function capDependentFiles(paths: readonly string[]): CappedDependentFiles {
  const sorted = paths.toSorted((left, right) => left.localeCompare(right));
  return {
    files: sorted.slice(0, MAX_DEPENDENT_FILES),
    omittedFiles: Math.max(0, sorted.length - MAX_DEPENDENT_FILES),
  };
}

/** The text of each file a finding lies in, by absolute path, read after the pull that found it. */
export type FileTexts = ReadonlyMap<string, string>;

/** The trimmed text of a one-based line, or an empty string when the file or line is unknown. */
function trimmedLineText(texts: FileTexts, path: string, line: number): string {
  return (
    texts
      .get(path)
      ?.split(/\r\n|\r|\n/u)
      [line - 1]?.trim() ?? ""
  );
}

/**
 * Identity of one error finding: server, message, and the trimmed text of the line it points at.
 * It names no position, so it survives edits that shift the line, such as a sibling edit in the
 * same parallel tool batch adding a line above it.
 */
export function errorKey(outcome: PostEditDiagnosticOutcome, texts: FileTexts): string | undefined {
  if (outcome.kind !== "diagnostic" || outcome.diagnostic.severity !== ERROR_SEVERITY) {
    return undefined;
  }
  const { serverId, path, line, message } = outcome.diagnostic;
  return `${serverId}\u0000${message}\u0000${trimmedLineText(texts, path, line)}`;
}

/** Error keys per dependent file, and the count of files whose pull failed. */
export interface GroupedErrorKeys {
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unchecked: number;
}

/**
 * Settle one pull of dependent files into error keys per file. A file whose pull timed out or
 * failed has no entry and counts as unchecked.
 */
export function groupErrorKeys(
  paths: readonly string[],
  outcomes: readonly PostEditDiagnosticOutcome[],
  texts: FileTexts,
): GroupedErrorKeys {
  const keys = new Map<string, Set<string>>();
  const failed = new Set<string>();
  for (const path of paths) keys.set(path, new Set());
  for (const outcome of outcomes) {
    if (outcome.kind === "timeout" || outcome.kind === "unavailable_server") {
      failed.add(outcome.path);
    } else if (outcome.kind === "diagnostic") {
      const key = errorKey(outcome, texts);
      if (key !== undefined) keys.get(outcome.diagnostic.path)?.add(key);
    }
  }
  for (const path of failed) keys.delete(path);
  return { keys, unchecked: failed.size };
}

/** The errors in `outcomes` that the baseline did not already have, marked as dependent-file findings. */
export function newDependentErrors(
  baseline: DependentBaseline,
  paths: readonly string[],
  outcomes: readonly PostEditDiagnosticOutcome[],
  texts: FileTexts,
): DependentDiagnosticsReport {
  const { unchecked } = groupErrorKeys(paths, outcomes, texts);
  const fresh: PostEditDiagnosticOutcome[] = [];
  for (const outcome of outcomes) {
    const key = errorKey(outcome, texts);
    if (
      key === undefined ||
      outcome.kind !== "diagnostic" ||
      baseline.errorKeys.get(outcome.diagnostic.path)?.has(key) === true
    ) {
      continue;
    }
    fresh.push({ kind: "diagnostic", diagnostic: { ...outcome.diagnostic, dependent: true } });
  }
  return {
    outcomes: fresh,
    omittedFiles: baseline.omittedFiles + unchecked,
    scanTimedOut: baseline.scanTimedOut,
  };
}
