import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  parseKey,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { TerminalCursor, stripSoftwareCursor } from "./cursor-shape.js";
import { EditorAdapter, type EditorSnapshot } from "./editor-adapter.js";
import { VimEngine } from "./vim/engine.js";
import { paintHighlights } from "./vim/row-paint.js";
import { clampNormalCursor } from "./vim/text.js";
import type { KeyResult, VimEffect, VimKey, VimMode } from "./vim/types.js";

/** What the Vim editor needs from Pi. */
export interface VimEditorHost {
  /** Show a user-visible notice, e.g. ex errors (warning) or a missing search match (info). */
  notify(message: string, level: "info" | "warning"): void;
  /** Quit Pi (the `:q` family). */
  quit(): void;
  /** True when `/name` is a known Pi slash command (builtin or extension). */
  isPiCommand(name: string): boolean;
  /** Copy yanked text to the system clipboard. */
  copy(text: string): void;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const NAMED_KEYS = new Map<string, VimKey>([
  ["escape", "<Esc>"],
  ["ctrl+[", "<Esc>"],
  ["enter", "<CR>"],
  ["return", "<CR>"],
  ["backspace", "<BS>"],
  ["ctrl+h", "<BS>"],
  ["delete", "<Del>"],
  ["tab", "<Tab>"],
  ["left", "<Left>"],
  ["right", "<Right>"],
  ["up", "<Up>"],
  ["down", "<Down>"],
  ["home", "<Home>"],
  ["end", "<End>"],
  ["ctrl+r", "<C-r>"],
  ["ctrl+u", "<C-u>"],
  ["ctrl+w", "<C-w>"],
  ["space", " "],
]);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isPrintableText(data: string): boolean {
  if (data === "") return false;
  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function stripControls(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code !== 0x7f) result += text[index];
  }
  return result;
}

/** Decode raw terminal input into Vim keys. */
function decodeKeys(data: string): VimKey[] {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return [kitty];
  const id = parseKey(data);
  const named = id === undefined ? undefined : NAMED_KEYS.get(id);
  if (named !== undefined) return [named];
  if (!isPrintableText(data)) return [];
  return [...graphemeSegmenter.segment(data)].map((segment) => segment.segment);
}

function isEscape(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
}

const isSession = (mode: VimMode) => mode === "insert" || mode === "replace";

/**
 * Pi's editor with Vim Modes. Insert-mode typing stays with Pi (autocomplete, paste, history);
 * every other mode runs through the pure Vim engine, applied via the editor adapter. When the
 * adapter cannot reach Pi's editor internals it behaves exactly like Pi's plain editor.
 */
