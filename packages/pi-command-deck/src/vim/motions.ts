import {
  charAt,
  classAt,
  colAtGraphemeIndex,
  firstNonBlankCol,
  graphemeCount,
  graphemeIndex,
  lastCharCol,
  lineAt,
  nextCol,
  prevCol,
  stepBackward,
  stepForward,
} from "./text.js";
import type { Position, TextModel } from "./types.js";

/** Where a motion lands and how an operator treats the span it covers. */
export interface MotionTarget {
  pos: Position;
  linewise: boolean;
  inclusive: boolean;
  /** Keep the preferred column (vertical motions) instead of resetting it to the target. */
  keepCurswant?: boolean;
  /** The new preferred column when it is not the target column, e.g. Infinity for `$`. */
  curswant?: number;
}

/** Inputs shared by every motion. */
export interface MotionContext {
  model: TextModel;
  cursor: Position;
  count: number;
  hasCount: boolean;
  /** True while an operator is pending; some motions stop at line ends for operators. */
  operator: boolean;
  /** Preferred column as a grapheme index. */
  curswant: number;
}

/** Character-find commands. */
export type FindKey = "f" | "F" | "t" | "T";

const charwise = (pos: Position, inclusive = false): MotionTarget => ({
  pos,
  linewise: false,
  inclusive,
});

function lineCol(model: TextModel, line: number, curswant: number, operator: boolean): number {
  const text = lineAt(model, line);
  const limit = operator ? graphemeCount(text) : Math.max(0, graphemeCount(text) - 1);
  return colAtGraphemeIndex(text, Math.min(curswant, limit));
}

function vertical(context: MotionContext, delta: number): MotionTarget | undefined {
  const { model, cursor, count } = context;
  const target = Math.max(0, Math.min(model.lines.length - 1, cursor.line + delta * count));
  if (target === cursor.line) return undefined;
  return {
    pos: { line: target, col: lineCol(model, target, context.curswant, false) },
    linewise: true,
    inclusive: false,
    keepCurswant: true,
  };
}

function wordForward(context: MotionContext, bigWord: boolean): MotionTarget | undefined {
  const { model } = context;
  const pos = { ...context.cursor };
  for (let remaining = context.count; remaining > 0; remaining--) {
    const stopAtEol = context.operator && remaining === 1;
    const startClass = classAt(model, pos, bigWord);
    let step = stepForward(model, pos);
    if (step === -1) return remaining === context.count ? undefined : charwise(pos);
    if (step >= 1 && stopAtEol) return charwise(pos);
    if (startClass !== 0) {
      let stopped = false;
      while (classAt(model, pos, bigWord) === startClass) {
        step = stepForward(model, pos);
        if (step === -1 || (step >= 1 && stopAtEol)) {
          stopped = true;
          break;
        }
      }
      if (stopped) return charwise(pos);
    }
    while (classAt(model, pos, bigWord) === 0) {
      if (pos.col === 0 && lineAt(model, pos.line) === "") break;
      if (stepForward(model, pos) === -1) return charwise(pos);
    }
  }
  return charwise(pos);
}

/** Vim's `e`; `stayInWord` makes `cw` end at the current word instead of the next one. */
export function wordEnd(
  context: MotionContext,
  bigWord: boolean,
  stayInWord = false,
): MotionTarget | undefined {
  const { model } = context;
  const pos = { ...context.cursor };
  let stay = stayInWord;
  for (let remaining = context.count; remaining > 0; remaining--) {
    const startClass = classAt(model, pos, bigWord);
    if (stepForward(model, pos) === -1) return undefined;
    if (classAt(model, pos, bigWord) === startClass && startClass !== 0) {
      while (classAt(model, pos, bigWord) === startClass) {
        if (stepForward(model, pos) === -1) break;
      }
    } else if (!stay || startClass === 0) {
      while (classAt(model, pos, bigWord) === 0) {
        if (stepForward(model, pos) === -1) return charwise(pos, true);
      }
      const wordClass = classAt(model, pos, bigWord);
      while (classAt(model, pos, bigWord) === wordClass) {
        if (stepForward(model, pos) === -1) break;
      }
    }
    stepBackward(model, pos);
    stay = false;
  }
  return charwise(pos, true);
}

