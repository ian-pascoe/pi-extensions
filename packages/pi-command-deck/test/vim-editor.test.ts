import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { BACKSPACE, CTRL_R, ENTER, ESC, createVimEditor } from "./vim-pi-fixture.js";

const SHIFT_TAB = "\x1b[Z";
const UP = "\x1b[A";

function textWithCursor(editor: { getText(): string; getCursor(): { line: number; col: number } }) {
  const lines = editor.getText().split("\n");
  const { line, col } = editor.getCursor();
  const current = lines[line] ?? "";
  lines[line] = `${current.slice(0, col)}|${current.slice(col)}`;
  return lines.join("\n");
}

describe("VimEditor modes", () => {
  it("starts in insert and leaves it with Escape", () => {
    const { editor, type } = createVimEditor();
    expect(editor.getModeLabel()).toBe("INSERT");
    type("hello");
    expect(editor.getText()).toBe("hello");
    type(ESC);
    expect(editor.getModeLabel()).toBe("NORMAL");
    expect(textWithCursor(editor)).toBe("hell|o");
  });

  it("edits through the engine in normal mode", () => {
    const { editor, type } = createVimEditor();
    type("one two three", ESC, "0dw");
    expect(textWithCursor(editor)).toBe("|two three");
    type("2d");
    expect(editor.getModeLabel()).toBe("NORMAL 2d");
    type("w");
    expect(textWithCursor(editor)).toBe("|");
  });

  it("returns to insert on setText", () => {
    const { editor, type } = createVimEditor();
    type("abc", ESC, "d");
    editor.setText("replaced");
    expect(editor.getModeLabel()).toBe("INSERT");
    type("!");
    expect(editor.getText()).toBe("replaced!");
  });

  it("submits from normal mode and returns to insert", () => {
    const { editor, type } = createVimEditor();
    const submitted: string[] = [];
    editor.onSubmit = (text) => submitted.push(text);
    type("draft", ESC, ENTER);
    expect(submitted).toEqual(["draft"]);
    expect(editor.getText()).toBe("");
    expect(editor.getModeLabel()).toBe("INSERT");
  });

  it("submits from insert mode and starts a fresh insert session", () => {
    const { editor, type } = createVimEditor();
    editor.onSubmit = () => {};
    type("first", ENTER, "second", ESC, "u");
    expect(editor.getText()).toBe("");
  });

  it("submits from normal mode without Pi's backslash-Enter newline", () => {
    const { editor, type } = createVimEditor();
    const submitted: string[] = [];
    editor.onSubmit = (text) => submitted.push(text);
    type("ab\\c", ESC, "h", ENTER);
    expect(submitted).toEqual(["ab\\c"]);
    expect(editor.getModeLabel()).toBe("INSERT");
  });

  it("respects disableSubmit in normal mode", () => {
    const { editor, type } = createVimEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.disableSubmit = true;
    type("a\\", ESC, ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("a\\");
  });

  it("replaces r{char} with Enter instead of submitting", () => {
    const { editor, type } = createVimEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    type("ab", ESC, "0r", ENTER);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("\nb");
  });
});

describe("VimEditor undo", () => {
  it("keeps one undo step per session after Pi's undo drops below its start", () => {
    const { editor, type } = createVimEditor();
    type("abc", ESC, "x", "i", "\x1f", "\x1f", "\x1f", "\x1f", "q w e", ESC);
    expect(editor.getText()).toBe("q w e");
    type("u");
    expect(editor.getText()).toBe("");
  });

  it("undoes a whole insert session at once and redoes it", () => {
    const { editor, type } = createVimEditor();
    type("hello world", ESC, "u");
    expect(editor.getText()).toBe("");
    type(CTRL_R);
    expect(editor.getText()).toBe("hello world");
  });

  it("groups each Vim change into one Pi undo step", () => {
    const { editor, type } = createVimEditor();
    type("one two three", ESC, "0dwcwX y z", ESC);
    expect(editor.getText()).toBe("X y z three");
    type("u");
    expect(editor.getText()).toBe("two three");
    type("u");
    expect(editor.getText()).toBe("one two three");
    type("2", CTRL_R);
    expect(editor.getText()).toBe("X y z three");
  });

  it("maps Pi's undo key to Vim undo in normal mode", () => {
    const { editor, type } = createVimEditor();
    type("abc", ESC, "x", "\x1f");
    expect(editor.getText()).toBe("abc");
  });
});

describe("VimEditor host actions", () => {
  it("closes autocomplete and leaves insert mode with one Escape", async () => {
    const { editor, type } = createVimEditor();
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    editor.setAutocompleteProvider({
      getSuggestions: async () => ({ items: [{ value: "tree", label: "tree" }], prefix: "/" }),
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
    type("/");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.isShowingAutocomplete()).toBe(true);
    type(ESC);
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(editor.getModeLabel()).toBe("NORMAL");
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("interrupts with Escape only when nothing is pending", () => {
    const { editor, type } = createVimEditor();
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    type("abc", ESC, "d", ESC);
    expect(onEscape).not.toHaveBeenCalled();
    expect(editor.getModeLabel()).toBe("NORMAL");
    type(ESC);
    expect(onEscape).toHaveBeenCalledTimes(1);
    type("v", ESC);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(editor.getModeLabel()).toBe("NORMAL");
  });

  it("never interrupts on Escape when interrupt is bound elsewhere", () => {
    const { editor, type } = createVimEditor(["tree"], { "app.interrupt": "ctrl+\\" });
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    type("abc", ESC, ESC, ESC);
    expect(onEscape).not.toHaveBeenCalled();
    type("d", "\x1c");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(editor.getModeLabel()).toBe("NORMAL");
    type("x");
    expect(editor.getText()).toBe("ab");
  });

  it("stays in normal mode after a host action on an empty prompt", () => {
    const { editor, type } = createVimEditor();
    const cycle = vi.fn();
    editor.onAction("app.thinking.cycle", cycle);
    type(ESC, SHIFT_TAB);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(editor.getModeLabel()).toBe("NORMAL");
  });

  it("clamps the cursor after a mouse click past the line end", () => {
    const { editor, type } = createVimEditor();
    type("abc", ESC, "0");
    editor.render(40);
    editor.handleMouse({
      type: "click",
      button: "left",
      x: 30,
      y: 1,
      screenX: 30,
      screenY: 1,
      width: 40,
      height: 3,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(textWithCursor(editor)).toBe("ab|c");
  });

  it("clamps the cursor after a host insertion outside insert mode", () => {
    const { editor, type } = createVimEditor();
    type("ab", ESC);
    editor.insertTextAtCursor("[image]");
    expect(editor.getModeLabel()).toBe("NORMAL");
    expect(editor.getCursor().col).toBeLessThan(editor.getText().length);
  });

  it("does not interrupt when Escape only leaves insert mode", () => {
    const { editor, type } = createVimEditor();
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    type("abc", ESC);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("lets app actions cancel pending commands", () => {
    const { editor, type } = createVimEditor();
    const cycle = vi.fn();
    editor.onAction("app.thinking.cycle", cycle);
    type("abc", ESC, "r", SHIFT_TAB);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(editor.getModeLabel()).toBe("NORMAL");
    expect(editor.getText()).toBe("abc");
  });

  it("lets extension shortcuts run before Vim keys", () => {
    const { editor, type } = createVimEditor();
    editor.onExtensionShortcut = (data) => data === "x";
    type("abc", ESC, "d", "x");
    expect(editor.getText()).toBe("abc");
    expect(editor.getModeLabel()).toBe("NORMAL");
  });
});

describe("VimEditor history", () => {
  it("steps through prompt history with k and j on the boundary lines", () => {
    const { editor, type } = createVimEditor();
    editor.addToHistory("older");
    editor.addToHistory("newer");
    type("draft", ESC, "k");
    expect(editor.getText()).toBe("newer");
    type("k");
    expect(editor.getText()).toBe("older");
    type("2j");
    expect(editor.getText()).toBe("draft");
    expect(editor.getModeLabel()).toBe("NORMAL");
  });

  it("keeps Pi's arrow history in insert mode", () => {
    const { editor, type } = createVimEditor();
    editor.addToHistory("previous");
    type(UP);
    expect(editor.getText()).toBe("previous");
  });
});

describe("VimEditor paste", () => {
  it("discards bracketed paste outside insert mode, even across chunks", () => {
    const { editor, type } = createVimEditor();
    type("abc", ESC);
    editor.handleInput("\x1b[200~dd");
    editor.handleInput("xx\x1b[201~x");
    expect(editor.getText()).toBe("ab");
  });

  it("keeps only the first pasted line in the ex line", () => {
    const { editor, host, type } = createVimEditor();
    type("draft", ESC, ":");
    editor.handleInput("\x1b[200~q!\nrm -rf\x1b[201~");
    expect(editor.getModeLabel()).toBe("EX :q!_");
    expect(host.quit).not.toHaveBeenCalled();
  });

  it("abandons an unterminated paste after two Escapes", () => {
    const { editor, type } = createVimEditor();
    type("abc", ESC);
    editor.handleInput("\x1b[200~never ends");
    type("x");
    expect(editor.getText()).toBe("abc");
    type(ESC, ESC, "x");
    expect(editor.getText()).toBe("ab");
  });

  it("edits paste markers as one character in normal mode", () => {
    const { editor, type } = createVimEditor();
    type("a");
    editor.handleInput(`\x1b[200~${"line\n".repeat(12)}\x1b[201~`);
    type("b", ESC, "0gUUlx");
    expect(editor.getText()).toBe("AB");
    type("u");
    expect(editor.getExpandedText()).toBe(`A${"line\n".repeat(12)}B`);
  });

  it("copies yanks to the clipboard with paste markers expanded", () => {
    const { editor, host, type } = createVimEditor();
    type("a");
    editor.handleInput(`\x1b[200~${"line\n".repeat(12)}\x1b[201~`);
    type("b", ESC, "yy");
    expect(host.copy).toHaveBeenCalledExactlyOnceWith(`a${"line\n".repeat(12)}b\n`);
    type("dd");
    expect(host.copy).toHaveBeenCalledOnce();
  });

  it("pastes through Pi in insert mode", () => {
    const { editor } = createVimEditor();
    editor.handleInput("\x1b[200~pasted\x1b[201~");
    expect(editor.getText()).toBe("pasted");
  });
});

describe("VimEditor ex dispatch", () => {
  it("dispatches Pi commands through submit and restores the draft", () => {
    const { editor, type } = createVimEditor(["tree"]);
    const seen: string[] = [];
    editor.onSubmit = (text) => {
      seen.push(`${text}|${editor.getText()}`);
      editor.setText("");
    };
    type("my draft", ESC, "bdw", ":tree", ENTER);
    expect(seen).toEqual(["/tree|/tree"]);
    expect(textWithCursor(editor)).toBe("my| ");
    expect(editor.getModeLabel()).toBe("NORMAL");
    type("u");
    expect(editor.getText()).toBe("my draft");
    type("u");
    expect(editor.getText()).toBe("");
  });

  it("restores the draft as soon as Pi clears the prompt mid-dispatch", () => {
    const { editor, type } = createVimEditor(["reload"]);
    let handedOver = "";
    editor.onSubmit = () => {
      editor.setText("");
      handedOver = editor.getText();
    };
    type("keep me", ESC, ":reload", ENTER);
    expect(handedOver).toBe("keep me");
    expect(editor.getText()).toBe("keep me");
  });

  it("restores the draft after an async dispatch clears it", async () => {
    const { editor, type } = createVimEditor(["tree"]);
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    editor.onSubmit = async () => {
      await done;
      editor.setText("");
    };
    type("draft", ESC, ":tree", ENTER);
    expect(editor.getText()).toBe("draft");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.getText()).toBe("draft");
    expect(editor.getModeLabel()).toBe("NORMAL");
  });

  it("dispatches shell commands", () => {
    const { editor, type } = createVimEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    type(ESC, ":!!git status", ENTER);
    expect(onSubmit).toHaveBeenCalledWith("!!git status");
  });

  it("quits and reports unsupported commands", () => {
    const { host, type } = createVimEditor();
    type("draft", ESC, ":q", ENTER);
    expect(host.quit).not.toHaveBeenCalled();
    expect(host.notify).toHaveBeenLastCalledWith(
      "The prompt has unsent text; use :q! to quit anyway.",
      "warning",
    );
    type(":nope", ENTER);
    expect(host.notify).toHaveBeenLastCalledWith("Unsupported ex command: nope", "warning");
    type(":q!", ENTER);
    expect(host.quit).toHaveBeenCalledTimes(1);
  });

  it("leaves the ex line with backspace on an empty line", () => {
    const { editor, type } = createVimEditor();
    type(ESC, ":", BACKSPACE);
    expect(editor.getModeLabel()).toBe("NORMAL");
  });
});

describe("VimEditor render", () => {
  it("highlights the visual selection with reverse video", () => {
    const { editor, type } = createVimEditor();
    type("hello world", ESC, "0ve");
    const row = editor.render(40)[1] ?? "";
    expect(row).toContain(`\x1b[7mhell${CURSOR_MARKER}o\x1b[27m world`);
  });

  it("highlights across wrapped rows", () => {
    const { editor, type } = createVimEditor();
    type("aaaa bbbb cccc dddd", ESC, "V");
    const rows = editor.render(11).slice(1, -1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.startsWith("\x1b[7m")).toBe(true);
  });

  it("highlights only the visible rows of a scrolled prompt", () => {
    const { editor, type } = createVimEditor();
    editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    type(ESC);
    editor.render(40);
    type("kV");
    const rows = editor.render(40).slice(1, -1);
    expect(rows).toHaveLength(9);
    const painted = rows.map((row) => row.includes("\x1b[7m"));
    expect(painted).toEqual([false, false, false, false, false, false, false, true, false]);
    expect(rows[7]?.replace(CURSOR_MARKER, "")).toContain("line 18");
  });

  it("highlights incremental search matches on visible rows", () => {
    const { editor, type } = createVimEditor();
    type("foo bar foo", ESC, "/foo");
    expect(editor.getModeLabel()).toBe("SEARCH /foo_");
    const row = editor.render(40)[1] ?? "";
    expect(row.split("\x1b[7m")).toHaveLength(3);
  });

  it("switches the hardware cursor style by mode and strips the software cursor", () => {
    const { editor, terminal, tui, type } = createVimEditor();
    expect(tui.getShowHardwareCursor()).toBe(true);
    editor.render(40);
    expect(terminal.writes).toEqual(["\x1b[5 q"]);
    type("ab", ESC);
    const row = editor.render(40)[1] ?? "";
    expect(row).toContain(`a${CURSOR_MARKER}b`);
    expect(row).not.toContain("\x1b[7m");
    editor.render(40);
    expect(terminal.writes).toEqual(["\x1b[5 q", "\x1b[1 q"]);
    tui.setShowHardwareCursor(false);
    editor.render(40);
    expect(tui.getShowHardwareCursor()).toBe(true);
  });

  it("restores the terminal cursor once", () => {
    const { editor, terminal, tui } = createVimEditor();
    editor.restoreTerminalCursor({ reason: "quit" });
    editor.restoreTerminalCursor();
    expect(terminal.writes).toEqual(["\x1b[0 q", "\x1b[?25h"]);
    const other = createVimEditor();
    other.editor.restoreTerminalCursor({ reason: "reload" });
    expect(other.tui.getShowHardwareCursor()).toBe(false);
    expect(tui).toBeDefined();
  });
});