export class VimEditor extends CustomEditor {
  private readonly bindings: KeybindingsManager;
  private readonly host: VimEditorHost;
  private readonly adapter: EditorAdapter | undefined;
  private readonly engine: VimEngine | undefined;
  private readonly terminalCursor: TerminalCursor | undefined;
  private redoStack: EditorSnapshot[] = [];
  private sessionFloor = 0;
  private discardedPaste: string | undefined;
  private pasteEscapes = 0;
  private dispatching = false;
  private dispatchDraft: (() => void) | undefined;
  private pendingDispatches = 0;
  private latestDraft: (() => void) | undefined;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, host: VimEditorHost) {
    super(tui, theme, keybindings);
    this.bindings = keybindings;
    this.host = host;
    const probe = EditorAdapter.probe(this);
    if (probe instanceof EditorAdapter) {
      this.adapter = probe;
      this.engine = new VimEngine({ isPiCommand: (name) => host.isPiCommand(name) });
      this.engine.resetToInsert(probe.readModel());
      this.sessionFloor = probe.undoDepth();
      this.terminalCursor = new TerminalCursor(tui);
      probe.observeSubmit(() => this.afterSubmit());
    } else {
      host.notify(
        `Vim Mode is unavailable because Pi's editor changed (missing ${probe.missing.join(", ")}); using the plain editor. Run /skill:pi-command-deck to diagnose.`,
        "warning",
      );
    }
  }

  /** Plain (uncolored) Mode Rail label, e.g. "INSERT" or "NORMAL 3d"; undefined in fallback mode. */
  getModeLabel(): string | undefined {
    return this.engine?.modeLabel();
  }

  /** Restore the terminal cursor; pass the session_shutdown event. Idempotent. */
  restoreTerminalCursor(event?: { reason?: string }): void {
    this.terminalCursor?.restore(event);
  }

  override setText(text: string): void {
    super.setText(text);
    const { adapter, engine } = this;
    if (!adapter || !engine) return;
    if (this.dispatching) {
      // Pi clears the prompt mid-dispatch and may hand that text to the next editor at once.
      if (text === "") this.dispatchDraft?.();
      return;
    }
    this.discardedPaste = undefined;
    this.redoStack = [];
    engine.resetToInsert(adapter.readModel());
    this.sessionFloor = adapter.undoDepth();
  }

  override insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(text);
    this.redoStack = [];
    this.clampOutsideInsert();
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const result = super.handleMouse(event);
    this.clampOutsideInsert();
    return result;
  }

  override handleInput(data: string): void {
    const { adapter, engine } = this;
    if (!adapter || !engine) {
      super.handleInput(data);
      return;
    }
    try {
      this.route(data, adapter, engine);
    } finally {
      this.refreshPendingDraft();
    }
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const { adapter, engine, terminalCursor: cursor } = this;
    if (!adapter || !engine || !cursor) return lines;
    cursor.sync(isSession(engine.mode) ? "bar" : "block");
    if (cursor.active) stripSoftwareCursor(lines);
    const highlights = engine.highlights(adapter.readModel(), adapter.pasteIds());
    if (highlights.length > 0) paintHighlights(lines, adapter.layout(width), highlights);
    return lines;
  }

  private route(data: string, adapter: EditorAdapter, engine: VimEngine): void {
    if (
      this.discardedPaste !== undefined ||
      (engine.mode !== "insert" && data.includes(PASTE_START))
    ) {
      this.absorbPaste(data, adapter, engine);
      return;
    }
    if (engine.mode === "insert") {
      this.routeInsert(data, adapter, engine);
      return;
    }
    if (isEscape(data)) {
      if (engine.mode !== "normal" || engine.hasPending()) this.feed("<Esc>", adapter, engine);
      // An idle Escape reaches Pi only when the user binds it to interrupt.
      else if (this.bindings.matches(data, "app.interrupt")) this.interrupt();
      return;
    }
    if (this.bindings.matches(data, "app.interrupt")) {
      this.cancelVim(adapter, engine);
      this.interrupt();
      return;
    }
    if (this.onExtensionShortcut?.(data)) {
      this.cancelVim(adapter, engine);
      return;
    }
    if (
      engine.mode === "normal" &&
      !engine.hasPending() &&
      this.bindings.matches(data, "tui.input.submit")
    ) {
      // Normal-mode Enter only submits; Pi's backslash-Enter workaround would edit the text.
      adapter.submit();
      return;
    }
    if (this.isHostAction(data)) {
      this.cancelVim(adapter, engine);
      CustomEditor.prototype.handleInput.call(this, data);
      this.clampOutsideInsert();
      return;
    }
    const keys = this.bindings.matches(data, "tui.editor.undo") ? ["<Undo>"] : decodeKeys(data);
    for (const key of keys) this.feed(key, adapter, engine);
  }

  private routeInsert(data: string, adapter: EditorAdapter, engine: VimEngine): void {
    if (!adapter.isInPaste() && isEscape(data)) {
      // Escape closes autocomplete through Pi and also leaves insert mode.
      if (this.isShowingAutocomplete()) CustomEditor.prototype.handleInput.call(this, data);
      adapter.cancelAutocomplete();
      this.feed("<Esc>", adapter, engine);
      return;
    }
    const before = this.getText();
    super.handleInput(data);
    // Pi's own undo can drop below the session floor; typing invalidates Vim redo.
    this.sessionFloor = Math.min(this.sessionFloor, adapter.undoDepth());
    if (this.getText() !== before) this.redoStack = [];
  }

  private isHostAction(data: string): boolean {
    if (
      this.bindings.matches(data, "app.exit") ||
      this.bindings.matches(data, "app.clipboard.pasteImage")
    ) {
      return true;
    }
    for (const action of this.actionHandlers.keys())
      if (this.bindings.matches(data, action)) return true;
    return false;
  }

  /** After Pi handled a key: a submit empties the prompt and its undo history, so restart insert. */
  /** Pi submitted the prompt through its own path: start a fresh insert session. */
  private afterSubmit(): void {
    const { adapter, engine } = this;
    if (!adapter || !engine) return;
    this.redoStack = [];
    engine.resetToInsert(adapter.readModel());
    this.sessionFloor = adapter.undoDepth();
  }

  /** Keep the cursor on a character after Pi moved it outside insert mode. */
  private clampOutsideInsert(): void {
    const { adapter, engine } = this;
    if (!adapter || !engine || engine.mode === "insert") return;
    const model = adapter.readModel();
    adapter.writeModel({ lines: model.lines, cursor: clampNormalCursor(model) }, false);
  }

  private interrupt(): void {
    (this.onEscape ?? this.actionHandlers.get("app.interrupt"))?.();
  }

  private cancelVim(adapter: EditorAdapter, engine: VimEngine): void {
    if (!engine.hasPending()) return;
    const before = engine.mode;
    this.apply(engine.cancel(adapter.readModel(), adapter.pasteIds()), before, adapter, engine);
  }

  private feed(key: VimKey, adapter: EditorAdapter, engine: VimEngine): void {
    const before = engine.mode;
    const result = engine.handleKey(key, adapter.readModel(), adapter.pasteIds());
    this.apply(result, before, adapter, engine);
  }

  /** Apply an engine result: one undo step per change, one per whole insert or replace session. */
  private apply(
    result: KeyResult,
    before: VimMode,
    adapter: EditorAdapter,
    engine: VimEngine,
  ): void {
    const depth = adapter.undoDepth();
    if (result.textChanged) {
      adapter.pushUndo();
      this.redoStack = [];
    }
    adapter.writeModel(result.model, result.textChanged);
    const after = engine.mode;
    if (!isSession(before) && isSession(after)) this.sessionFloor = depth;
    if (isSession(before) && !isSession(after)) {
      adapter.truncateUndo(this.sessionFloor + 1);
      if (adapter.undoDepth() > this.sessionFloor) this.redoStack = [];
    }
    for (const effect of result.effects) this.applyEffect(effect, adapter);
  }

  private applyEffect(effect: VimEffect, adapter: EditorAdapter): void {
    switch (effect.kind) {
      case "notify":
        this.host.notify(effect.message, effect.level);
        return;
      case "quit":
        this.host.quit();
        return;
      case "dispatch":
        this.dispatch(effect.text, adapter);
        return;
      case "yank":
        this.host.copy(adapter.expandPasteMarkers(effect.text));
        return;
      case "history":
        for (let step = 0; step < effect.count; step++) adapter.navigateHistory(effect.direction);
        this.redoStack = [];
        break;
      case "undo":
        for (let step = 0; step < effect.count; step++) {
          const snapshot = adapter.undo();
          if (!snapshot) break;
          this.redoStack.push(snapshot);
        }
        break;
      case "redo":
        for (let step = 0; step < effect.count; step++) {
          const snapshot = this.redoStack.pop();
          if (!snapshot) break;
          adapter.redo(snapshot);
        }
        break;
    }
    const model = adapter.readModel();
    adapter.writeModel({ lines: model.lines, cursor: clampNormalCursor(model) }, false);
  }

  /** Paste is text input, so outside insert mode it is discarded; ex and search keep line one. */
  private absorbPaste(data: string, adapter: EditorAdapter, engine: VimEngine): void {
    let buffer = data;
    if (this.discardedPaste !== undefined && isEscape(data)) {
      // Two Escapes abandon a paste whose end marker never arrived.
      this.pasteEscapes += 1;
      if (this.pasteEscapes >= 2) this.discardedPaste = undefined;
      return;
    }
    this.pasteEscapes = 0;
    if (this.discardedPaste === undefined) {
      const start = data.indexOf(PASTE_START);
      const before = data.slice(0, start);
      if (before !== "") this.route(before, adapter, engine);
      buffer = data.slice(start + PASTE_START.length);
    } else {
      buffer = this.discardedPaste + data;
    }
    const end = buffer.indexOf(PASTE_END);
    if (end === -1) {
      this.discardedPaste = buffer;
      return;
    }
    this.discardedPaste = undefined;
    if (engine.mode === "ex" || engine.mode === "search") {
      const firstLine = buffer.slice(0, end).split(/\r\n|\r|\n/u)[0] ?? "";
      engine.appendLineInput(stripControls(firstLine));
    }
    const rest = buffer.slice(end + PASTE_END.length);
    if (rest !== "") this.route(rest, adapter, engine);
  }

  /**
   * Run `/name args` or `!cmd` through Pi's submit path, then restore the draft exactly: text,
   * cursor, paste markers, undo depth, and redo. Async routes may clear the prompt after awaiting,
   * so the latest draft is restored again when they settle.
   */
  private dispatch(text: string, adapter: EditorAdapter): void {
    const submit = this.onSubmit;
    if (!submit) return;
    const restore = this.captureDraft(adapter);
    let outcome: unknown;
    this.dispatching = true;
    this.dispatchDraft = restore;
    try {
      const lines = text.split("\n");
      const line = lines.length - 1;
      adapter.writeModel({ lines, cursor: { line, col: (lines[line] ?? "").length } }, true);
      outcome = submit(text);
    } finally {
      this.dispatching = false;
      this.dispatchDraft = undefined;
      restore();
    }
    if (!(outcome instanceof Promise)) return;
    this.pendingDispatches += 1;
    this.latestDraft = restore;
    const settle = () => {
      this.pendingDispatches -= 1;
      if (this.getText() === "") {
        this.latestDraft?.();
        this.engine?.resetToNormal();
        const model = adapter.readModel();
        adapter.writeModel({ lines: model.lines, cursor: clampNormalCursor(model) }, false);
      }
      if (this.pendingDispatches === 0) this.latestDraft = undefined;
      this.tui.requestRender();
    };
    outcome.then(settle, settle);
  }

  private captureDraft(adapter: EditorAdapter): () => void {
    const snapshot = adapter.capture();
    const depth = adapter.undoDepth();
    const redo = [...this.redoStack];
    return () => {
      adapter.restore(snapshot);
      adapter.truncateUndo(depth);
      this.redoStack = [...redo];
    };
  }

  /** Track the newest draft while an async dispatch is pending, so its settle restores that. */
  private refreshPendingDraft(): void {
    const { adapter } = this;
    if (!adapter || this.pendingDispatches === 0 || this.getText() === "") return;
    this.latestDraft = this.captureDraft(adapter);
  }
}
