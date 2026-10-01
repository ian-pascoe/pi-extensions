import {
  charAt,
  firstNonBlankCol,
  firstNonBlankOf,
  fromOffset,
  graphemeCount,
  lastCharCol,
  lineAt,
  nextCol,
  pasteMarkerSpans,
  rangeText,
  spliceText,
  toOffset,
} from "./text.js";
import type { Position, TextModel, TextRange } from "./types.js";

/** Operators that take a motion or text object. */
export type Operator = "d" | "c" | "y" | "g~" | "gu" | "gU";

/** The result of an edit on the text model. */
export interface EditOutcome {
  model: TextModel;
  textChanged: boolean;
  /** New unnamed-register contents, when the edit writes the register. */
  register?: string;
  /** True when the edit leaves the engine in insert mode. */
  insert?: boolean;
}

export function isOperator(key: string): key is Operator {
  return key === "d" || key === "c" || key === "y" || key === "g~" || key === "gu" || key === "gU";
}

type CaseOperator = "g~" | "gu" | "gU";

function transformPlainCase(text: string, operator: CaseOperator): string {
  if (operator === "gu") return text.toLowerCase();
  if (operator === "gU") return text.toUpperCase();
  return text.replace(/\p{L}/gu, (char) => {
    const upper = char.toUpperCase();
    return upper === char ? char.toLowerCase() : upper;
  });
}

/** Change case everywhere except inside paste markers, whose text Pi matches exactly. */
function transformCase(text: string, operator: CaseOperator): string {
  let result = "";
  let last = 0;
  for (const [from, to] of pasteMarkerSpans(text)) {
    result += transformPlainCase(text.slice(last, from), operator) + text.slice(from, to);
    last = to;
  }
  return result + transformPlainCase(text.slice(last), operator);
}

/**
 * Apply an operator to a range. `cursor` is where the command started; `visual` ranges keep
 * their charwise or linewise kind exactly as selected.
 */
export function applyOperator(
  model: TextModel,
  operator: Operator,
  range: TextRange,
  cursor: Position,
  visual: boolean,
): EditOutcome {
  const text = rangeText(model, range);
  if (operator === "y") {
    const col = range.linewise && cursor.line === range.start.line ? cursor.col : range.start.col;
    return {
      model: { lines: model.lines, cursor: { line: range.start.line, col } },
      textChanged: false,
      register: text,
    };
  }
  if (operator === "d") {
    const deletion = visual ? range : toLinewiseDelete(model, range);
    return deleteRange(model, deletion, rangeText(model, deletion));
  }
  if (operator === "c") return changeRange(model, range, text);
  return caseRange(model, range, operator);
}

/**
 * Vim turns a multi-line charwise delete into a linewise one when only blanks precede the start
 * and nothing but blanks follows the end.
 */
function toLinewiseDelete(model: TextModel, range: TextRange): TextRange {
  if (range.linewise || range.start.line === range.end.line) return range;
  const before = lineAt(model, range.start.line).slice(0, range.start.col);
  const after = lineAt(model, range.end.line).slice(range.end.col);
  if (before.trim() !== "" || after.trim() !== "") return range;
  return { ...range, linewise: true };
}

function deleteRange(model: TextModel, range: TextRange, register: string): EditOutcome {
  if (range.linewise) {
    const lines = model.lines.filter(
      (_, index) => index < range.start.line || index > range.end.line,
    );
    const remaining = lines.length === 0 ? [""] : lines;
    const line = Math.min(range.start.line, remaining.length - 1);
    return {
      model: { lines: remaining, cursor: firstNonBlankOf(remaining, line) },
      textChanged: true,
      register,
    };
  }
  const lines = spliceText(model.lines, range.start, range.end, "");
  return {
    model: { lines, cursor: { ...range.start } },
    textChanged: register !== "",
    register,
  };
}

function changeRange(model: TextModel, range: TextRange, register: string): EditOutcome {
  if (range.linewise) {
    const lines = [
      ...model.lines.slice(0, range.start.line),
      "",
      ...model.lines.slice(range.end.line + 1),
    ];
    return {
      model: { lines, cursor: { line: range.start.line, col: 0 } },
      textChanged: true,
      register,
      insert: true,
    };
  }
  const lines = spliceText(model.lines, range.start, range.end, "");
  return {
    model: { lines, cursor: { ...range.start } },
    textChanged: register !== "",
    register,
    insert: true,
  };
}

function caseRange(model: TextModel, range: TextRange, operator: CaseOperator): EditOutcome {
  const start = range.linewise ? { line: range.start.line, col: 0 } : range.start;
  const end = range.linewise
    ? { line: range.end.line, col: lineAt(model, range.end.line).length }
    : range.end;
  const original = rangeText(model, { start, end, linewise: false });
  const lines = spliceText(model.lines, start, end, transformCase(original, operator));
  return {
    model: { lines, cursor: { ...start } },
    textChanged: lines.join("\n") !== model.lines.join("\n"),
  };
}

