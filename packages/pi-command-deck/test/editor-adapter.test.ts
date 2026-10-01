import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { EditorAdapter } from "../src/editor-adapter.js";
import { VimEditor } from "../src/vim-editor.js";
import { createKeybindings, createTui, editorTheme } from "./vim-pi-fixture.js";

function createAdapter() {
  const { tui } = createTui();
  const editor = new CustomEditor(tui, editorTheme, createKeybindings());
  const adapter = EditorAdapter.probe(editor);
  if (!(adapter instanceof EditorAdapter)) throw new Error(`missing ${adapter.missing.join(", ")}`);
  return { editor, adapter };
}

describe("EditorAdapter against the installed Pi Editor", () => {
  it("reads and writes text and cursor", () => {
    const { editor, adapter } = createAdapter();
    editor.setText("one\ntwo");
    expect(adapter.readModel()).toEqual({ lines: ["one", "two"], cursor: { line: 1, col: 3 } });

    adapter.writeModel({ lines: ["one", "two"], cursor: { line: 0, col: 1 } }, false);
    expect(editor.getCursor()).toEqual({ line: 0, col: 1 });

    const changes: string[] = [];
    editor.onChange = (text) => changes.push(text);
    adapter.writeModel({ lines: ["uno", "dos", "tres"], cursor: { line: 2, col: 2 } }, true);
    expect(editor.getText()).toBe("uno\ndos\ntres");
    expect(editor.getCursor()).toEqual({ line: 2, col: 2 });
    expect(changes).toEqual(["uno\ndos\ntres"]);
  });

  it("keeps Pi's arrow navigation working after a cursor write", () => {
    const { editor, adapter } = createAdapter();
    editor.setText("abcdef\nxy");
    editor.render(40);
    adapter.writeModel({ lines: ["abcdef", "xy"], cursor: { line: 0, col: 4 } }, false);
    editor.handleInput("\x1b[B");
    expect(editor.getCursor()).toEqual({ line: 1, col: 2 });
  });

  it("records one Pi undo step per pushUndo and collapses steps by truncation", () => {
    const { editor, adapter } = createAdapter();
    const base = adapter.undoDepth();
    adapter.pushUndo();
    adapter.writeModel({ lines: ["a"], cursor: { line: 0, col: 0 } }, true);
    adapter.pushUndo();
    adapter.writeModel({ lines: ["ab"], cursor: { line: 0, col: 1 } }, true);
    expect(adapter.undoDepth()).toBe(base + 2);

    adapter.truncateUndo(base + 1);
    expect(adapter.undoDepth()).toBe(base + 1);
    const redo = adapter.undo();
    expect(editor.getText()).toBe("");
    expect(redo).toBeDefined();
    if (redo) adapter.redo(redo);
    expect(editor.getText()).toBe("ab");
    expect(adapter.undoDepth()).toBe(base + 1);
  });

  it("undoes typed text through Pi's own undo stack", () => {
    const { editor, adapter } = createAdapter();
    for (const char of "hi there") editor.handleInput(char);
    const depth = adapter.undoDepth();
    expect(depth).toBeGreaterThan(1);
    adapter.truncateUndo(1);
    adapter.undo();
    expect(editor.getText()).toBe("");
    expect(adapter.undo()).toBeUndefined();
  });

  it("captures and restores text, cursor, and paste markers", () => {
    const { editor, adapter } = createAdapter();
    editor.handleInput(`\x1b[200~${"line\n".repeat(12)}\x1b[201~`);
    const marker = editor.getText();
    expect(marker).toMatch(/^\[paste #1 \+13 lines\]$/u);
    const snapshot = adapter.capture();
    editor.setText("other");
    adapter.restore(snapshot);
    expect(editor.getText()).toBe(marker);
    expect(editor.getExpandedText()).toBe("line\n".repeat(12));
  });

  it("steps through prompt history", () => {
    const { editor, adapter } = createAdapter();
    editor.addToHistory("older");
    editor.addToHistory("newer");
    editor.setText("draft");
    adapter.navigateHistory(-1);
    expect(editor.getText()).toBe("newer");
    adapter.navigateHistory(-1);
    expect(editor.getText()).toBe("older");
    adapter.navigateHistory(1);
    adapter.navigateHistory(1);
    expect(editor.getText()).toBe("draft");
  });

  it("reports bracketed paste buffering", () => {
    const { editor, adapter } = createAdapter();
    editor.handleInput("\x1b[200~abc");
    expect(adapter.isInPaste()).toBe(true);
    editor.handleInput("\x1b[201~");
    expect(adapter.isInPaste()).toBe(false);
  });

  it("exposes wrapped and scrolled render geometry", () => {
    const { editor, adapter } = createAdapter();
    editor.setText(`${"word ".repeat(10)}\nshort`);
    const rendered = editor.render(20);
    const layout = adapter.layout(20);
    expect(layout.paddingX).toBe(0);
    expect(layout.scrollOffset).toBe(0);
    expect(layout.visibleCount).toBe(rendered.length - 2);
    expect(layout.rows.map((row) => row.line)).toEqual([0, 0, 0, 0, 1]);
    expect(layout.rows[1]).toEqual({ line: 0, startCol: 15, length: 15 });
  });

  it("reports missing internals", () => {
    const { tui } = createTui();
    const editor = new Editor(tui, editorTheme);
    editor["undoStack"] = undefined;
    editor["navigateHistory"] = undefined;
    expect(EditorAdapter.probe(editor)).toEqual({ missing: ["undoStack", "navigateHistory"] });
  });
});

describe("VimEditor fallback", () => {
  it("degrades to the plain editor and notifies once when internals are missing", () => {
    const original = Editor.prototype["navigateHistory"];
    Editor.prototype["navigateHistory"] = undefined;
    try {
      const { tui } = createTui();
      const notices: string[] = [];
      const editor = new VimEditor(tui, editorTheme, createKeybindings(), {
        notify: (message, level) => notices.push(`${level}: ${message}`),
        quit: () => {},
        isPiCommand: () => false,
        copy: () => {},
      });
      expect(editor.getModeLabel()).toBeUndefined();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(
        /^warning: .*navigateHistory.*Run \/skill:pi-command-deck to diagnose\.$/u,
      );
      editor.handleInput("a");
      editor.handleInput("\x1b");
      editor.handleInput("x");
      expect(editor.getText()).toBe("ax");
      expect(notices).toHaveLength(1);
    } finally {
      Editor.prototype["navigateHistory"] = original;
    }
  });
});
