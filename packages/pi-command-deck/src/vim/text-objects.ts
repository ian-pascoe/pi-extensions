import { findPartner } from "./motions.js";
import { charAt, charClass, lineAt, nextCol, prevCol } from "./text.js";
import type { Position, TextModel, TextRange } from "./types.js";

const PARENS = ["(", ")"] as const;
const SQUARE = ["[", "]"] as const;
const BRACES = ["{", "}"] as const;
const ANGLES = ["<", ">"] as const;
const BRACKET_OBJECTS = new Map<string, readonly [string, string]>([
  ["(", PARENS],
  [")", PARENS],
  ["b", PARENS],
  ["[", SQUARE],
  ["]", SQUARE],
  ["{", BRACES],
  ["}", BRACES],
  ["B", BRACES],
  ["<", ANGLES],
  [">", ANGLES],
]);

const QUOTES = new Set(['"', "'", "`"]);

/** Every key that names a text object after `i` or `a`. */
export function isTextObjectKey(key: string): boolean {
  return BRACKET_OBJECTS.has(key) || QUOTES.has(key) || key === "w" || key === "W" || key === "p";
}

/** The range a text object selects, or undefined when there is none at the cursor. */
export function selectTextObject(
  model: TextModel,
  cursor: Position,
  around: boolean,
  key: string,
  count: number,
): TextRange | undefined {
  if (key === "w" || key === "W") return wordObject(model, cursor, around, key === "W", count);
  if (key === "p") return paragraphObject(model, cursor, around, count);
  if (QUOTES.has(key)) return quoteObject(model, cursor, around, key);
  const pair = BRACKET_OBJECTS.get(key);
  return pair ? bracketObject(model, cursor, around, pair, count) : undefined;
}

function charwiseRange(line: number, from: number, to: number): TextRange {
  return { start: { line, col: from }, end: { line, col: to }, linewise: false };
}

function wordObject(
  model: TextModel,
  cursor: Position,
  around: boolean,
  bigWord: boolean,
  count: number,
): TextRange | undefined {
  const text = lineAt(model, cursor.line);
  if (text === "") return undefined;
  const classOf = (col: number) => charClass(charAt(text, col), bigWord);
  const runEnd = (col: number) => {
    const runClass = classOf(col);
    let end = col;
    while (end < text.length && classOf(end) === runClass) end = nextCol(text, end);
    return end;
  };
  const runStart = (col: number) => {
    const runClass = classOf(col);
    let start = col;
    while (start > 0 && classOf(prevCol(text, start)) === runClass) start = prevCol(text, start);
    return start;
  };
  let start = runStart(cursor.col);
  let end = runEnd(cursor.col);
  const startedOnBlank = classOf(cursor.col) === 0;
  if (!around) {
    for (let index = 1; index < count && end < text.length; index++) end = runEnd(end);
    return charwiseRange(cursor.line, start, end);
  }
  const extend = () => {
    if (end < text.length && classOf(end) === 0) end = runEnd(end);
    if (end < text.length) end = runEnd(end);
  };
  if (startedOnBlank) {
    if (end < text.length) end = runEnd(end);
    for (let index = 1; index < count && end < text.length; index++) extend();
    return charwiseRange(cursor.line, start, end);
  }
  for (let index = 1; index < count && end < text.length; index++) extend();
  if (end < text.length && classOf(end) === 0) end = runEnd(end);
  else if (start > 0 && classOf(prevCol(text, start)) === 0) start = runStart(prevCol(text, start));
  return charwiseRange(cursor.line, start, end);
}

