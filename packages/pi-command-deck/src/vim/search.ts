import { charAt, charClass, fromOffset, lineAt, nextCol, prevCol, toOffset } from "./text.js";
import type { Highlight, Position, TextModel } from "./types.js";

/** A literal search pattern; whole-word patterns come from `*` and `#`. */
export interface SearchPattern {
  text: string;
  wholeWord: boolean;
}

const KEYWORD_CLASS = 2;

function isKeywordAt(text: string, offset: number): boolean {
  return offset >= 0 && charClass(charAt(text, offset), false) === KEYWORD_CLASS;
}

function isKeywordBefore(text: string, offset: number): boolean {
  return offset > 0 && isKeywordAt(text, prevCol(text, offset));
}

/** Start offsets of every match in the newline-joined text. */
function matchOffsets(text: string, pattern: SearchPattern): number[] {
  if (pattern.text === "") return [];
  const offsets: number[] = [];
  for (
    let index = text.indexOf(pattern.text);
    index !== -1;
    index = text.indexOf(pattern.text, index + 1)
  ) {
    if (
      pattern.wholeWord &&
      (isKeywordBefore(text, index) || isKeywordAt(text, index + pattern.text.length))
    ) {
      continue;
    }
    offsets.push(index);
  }
  return offsets;
}

/** The next match start strictly after (or before) `from`, wrapping around the buffer. */
export function findMatch(
  model: TextModel,
  from: Position,
  pattern: SearchPattern,
  direction: 1 | -1,
): { pos: Position; wrapped: boolean } | undefined {
  const offsets = matchOffsets(model.lines.join("\n"), pattern);
  if (offsets.length === 0) return undefined;
  const origin = toOffset(model.lines, from);
  const direct =
    direction === 1
      ? offsets.find((offset) => offset > origin)
      : offsets.findLast((offset) => offset < origin);
  const target = direct ?? (direction === 1 ? offsets[0] : offsets.at(-1));
  if (target === undefined) return undefined;
  return { pos: fromOffset(model.lines, target), wrapped: direct === undefined };
}

/** Every match of a pattern as per-line highlights. */
export function matchHighlights(model: TextModel, pattern: SearchPattern): Highlight[] {
  const text = model.lines.join("\n");
  return matchOffsets(text, pattern).flatMap((offset) => {
    const start = fromOffset(model.lines, offset);
    const end = fromOffset(model.lines, offset + pattern.text.length);
    const highlights: Highlight[] = [];
    for (let line = start.line; line <= end.line; line++) {
      const from = line === start.line ? start.col : 0;
      const to = line === end.line ? end.col : lineAt(model, line).length + 1;
      if (to > from) highlights.push({ line, from, to });
    }
    return highlights;
  });
}

/** The keyword under or after the cursor (or the non-blank run when no keyword follows). */
export function wordUnderCursor(model: TextModel): SearchPattern | undefined {
  const line = lineAt(model, model.cursor.line);
  const findRun = (keywordOnly: boolean): SearchPattern | undefined => {
    let col = model.cursor.col;
    const matches = (char: string) =>
      keywordOnly ? charClass(char, false) === KEYWORD_CLASS : charClass(char, true) !== 0;
    while (col < line.length && !matches(charAt(line, col))) col = nextCol(line, col);
    if (col >= line.length) return undefined;
    let start = col;
    while (start > 0 && matches(charAt(line, prevCol(line, start)))) start = prevCol(line, start);
    let end = col;
    while (end < line.length && matches(charAt(line, end))) end = nextCol(line, end);
    return { text: line.slice(start, end), wholeWord: keywordOnly };
  };
  return findRun(true) ?? findRun(false);
}