/** `p` and `P`: text ending in a newline is put linewise. */
export function put(
  model: TextModel,
  register: string,
  after: boolean,
  count: number,
): EditOutcome {
  if (register === "") return { model, textChanged: false };
  const { cursor } = model;
  if (register.endsWith("\n")) {
    const block = register.slice(0, -1).split("\n");
    const inserted = Array.from({ length: count }, () => block).flat();
    const at = after ? cursor.line + 1 : cursor.line;
    const lines = [...model.lines.slice(0, at), ...inserted, ...model.lines.slice(at)];
    return { model: { lines, cursor: firstNonBlankOf(lines, at) }, textChanged: true };
  }
  const text = register.repeat(count);
  const line = lineAt(model, cursor.line);
  const col = after && line.length > 0 ? nextCol(line, cursor.col) : cursor.col;
  const at = { line: cursor.line, col };
  const lines = spliceText(model.lines, at, at, text);
  const startOffset = toOffset(model.lines, at);
  const end = fromOffset(lines, startOffset + text.length);
  const landing = text.includes("\n") ? at : { line: end.line, col: Math.max(0, end.col - 1) };
  return { model: { lines, cursor: landing }, textChanged: true };
}

/** `J` and `gJ`: join `count` lines (at least two) starting at the cursor line. */
export function joinLines(model: TextModel, count: number, normalize: boolean): EditOutcome {
  const first = model.cursor.line;
  const lastLine = Math.min(model.lines.length - 1, first + Math.max(2, count) - 1);
  if (lastLine === first) return { model, textChanged: false };
  let joined = lineAt(model, first);
  let col = 0;
  for (let line = first + 1; line <= lastLine; line++) {
    const next = lineAt(model, line);
    if (!normalize) {
      col = joined.length;
      joined += next;
      continue;
    }
    const trimmed = next.replace(/^\s+/u, "");
    const needsSpace =
      trimmed !== "" && joined !== "" && !/\s$/u.test(joined) && !trimmed.startsWith(")");
    col = trimmed === "" ? Math.max(0, joined.length - 1) : joined.length;
    joined += `${needsSpace ? " " : ""}${trimmed}`;
  }
  const lines = [...model.lines.slice(0, first), joined, ...model.lines.slice(lastLine + 1)];
  return {
    model: { lines, cursor: { line: first, col: Math.min(col, lastCharCol(joined)) } },
    textChanged: true,
  };
}

/** `r{char}`: replace `count` characters; a line break replaces them with one newline. */
export function replaceChars(model: TextModel, char: string, count: number): EditOutcome {
  const { cursor } = model;
  const line = lineAt(model, cursor.line);
  let end = cursor.col;
  for (let index = 0; index < count; index++) {
    if (end >= line.length) return { model, textChanged: false };
    end = nextCol(line, end);
  }
  const start = { line: cursor.line, col: cursor.col };
  const stop = { line: cursor.line, col: end };
  if (char === "\n") {
    const lines = spliceText(model.lines, start, stop, "\n");
    return { model: { lines, cursor: { line: cursor.line + 1, col: 0 } }, textChanged: true };
  }
  const lines = spliceText(model.lines, start, stop, char.repeat(count));
  const last = cursor.col + char.length * (count - 1);
  return { model: { lines, cursor: { line: cursor.line, col: last } }, textChanged: true };
}

/** `~`: toggle the case of `count` characters and advance past them. */
export function toggleCase(model: TextModel, count: number): EditOutcome {
  const { cursor } = model;
  const line = lineAt(model, cursor.line);
  if (line === "") return { model, textChanged: false };
  let end = cursor.col;
  for (let index = 0; index < count && end < line.length; index++) end = nextCol(line, end);
  const replaced = transformCase(line.slice(cursor.col, end), "g~");
  const updated = `${line.slice(0, cursor.col)}${replaced}${line.slice(end)}`;
  const lines = model.lines.map((text, index) => (index === cursor.line ? updated : text));
  const col = Math.min(cursor.col + replaced.length, lastCharCol(updated));
  return {
    model: { lines, cursor: { line: cursor.line, col } },
    textChanged: updated !== line,
  };
}

/** Replace every character of a range (keeping line breaks) with `char`. */
export function replaceRange(model: TextModel, range: TextRange, char: string): EditOutcome {
  const start = range.linewise ? { line: range.start.line, col: 0 } : range.start;
  const end = range.linewise
    ? { line: range.end.line, col: lineAt(model, range.end.line).length }
    : range.end;
  const original = rangeText(model, { start, end, linewise: false });
  const replaced = original
    .split("\n")
    .map((segment) => char.repeat(graphemeCount(segment)))
    .join("\n");
  const lines = spliceText(model.lines, start, end, replaced);
  return { model: { lines, cursor: { ...start } }, textChanged: replaced !== original };
}

/** Open a new empty line below (or above) the cursor line. */
export function openLine(model: TextModel, below: boolean): TextModel {
  const at = below ? model.cursor.line + 1 : model.cursor.line;
  return {
    lines: [...model.lines.slice(0, at), "", ...model.lines.slice(at)],
    cursor: { line: at, col: 0 },
  };
}

/** Where `I`, `A`, `a`, and `i` place the insert cursor. */
export function insertCursor(model: TextModel, key: "i" | "a" | "I" | "A"): Position {
  const { cursor } = model;
  const line = lineAt(model, cursor.line);
  if (key === "I") return { line: cursor.line, col: firstNonBlankCol(line) };
  if (key === "A") return { line: cursor.line, col: line.length };
  if (key === "a")
    return {
      line: cursor.line,
      col: charAt(line, cursor.col) === "" ? cursor.col : nextCol(line, cursor.col),
    };
  return { ...cursor };
}