function wordBackward(context: MotionContext, bigWord: boolean): MotionTarget | undefined {
  const { model } = context;
  const pos = { ...context.cursor };
  for (let remaining = context.count; remaining > 0; remaining--) {
    if (stepBackward(model, pos) === -1)
      return remaining === context.count ? undefined : charwise(pos);
    let atEmptyLine = false;
    while (classAt(model, pos, bigWord) === 0) {
      if (pos.col === 0 && lineAt(model, pos.line) === "") {
        atEmptyLine = true;
        break;
      }
      if (stepBackward(model, pos) === -1) return charwise(pos);
    }
    if (atEmptyLine) continue;
    const wordClass = classAt(model, pos, bigWord);
    let hitStart = false;
    while (classAt(model, pos, bigWord) === wordClass) {
      if (stepBackward(model, pos) === -1) {
        hitStart = true;
        break;
      }
    }
    if (hitStart) return charwise(pos);
    stepForward(model, pos);
  }
  return charwise(pos);
}

function wordEndBackward(context: MotionContext, bigWord: boolean): MotionTarget | undefined {
  const { model } = context;
  const pos = { ...context.cursor };
  for (let remaining = context.count; remaining > 0; remaining--) {
    const startClass = classAt(model, pos, bigWord);
    if (stepBackward(model, pos) === -1)
      return remaining === context.count ? undefined : charwise(pos, true);
    if (startClass !== 0) {
      while (classAt(model, pos, bigWord) === startClass) {
        if (stepBackward(model, pos) === -1) return charwise(pos, true);
      }
    }
    while (classAt(model, pos, bigWord) === 0) {
      if (pos.col === 0 && lineAt(model, pos.line) === "") break;
      if (stepBackward(model, pos) === -1) return charwise(pos, true);
    }
  }
  return charwise(pos, true);
}

function isEmptyLine(model: TextModel, line: number): boolean {
  return lineAt(model, line).trim() === "";
}

function paragraph(context: MotionContext, direction: 1 | -1): MotionTarget | undefined {
  const { model } = context;
  const last = model.lines.length - 1;
  let line = context.cursor.line;
  for (let remaining = context.count; remaining > 0; remaining--) {
    let skippedText = false;
    for (let first = true; ; first = false) {
      if (!isEmptyLine(model, line)) skippedText = true;
      if (!first && skippedText && isEmptyLine(model, line)) break;
      const next = line + direction;
      if (next < 0 || next > last) break;
      line = next;
    }
  }
  if (direction === 1 && line === last && !isEmptyLine(model, line)) {
    const text = lineAt(model, line);
    return charwise({ line, col: lastCharCol(text) }, text.length > 0);
  }
  if (line === context.cursor.line && context.cursor.col === 0) return undefined;
  return charwise({ line, col: 0 });
}

const OPENERS = "([{";
const CLOSERS = ")]}";

/** The bracket matching the first bracket at or after the cursor on its line. */
function matchBracket(context: MotionContext): MotionTarget | undefined {
  if (context.hasCount) return undefined;
  const { model, cursor } = context;
  const text = lineAt(model, cursor.line);
  let col = cursor.col;
  while (
    col < text.length &&
    !OPENERS.includes(text[col] ?? "") &&
    !CLOSERS.includes(text[col] ?? "")
  ) {
    col += 1;
  }
  const char = text[col];
  if (char === undefined) return undefined;
  const target = findPartner(model, { line: cursor.line, col }, char);
  return target ? charwise(target, true) : undefined;
}

/** The partner of the bracket `char` at `pos`, scanning across lines with nesting. */
export function findPartner(model: TextModel, pos: Position, char: string): Position | undefined {
  const openIndex = OPENERS.indexOf(char);
  const closeIndex = CLOSERS.indexOf(char);
  if (openIndex === -1 && closeIndex === -1) return undefined;
  const forward = openIndex !== -1;
  const open = OPENERS[forward ? openIndex : closeIndex] ?? "";
  const close = CLOSERS[forward ? openIndex : closeIndex] ?? "";
  let depth = 0;
  let { line, col } = pos;
  while (line >= 0 && line < model.lines.length) {
    const text = lineAt(model, line);
    while (col >= 0 && col < text.length) {
      const current = text[col];
      if (current === (forward ? open : close)) depth += 1;
      else if (current === (forward ? close : open)) {
        depth -= 1;
        if (depth === 0) return { line, col };
      }
      col += forward ? 1 : -1;
    }
    line += forward ? 1 : -1;
    col = forward ? 0 : lineAt(model, line).length - 1;
  }
  return undefined;
}

