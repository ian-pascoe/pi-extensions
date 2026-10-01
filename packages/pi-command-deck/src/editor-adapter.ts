/*
 * The only module that touches Pi Editor private fields (ADR 0001). Pi's public Editor API has no
 * cursor setter, undo access, history stepping, or layout geometry, which Vim editing needs.
 * Every field is probed at construction; when one is missing, Command Deck falls back to Pi's
 * plain editor. test/editor-adapter.test.ts pins this module against the installed Pi.
 */
import type { Editor } from "@earendil-works/pi-tui";
import type { TextModel } from "./vim/types.js";

interface EditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

/** A detached copy of the editor's text, cursor, and paste registry. */
export interface EditorSnapshot {
  readonly state: EditorState;
  readonly pastes: Map<number, string>;
  readonly pasteCounter: number;
}

/** One rendered row: a slice of a logical line after word wrap. */
export interface VisualRow {
  line: number;
  startCol: number;
  length: number;
}

/** Where logical text landed in the last render. */
export interface EditorLayout {
  rows: VisualRow[];
  scrollOffset: number;
  visibleCount: number;
  paddingX: number;
}

const REQUIRED_METHODS = [
  "pushUndoSnapshot",
  "undo",
  "navigateHistory",
  "exitHistoryBrowsing",
  "buildVisualLineMap",
  "cancelAutocomplete",
  "submitValue",
  "expandPasteMarkers",
] as const;
const REQUIRED_NUMBERS = [
  "historyIndex",
  "pasteCounter",
  "lastWidth",
  "scrollOffset",
  "renderedVisibleLineCount",
] as const;
const REQUIRED_FIELDS = [
  "preferredVisualCol",
  "snappedFromCursorCol",
  "lastAction",
  "isInPaste",
] as const;

/** The private Editor members this adapter needs, or the names of the missing ones. */
function missingInternals(editor: Editor): string[] {
  const missing: string[] = [];
  const state = editor["state"];
  if (
    !state ||
    !Array.isArray(state.lines) ||
    !Number.isInteger(state.cursorLine) ||
    !Number.isInteger(state.cursorCol)
  ) {
    missing.push("state");
  }
  const undoStack = editor["undoStack"];
  if (!undoStack || !Number.isInteger(undoStack.length) || !(undoStack.pop instanceof Function)) {
    missing.push("undoStack");
  }
  if (!(editor["pastes"] instanceof Map)) missing.push("pastes");
  for (const name of REQUIRED_METHODS) if (!(editor[name] instanceof Function)) missing.push(name);
  for (const name of REQUIRED_NUMBERS) if (!Number.isInteger(editor[name])) missing.push(name);
  for (const name of REQUIRED_FIELDS) if (!(name in editor)) missing.push(name);
  return missing;
}

/** Reads and writes a Pi Editor's private text, cursor, undo, history, and layout state. */
export class EditorAdapter {
  private constructor(private readonly editor: Editor) {}

  /** An adapter for `editor`, or the private members that are missing from this Pi version. */
  static probe(editor: Editor): EditorAdapter | { missing: string[] } {
    const missing = missingInternals(editor);
    return missing.length === 0 ? new EditorAdapter(editor) : { missing };
  }

  private get state(): EditorState {
    return this.editor["state"];
  }

  readModel(): TextModel {
    const { lines, cursorLine, cursorCol } = this.state;
    return { lines: [...lines], cursor: { line: cursorLine, col: cursorCol } };
  }

  /**
   * Write a model. A text change exits history browsing and notifies `onChange`; the caller
   * records the undo step first with `pushUndo`.
   */
  writeModel(model: TextModel, textChanged: boolean): void {
    const editor = this.editor;
    if (textChanged) {
      editor["state"] = {
        lines: [...model.lines],
        cursorLine: model.cursor.line,
        cursorCol: model.cursor.col,
      };
      editor["exitHistoryBrowsing"]();
    } else {
      this.state.cursorLine = model.cursor.line;
      this.state.cursorCol = model.cursor.col;
    }
    editor["preferredVisualCol"] = null;
    editor["snappedFromCursorCol"] = null;
    editor["lastAction"] = null;
    if (textChanged) editor.onChange?.(editor.getText());
  }

