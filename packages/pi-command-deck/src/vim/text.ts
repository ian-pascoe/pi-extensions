import type { Position, TextModel, TextRange } from "./types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const NON_PRINTABLE_ASCII = /[^ -~]/u;
const PASTE_MARKER = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/gu;
const BOUNDARY_CACHE_LIMIT = 64;
const boundaryCache = new Map<string, number[]>();
const NO_PASTES: ReadonlySet<number> = new Set();
let pasteIds = NO_PASTES;
let pasteKey = "";

/**
 * Run `body` with Pi's paste markers (e.g. `[paste #1 +12 lines]`) for these ids treated as one
 * character each, so Vim edits never split a marker and lose its pasted content.
 */
export function withPasteMarkers<T>(ids: ReadonlySet<number>, body: () => T): T {
  const previous = { ids: pasteIds, key: pasteKey };
  pasteIds = ids;
  pasteKey = ids.size === 0 ? "" : [...ids].sort((a, b) => a - b).join(",");
  try {
    return body();
  } finally {
    pasteIds = previous.ids;
    pasteKey = previous.key;
  }
}

/** Spans `[start, end)` of valid paste markers in a line. */
export function pasteMarkerSpans(line: string): [number, number][] {
  if (pasteIds.size === 0 || !line.includes("[paste #")) return [];
  const spans: [number, number][] = [];
  for (const match of line.matchAll(PASTE_MARKER)) {
    if (pasteIds.has(Number(match[1]))) spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/** True when a grapheme from `charAt` is a whole paste marker. */
export function isPasteMarker(char: string): boolean {
  return char.length > 1 && char.startsWith("[paste #") && pasteMarkerSpans(char).length === 1;
}

/** Grapheme start offsets, or undefined when every code unit is one grapheme. */
function graphemeStarts(line: string): number[] | undefined {
  const markers = pasteMarkerSpans(line);
  if (markers.length === 0 && !NON_PRINTABLE_ASCII.test(line)) return undefined;
  const key = `${pasteKey}\u0000${line}`;
  const cached = boundaryCache.get(key);
  if (cached) return cached;
  const starts = [...graphemeSegmenter.segment(line)]
    .map((segment) => segment.index)
    .filter((start) => !markers.some(([from, to]) => start > from && start < to));
  if (boundaryCache.size >= BOUNDARY_CACHE_LIMIT) {
    const oldest = boundaryCache.keys().next().value;
    if (oldest !== undefined) boundaryCache.delete(oldest);
  }
  boundaryCache.set(key, starts);
  return starts;
}

/** The column of the next grapheme after `col`, capped at the line end. */
export function nextCol(line: string, col: number): number {
  if (col >= line.length) return line.length;
  const starts = graphemeStarts(line);
  if (!starts) return col + 1;
  return starts.find((start) => start > col) ?? line.length;
}

/** The column of the grapheme before `col`, floored at zero. */
export function prevCol(line: string, col: number): number {
  if (col <= 0) return 0;
  const starts = graphemeStarts(line);
  if (!starts) return Math.min(col, line.length) - 1;
  return starts.findLast((start) => start < col) ?? 0;
}

/** Snap `col` down to a grapheme boundary within the line. */
export function snapCol(line: string, col: number): number {
  if (col >= line.length) return line.length;
  if (col <= 0) return 0;
  const starts = graphemeStarts(line);
  if (!starts) return col;
  return starts.findLast((start) => start <= col) ?? 0;
}

/** Snap `col` up to a grapheme boundary within the line. */
export function ceilCol(line: string, col: number): number {
  const floor = snapCol(line, col);
  return floor === col ? col : nextCol(line, floor);
}

/** The start column of the last grapheme, or 0 for an empty line. */
export function lastCharCol(line: string): number {
  return line.length === 0 ? 0 : prevCol(line, line.length);
}

/** The grapheme starting at `col`, or "" at the line end. */
export function charAt(line: string, col: number): string {
  return col >= line.length ? "" : line.slice(col, nextCol(line, col));
}

/** The number of graphemes before `col`. */
export function graphemeIndex(line: string, col: number): number {
  const starts = graphemeStarts(line);
  if (!starts) return Math.min(col, line.length);
  return starts.filter((start) => start < col).length;
}

/** The column of the grapheme at `index`, capped at the line end. */
export function colAtGraphemeIndex(line: string, index: number): number {
  const starts = graphemeStarts(line);
  if (!starts) return Math.min(index, line.length);
  return starts[index] ?? line.length;
}

export function graphemeCount(line: string): number {
  const starts = graphemeStarts(line);
  return starts ? starts.length : line.length;
}

export function isBlank(char: string): boolean {
  return char === "" || /^\s+$/u.test(char);
}

/**
 * Vim's character class: 0 blank (and line end), 1 punctuation, 2 keyword, 3 emoji, 4 paste marker.
 * WORD motions collapse every non-blank class into 1.
 */
export function charClass(char: string, bigWord: boolean): number {
  if (isBlank(char)) return 0;
  if (bigWord) return 1;
  if (isPasteMarker(char)) return 4;
  if (/^\p{Extended_Pictographic}/u.test(char)) return 3;
  if (/^[\p{L}\p{N}\p{M}_]/u.test(char)) return 2;
  return 1;
}

export function firstNonBlankCol(line: string): number {
  const match = /\S/u.exec(line);
  return match ? match.index : 0;
}

export function lineAt(model: TextModel, line: number): string {
  return model.lines[line] ?? "";
}

export function comparePositions(a: Position, b: Position): number {
  return a.line === b.line ? a.col - b.col : a.line - b.line;
}

export function orderPositions(a: Position, b: Position): [Position, Position] {
  return comparePositions(a, b) <= 0 ? [a, b] : [b, a];
}

/** The cursor clamped for normal and visual modes: on a character, never past the last one. */
export function clampNormalCursor(model: TextModel): Position {
  const line = Math.max(0, Math.min(model.cursor.line, model.lines.length - 1));
  const text = model.lines[line] ?? "";
  return { line, col: snapCol(text, Math.max(0, Math.min(model.cursor.col, lastCharCol(text)))) };
}

/** The cursor clamped for insert mode: the line end is a valid position. */
export function clampInsertCursor(model: TextModel): Position {
  const line = Math.max(0, Math.min(model.cursor.line, model.lines.length - 1));
  const text = model.lines[line] ?? "";
  return { line, col: snapCol(text, Math.max(0, model.cursor.col)) };
}

/**
 * Step one position forward through the buffer, where each line end is a position.
 * Returns 0 within a line, 2 when landing on a line end, 1 when crossing to the next line, -1 at
 * the buffer end.
 */
export function stepForward(model: TextModel, pos: Position): number {
  const line = lineAt(model, pos.line);
  if (pos.col < line.length) {
    pos.col = nextCol(line, pos.col);
    return pos.col < line.length ? 0 : 2;
  }
  if (pos.line < model.lines.length - 1) {
    pos.line += 1;
    pos.col = 0;
    return 1;
  }
  return -1;
}

/** Step one position backward; returns 0 within a line, 1 when crossing lines, -1 at the start. */
export function stepBackward(model: TextModel, pos: Position): number {
  if (pos.col > 0) {
    pos.col = prevCol(lineAt(model, pos.line), pos.col);
    return 0;
  }
  if (pos.line > 0) {
    pos.line -= 1;
    pos.col = lineAt(model, pos.line).length;
    return 1;
  }
  return -1;
}

export function classAt(model: TextModel, pos: Position, bigWord: boolean): number {
  return charClass(charAt(lineAt(model, pos.line), pos.col), bigWord);
}

/** Absolute offset of a position in the newline-joined text. */
export function toOffset(lines: readonly string[], pos: Position): number {
  let offset = 0;
  for (let index = 0; index < pos.line; index++) offset += (lines[index] ?? "").length + 1;
  return offset + pos.col;
}

/** Position of an absolute offset in the newline-joined text. */
export function fromOffset(lines: readonly string[], offset: number): Position {
  let remaining = Math.max(0, offset);
  for (let line = 0; line < lines.length; line++) {
    const length = (lines[line] ?? "").length;
    if (remaining <= length) return { line, col: remaining };
    remaining -= length + 1;
  }
  const last = Math.max(0, lines.length - 1);
  return { line: last, col: (lines[last] ?? "").length };
}

/** The text a range covers; linewise text ends with a newline. */
export function rangeText(model: TextModel, range: TextRange): string {
  if (range.linewise)
    return `${model.lines.slice(range.start.line, range.end.line + 1).join("\n")}\n`;
  const text = model.lines.join("\n");
  return text.slice(toOffset(model.lines, range.start), toOffset(model.lines, range.end));
}

/** Replace `[start, end)` with `insert`, returning new lines. */
export function spliceText(
  lines: readonly string[],
  start: Position,
  end: Position,
  insert: string,
): string[] {
  const text = lines.join("\n");
  const from = toOffset(lines, start);
  const to = toOffset(lines, end);
  return `${text.slice(0, from)}${insert}${text.slice(to)}`.split("\n");
}

/** Widen a charwise range so it never starts or ends inside a paste marker. */
export function snapRange(model: TextModel, range: TextRange): TextRange {
  if (range.linewise) return range;
  return {
    start: {
      line: range.start.line,
      col: snapCol(lineAt(model, range.start.line), range.start.col),
    },
    end: { line: range.end.line, col: ceilCol(lineAt(model, range.end.line), range.end.col) },
    linewise: false,
  };
}

/** A cursor at the first non-blank of `line`. */
export function firstNonBlankOf(lines: readonly string[], line: number): Position {
  return { line, col: firstNonBlankCol(lines[line] ?? "") };
}