function quoteObject(
  model: TextModel,
  cursor: Position,
  around: boolean,
  quote: string,
): TextRange | undefined {
  const text = lineAt(model, cursor.line);
  const positions: number[] = [];
  let backslashes = 0;
  for (let col = 0; col < text.length; col++) {
    const char = text[col];
    if (char === quote && backslashes % 2 === 0) positions.push(col);
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  let open: number | undefined;
  let close: number | undefined;
  for (let index = 0; index + 1 < positions.length; index += 2) {
    const start = positions[index] ?? 0;
    const end = positions[index + 1] ?? 0;
    if ((start <= cursor.col && cursor.col <= end) || (open === undefined && start > cursor.col)) {
      open = start;
      close = end;
      if (start <= cursor.col) break;
    }
  }
  if (open === undefined || close === undefined) return undefined;
  if (!around) return charwiseRange(cursor.line, open + 1, close);
  let from = open;
  let to = close + 1;
  if (/\s/u.test(text[to] ?? "")) {
    while (/\s/u.test(text[to] ?? "")) to += 1;
  } else {
    while (from > 0 && /\s/u.test(text[from - 1] ?? "")) from -= 1;
  }
  return charwiseRange(cursor.line, from, to);
}

function enclosingOpen(
  model: TextModel,
  from: Position,
  open: string,
  close: string,
): Position | undefined {
  let depth = 0;
  let { line, col } = from;
  col -= 1;
  while (line >= 0) {
    const text = lineAt(model, line);
    for (; col >= 0; col--) {
      const char = text[col];
      if (char === close) depth += 1;
      else if (char === open) {
        if (depth === 0) return { line, col };
        depth -= 1;
      }
    }
    line -= 1;
    col = lineAt(model, line).length - 1;
  }
  return undefined;
}

function bracketObject(
  model: TextModel,
  cursor: Position,
  around: boolean,
  [open, close]: readonly [string, string],
  count: number,
): TextRange | undefined {
  const under = lineAt(model, cursor.line)[cursor.col];
  let openPos: Position | undefined =
    under === open
      ? cursor
      : under === close
        ? findPartner(model, cursor, close)
        : enclosingOpen(model, cursor, open, close);
  for (let level = 1; level < count && openPos; level++)
    openPos = enclosingOpen(model, openPos, open, close);
  if (!openPos) return undefined;
  const closePos =
    open === "<" ? findAngleClose(model, openPos) : findPartner(model, openPos, open);
  if (!closePos) return undefined;
  if (around) {
    return { start: openPos, end: { line: closePos.line, col: closePos.col + 1 }, linewise: false };
  }
  const openLine = lineAt(model, openPos.line);
  const startsAtNextLine = openPos.col + 1 >= openLine.length && openPos.line < closePos.line;
  const endsAtPreviousLine =
    lineAt(model, closePos.line).slice(0, closePos.col).trim() === "" &&
    closePos.line > openPos.line;
  if (startsAtNextLine && endsAtPreviousLine) {
    if (closePos.line - openPos.line < 2) {
      return { start: closePos, end: closePos, linewise: false };
    }
    return {
      start: { line: openPos.line + 1, col: 0 },
      end: { line: closePos.line - 1, col: 0 },
      linewise: true,
    };
  }
  const start = startsAtNextLine
    ? { line: openPos.line + 1, col: 0 }
    : { line: openPos.line, col: openPos.col + 1 };
  const end = endsAtPreviousLine
    ? { line: closePos.line - 1, col: lineAt(model, closePos.line - 1).length }
    : closePos;
  return { start, end, linewise: false };
}

/** `findPartner` only knows `()[]{}`; angle brackets get the same nesting scan. */
function findAngleClose(model: TextModel, openPos: Position): Position | undefined {
  let depth = 0;
  for (let line = openPos.line; line < model.lines.length; line++) {
    const text = lineAt(model, line);
    for (let col = line === openPos.line ? openPos.col : 0; col < text.length; col++) {
      if (text[col] === "<") depth += 1;
      else if (text[col] === ">") {
        depth -= 1;
        if (depth === 0) return { line, col };
      }
    }
  }
  return undefined;
}

function paragraphObject(
  model: TextModel,
  cursor: Position,
  around: boolean,
  count: number,
): TextRange {
  const last = model.lines.length - 1;
  const blank = (line: number) => lineAt(model, line).trim() === "";
  const runEnd = (line: number) => {
    let end = line;
    while (end < last && blank(end + 1) === blank(line)) end += 1;
    return end;
  };
  let start = cursor.line;
  while (start > 0 && blank(start - 1) === blank(cursor.line)) start -= 1;
  let end = runEnd(cursor.line);
  const startedBlank = blank(cursor.line);
  for (let index = 1; index < count && end < last; index++) end = runEnd(end + 1);
  if (around) {
    if (end < last) {
      end = runEnd(end + 1);
    } else if (!startedBlank) {
      while (start > 0 && blank(start - 1)) start -= 1;
    }
  }
  return { start: { line: start, col: 0 }, end: { line: end, col: 0 }, linewise: true };
}