  /** Record the current text as one undo step. */
  pushUndo(): void {
    this.editor["pushUndoSnapshot"]();
  }

  undoDepth(): number {
    return this.editor["undoStack"].length;
  }

  /** Drop undo steps above `depth`, collapsing them into the step at `depth - 1`. */
  truncateUndo(depth: number): void {
    const stack = this.editor["undoStack"];
    while (stack.length > Math.max(0, depth)) stack.pop();
  }

  /** Undo one step; returns the snapshot redo needs, or undefined when there is nothing to undo. */
  undo(): EditorSnapshot | undefined {
    if (this.undoDepth() === 0) return undefined;
    const current = this.capture();
    this.editor["undo"]();
    return current;
  }

  /** Redo by restoring a snapshot from `undo`, recording the current text as an undo step. */
  redo(snapshot: EditorSnapshot): void {
    this.pushUndo();
    this.restore(snapshot);
  }

  capture(): EditorSnapshot {
    const editor = this.editor;
    return structuredClone({
      state: this.state,
      pastes: editor["pastes"],
      pasteCounter: editor["pasteCounter"],
    });
  }

  restore(snapshot: EditorSnapshot): void {
    const editor = this.editor;
    const copy = structuredClone(snapshot);
    editor["state"] = copy.state;
    editor["pastes"] = copy.pastes;
    editor["pasteCounter"] = copy.pasteCounter;
    editor["preferredVisualCol"] = null;
    editor["snappedFromCursorCol"] = null;
    editor["lastAction"] = null;
    editor["exitHistoryBrowsing"]();
    editor.onChange?.(editor.getText());
  }

  /** Step Pi's prompt history: -1 for older, 1 for newer. */
  navigateHistory(direction: -1 | 1): void {
    this.editor["navigateHistory"](direction);
  }

  /**
   * Call `listener` after every submit through Pi's own path (Enter, backslash-Enter), which
   * clears the prompt and its undo history before `onSubmit` runs.
   */
  observeSubmit(listener: () => void): void {
    const editor = this.editor;
    const submitValue = editor["submitValue"];
    editor["submitValue"] = () => {
      submitValue.call(editor);
      listener();
    };
  }

  /** Submit the prompt exactly as Enter would, without Pi's backslash-Enter newline workaround. */
  submit(): void {
    if (!this.editor.disableSubmit) this.editor["submitValue"]();
  }

  /** Ids of the paste markers Pi currently expands on submit. */
  pasteIds(): ReadonlySet<number> {
    return new Set(this.editor["pastes"].keys());
  }

  /** `text` with paste markers replaced by the content Pi would submit for them. */
  expandPasteMarkers(text: string): string {
    return this.editor["expandPasteMarkers"](text);
  }

  /** Close autocomplete and drop pending suggestion requests, e.g. when leaving insert mode. */
  cancelAutocomplete(): void {
    this.editor["cancelAutocomplete"]();
  }

  /** True while the editor is buffering a bracketed paste. */
  isInPaste(): boolean {
    return this.editor["isInPaste"] === true;
  }

  /** Geometry of the last render at `width`. */
  layout(width: number): EditorLayout {
    const editor = this.editor;
    const map = editor["buildVisualLineMap"](editor["lastWidth"]);
    const rows: VisualRow[] = Array.isArray(map)
      ? map.map((row) => ({ line: row.logicalLine, startCol: row.startCol, length: row.length }))
      : [];
    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    return {
      rows,
      scrollOffset: editor["scrollOffset"],
      visibleCount: editor["renderedVisibleLineCount"],
      paddingX: Math.min(editor.getPaddingX(), maxPadding),
    };
  }
}
