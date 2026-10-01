import type { Highlight } from "./types.js";

/** One rendered editor row: a slice of a logical line after word wrap. */
export interface PaintRow {
  line: number;
  startCol: number;
  length: number;
}

/** Where logical text landed in the editor's last render. */
export interface PaintLayout {
  rows: readonly PaintRow[];
  scrollOffset: number;
  visibleCount: number;
  paddingX: number;
}

const ESC = "\x1b";
const REVERSE_ON = `${ESC}[7m`;
const REVERSE_OFF = `${ESC}[27m`;

/** Index just past the escape sequence starting at `start`. */
function escapeEnd(row: string, start: number): number {
  const kind = row[start + 1];
  if (kind === "[") {
    let index = start + 2;
    while (index < row.length) {
      const code = row.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return index;
  }
  if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
    for (let index = start + 2; index < row.length; index++) {
      if (row[index] === "\x07") return index + 1;
      if (row[index] === ESC && row[index + 1] === "\\") return index + 2;
    }
    return row.length;
  }
  return Math.min(row.length, start + 2);
}

/** How an escape sequence changes reverse video: on, off, or unchanged (undefined). */
function reverseChange(sequence: string): boolean | undefined {
  if (!sequence.startsWith(`${ESC}[`) || !sequence.endsWith("m")) return undefined;
  let change: boolean | undefined;
  for (const param of sequence.slice(2, -1).split(";")) {
    if (param === "7") change = true;
    else if (param === "" || param === "0" || param === "27") change = false;
  }
  return change;
}

/** Reverse-video the visible cells `[from, to)` of a rendered row, preserving its escapes. */
export function paintRow(row: string, spans: readonly { from: number; to: number }[]): string {
  if (spans.length === 0) return row;
  let out = "";
  let visible = 0;
  let active = false;
  // Reverse video the row itself turned on, e.g. Pi's software cursor; never cancel it.
  let rowReverse = false;
  let index = 0;
  while (index < row.length) {
    if (row[index] === ESC) {
      const end = escapeEnd(row, index);
      const sequence = row.slice(index, end);
      out += sequence;
      const change = reverseChange(sequence);
      if (change !== undefined) rowReverse = change;
      if (active && change === false) out += REVERSE_ON;
      index = end;
      continue;
    }
    const inside = spans.some((span) => visible >= span.from && visible < span.to);
    if (inside !== active) {
      if (inside) out += REVERSE_ON;
      else if (!rowReverse) out += REVERSE_OFF;
      active = inside;
    }
    out += row[index];
    visible += 1;
    index += 1;
  }
  return active && !rowReverse ? out + REVERSE_OFF : out;
}

/**
 * Paint logical-line highlights onto rendered editor rows. `rendered[0]` is the top border, so
 * visible row `r` is `rendered[r + 1]`. The last row of a logical line owns its line-end cell.
 */
export function paintHighlights(
  rendered: string[],
  layout: PaintLayout,
  highlights: readonly Highlight[],
): void {
  if (highlights.length === 0) return;
  for (let visibleRow = 0; visibleRow < layout.visibleCount; visibleRow++) {
    const rowIndex = layout.scrollOffset + visibleRow;
    const row = layout.rows[rowIndex];
    const text = rendered[visibleRow + 1];
    if (!row || text === undefined) continue;
    const next = layout.rows[rowIndex + 1];
    const ownsLineEnd = !next || next.line !== row.line;
    const rowEnd = row.startCol + row.length + (ownsLineEnd ? 1 : 0);
    const spans = highlights
      .filter((highlight) => highlight.line === row.line)
      .map((highlight) => ({
        from: layout.paddingX + Math.max(highlight.from, row.startCol) - row.startCol,
        to: layout.paddingX + Math.min(highlight.to, rowEnd) - row.startCol,
      }))
      .filter((span) => span.to > span.from);
    rendered[visibleRow + 1] = paintRow(text, spans);
  }
}
