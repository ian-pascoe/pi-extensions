/** A logical cursor position: a line index and a UTF-16 column at a grapheme boundary. */
export interface Position {
  line: number;
  col: number;
}

/** The plain text model the Vim engine edits. */
export interface TextModel {
  lines: string[];
  cursor: Position;
}

/** The editing state that interprets keys. */
export type VimMode = "insert" | "normal" | "replace" | "visual" | "visual-line" | "ex" | "search";

/**
 * One decoded key: a single printable grapheme such as `"a"` or `"$"`, or a named key in angle
 * brackets such as `"<Esc>"`, `"<CR>"`, `"<BS>"`, `"<Del>"`, `"<C-r>"`, `"<Left>"`.
 */
export type VimKey = string;

/** A side effect the host must perform after a key. */
export type VimEffect =
  | { kind: "notify"; message: string; level: "info" | "warning" }
  | { kind: "quit" }
  | { kind: "dispatch"; text: string }
  /** A yank: the host copies the text (linewise text ends in a newline) to the system clipboard. */
  | { kind: "yank"; text: string }
  | { kind: "history"; direction: -1 | 1; count: number }
  | { kind: "undo"; count: number }
  | { kind: "redo"; count: number };

/** The outcome of one key. */
export interface KeyResult {
  /** False when the key belongs to the host editor (insert-mode typing). */
  handled: boolean;
  /** The model after the key; equal to the input model when nothing changed. */
  model: TextModel;
  /** True when the text changed; the host records one undo step for it. */
  textChanged: boolean;
  effects: VimEffect[];
}

/** A highlighted span on one logical line; `to` may be `line.length + 1` to paint the line-end cell. */
export interface Highlight {
  line: number;
  from: number;
  to: number;
}

/** A buffer range; charwise ranges are `[start, end)`, linewise ranges cover `start.line..end.line`. */
export interface TextRange {
  start: Position;
  end: Position;
  linewise: boolean;
}
