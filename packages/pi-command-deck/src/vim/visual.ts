import type { EditOutcome } from "./operators.js";
import {
  colAtGraphemeIndex,
  firstNonBlankCol,
  fromOffset,
  graphemeIndex,
  lastCharCol,
  lineAt,
  nextCol,
  orderPositions,
  rangeText,
  spliceText,
  toOffset,
} from "./text.js";
import type { Highlight, Position, TextModel, TextRange } from "./types.js";

/** A live or remembered visual selection. */
export interface VisualSelection {
  anchor: Position;
  cursor: Position;
  mode: "visual" | "visual-line";
}

/** The extent of a visual change, replayed from the cursor by `.`. */
export interface VisualSize {
  mode: "visual" | "visual-line";
  lines: number;
  /** Grapheme index of the selection end: relative to its start on one line, else absolute. */
  endIndex: number;
}

/** The range a selection covers; a charwise selection ending on a line end takes the newline. */
export function selectionRange(model: TextModel, selection: VisualSelection): TextRange {
  const [start, end] = orderPositions(selection.anchor, selection.cursor);
  if (selection.mode === "visual-line") return { start, end, linewise: true };
  const text = lineAt(model, end.line);
  if (end.col < text.length) {
    return { start, end: { line: end.line, col: nextCol(text, end.col) }, linewise: false };
  }
  if (end.line < model.lines.length - 1) {
    return { start, end: { line: end.line + 1, col: 0 }, linewise: false };
  }
  return { start, end: { line: end.line, col: text.length }, linewise: false };
}

/** Per-line highlight spans for a selection; empty lines and line ends get one cell. */
export function selectionHighlights(model: TextModel, selection: VisualSelection): Highlight[] {
  const [start, end] = orderPositions(selection.anchor, selection.cursor);
  const highlights: Highlight[] = [];
  for (let line = start.line; line <= end.line; line++) {
    const text = lineAt(model, line);
    if (selection.mode === "visual-line") {
      highlights.push({ line, from: 0, to: Math.max(1, text.length) });
      continue;
    }
    const from = line === start.line ? start.col : 0;
    const lastCell = end.col < text.length ? nextCol(text, end.col) : text.length + 1;
    const to = line === end.line ? lastCell : text.length + 1;
    if (to > from) highlights.push({ line, from, to });
  }
  return highlights;
}

export function measureSelection(model: TextModel, selection: VisualSelection): VisualSize {
  const [start, end] = orderPositions(selection.anchor, selection.cursor);
  const lines = end.line - start.line + 1;
  const endIndex = graphemeIndex(lineAt(model, end.line), end.col);
  return {
    mode: selection.mode,
    lines,
    endIndex:
      lines === 1 ? endIndex - graphemeIndex(lineAt(model, start.line), start.col) : endIndex,
  };
}

/** A selection of the same size as `size`, anchored at the cursor. */
export function selectionLike(model: TextModel, size: VisualSize): VisualSelection {
  const { cursor } = model;
  const line = Math.min(model.lines.length - 1, cursor.line + size.lines - 1);
  const text = lineAt(model, line);
  const index = size.lines === 1 ? graphemeIndex(text, cursor.col) + size.endIndex : size.endIndex;
  return {
    anchor: { ...cursor },
    cursor: { line, col: Math.min(colAtGraphemeIndex(text, index), lastCharCol(text)) },
    mode: size.mode,
  };
}

/** Visual `p`: replace a range with the register; `register` in the result is the replaced text. */
export function putOverRange(model: TextModel, range: TextRange, register: string): EditOutcome {
  if (register === "") return { model, textChanged: false };
  const linewiseRegister = register.endsWith("\n");
  if (range.linewise) {
    const block = (linewiseRegister ? register.slice(0, -1) : register).split("\n");
    const lines = [
      ...model.lines.slice(0, range.start.line),
      ...block,
      ...model.lines.slice(range.end.line + 1),
    ];
    const cursor = { line: range.start.line, col: firstNonBlankCol(lines[range.start.line] ?? "") };
    return { model: { lines, cursor }, textChanged: true, register: rangeText(model, range) };
  }
  const insert = linewiseRegister ? `\n${register}` : register;
  const lines = spliceText(model.lines, range.start, range.end, insert);
  const cursor = linewiseRegister
    ? { line: range.start.line + 1, col: 0 }
    : fromOffset(lines, toOffset(model.lines, range.start) + Math.max(0, insert.length - 1));
  return { model: { lines, cursor }, textChanged: true, register: rangeText(model, range) };
}