/** `f`, `F`, `t`, `T`; `repeat` skips an adjacent match for `t`/`T` repeated with `;` or `,`. */
export function findChar(
  context: MotionContext,
  key: FindKey,
  char: string,
  repeat: boolean,
): MotionTarget | undefined {
  const text = lineAt(context.model, context.cursor.line);
  const forward = key === "f" || key === "t";
  const till = key === "t" || key === "T";
  let col = context.cursor.col;
  if (till && repeat) col = forward ? nextCol(text, col) : prevCol(text, col);
  for (let remaining = context.count; remaining > 0; remaining--) {
    for (;;) {
      const next = forward ? nextCol(text, col) : col === 0 ? -1 : prevCol(text, col);
      if (next < 0 || next >= text.length) return undefined;
      col = next;
      if (charAt(text, col) === char) break;
    }
  }
  if (till) col = forward ? prevCol(text, col) : nextCol(text, col);
  return charwise({ line: context.cursor.line, col }, forward);
}

/** Motion keys that need no argument; `undefined` means the key is not one of them. */
export function simpleMotion(
  key: string,
  context: MotionContext,
): MotionTarget | undefined | false {
  const { model, cursor, count } = context;
  const text = lineAt(model, cursor.line);
  switch (key) {
    case "h":
    case "<Left>":
    case "<BS>": {
      if (cursor.col === 0) return undefined;
      let col = cursor.col;
      for (let index = 0; index < count && col > 0; index++) col = prevCol(text, col);
      return charwise({ line: cursor.line, col });
    }
    case "l":
    case " ":
    case "<Right>": {
      const limit = context.operator ? text.length : lastCharCol(text);
      let col = cursor.col;
      for (let index = 0; index < count && col < limit; index++) col = nextCol(text, col);
      col = Math.min(col, limit);
      // An operator at the line end gets an empty range, so `s` still changes an empty line.
      if (col === cursor.col && !context.operator) return undefined;
      return charwise({ line: cursor.line, col });
    }
    case "j":
    case "<Down>":
      return vertical(context, 1);
    case "k":
    case "<Up>":
      return vertical(context, -1);
    case "0":
    case "<Home>":
      return charwise({ line: cursor.line, col: 0 });
    case "^":
      return charwise({ line: cursor.line, col: firstNonBlankCol(text) });
    case "_": {
      const line = Math.min(model.lines.length - 1, cursor.line + count - 1);
      return {
        pos: { line, col: firstNonBlankCol(lineAt(model, line)) },
        linewise: true,
        inclusive: false,
      };
    }
    case "$":
    case "<End>": {
      const line = Math.min(model.lines.length - 1, cursor.line + count - 1);
      const lineText = lineAt(model, line);
      return {
        pos: { line, col: lastCharCol(lineText) },
        linewise: false,
        inclusive: lineText.length > 0,
        curswant: Number.POSITIVE_INFINITY,
      };
    }
    case "gg":
    case "G": {
      const fallback = key === "gg" ? 0 : model.lines.length - 1;
      const line = context.hasCount ? Math.min(model.lines.length - 1, count - 1) : fallback;
      return {
        pos: { line, col: firstNonBlankCol(lineAt(model, line)) },
        linewise: true,
        inclusive: false,
      };
    }
    case "w":
    case "W":
      return wordForward(context, key === "W");
    case "b":
    case "B":
      return wordBackward(context, key === "B");
    case "e":
    case "E":
      return wordEnd(context, key === "E");
    case "ge":
    case "gE":
      return wordEndBackward(context, key === "gE");
    case "}":
      return paragraph(context, 1);
    case "{":
      return paragraph(context, -1);
    case "%":
      return matchBracket(context);
    default:
      return false;
  }
}

/** Every key `simpleMotion` recognizes. */
export const SIMPLE_MOTION_KEYS: ReadonlySet<string> = new Set([
  "h",
  "<Left>",
  "<BS>",
  "l",
  " ",
  "<Right>",
  "j",
  "<Down>",
  "k",
  "<Up>",
  "0",
  "<Home>",
  "^",
  "_",
  "$",
  "<End>",
  "gg",
  "G",
  "w",
  "W",
  "b",
  "B",
  "e",
  "E",
  "ge",
  "gE",
  "}",
  "{",
  "%",
]);

/** Exported for the engine's `curswant` bookkeeping. */
export function curswantOf(model: TextModel, pos: Position): number {
  return graphemeIndex(lineAt(model, pos.line), pos.col);
}
