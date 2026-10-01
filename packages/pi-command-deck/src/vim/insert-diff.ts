import { fromOffset, toOffset } from "./text.js";
import type { TextModel } from "./types.js";

/** Text typed during an insert session, relative to where the session started. */
export interface InsertDiff {
  /** UTF-16 units removed before the start, e.g. by Backspace. */
  deleteBefore: number;
  /** UTF-16 units removed after the start. */
  deleteAfter: number;
  text: string;
}

/** Compute what an insert session typed by diffing its start and end text around the start offset. */
export function diffInsert(before: string, after: string, startOffset: number): InsertDiff {
  let prefix = 0;
  const limit = Math.min(before.length, after.length, startOffset);
  while (prefix < limit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (before.length - suffix < startOffset) suffix = before.length - startOffset;
  return {
    deleteBefore: startOffset - prefix,
    deleteAfter: before.length - suffix - startOffset,
    text: after.slice(prefix, after.length - suffix),
  };
}

export function isEmptyDiff(diff: InsertDiff): boolean {
  return diff.deleteBefore === 0 && diff.deleteAfter === 0 && diff.text === "";
}

/** Replay a diff at the cursor, leaving the cursor after the inserted text. */
export function applyInsertDiff(model: TextModel, diff: InsertDiff): TextModel {
  const offset = toOffset(model.lines, model.cursor);
  const text = model.lines.join("\n");
  const from = Math.max(0, offset - diff.deleteBefore);
  const to = Math.min(text.length, offset + diff.deleteAfter);
  const lines = `${text.slice(0, from)}${diff.text}${text.slice(to)}`.split("\n");
  return { lines, cursor: fromOffset(lines, from + diff.text.length) };
}
