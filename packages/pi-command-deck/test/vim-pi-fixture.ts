import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  type EditorTheme,
  type KeybindingsConfig,
  type Terminal,
} from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { VimEditor, type VimEditorHost } from "../src/vim-editor.js";

/** A terminal that records writes and never touches the process TTY. */
export class RecordingTerminal implements Terminal {
  readonly writes: string[] = [];
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  get columns(): number {
    return 40;
  }
  get rows(): number {
    return 30;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

export const editorTheme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

/** Pi's default bindings for the app actions VimEditor routes around. */
const APP_KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  "app.interrupt": { defaultKeys: "escape" },
  "app.clear": { defaultKeys: "ctrl+c" },
  "app.exit": { defaultKeys: "ctrl+d" },
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v" },
  "app.thinking.cycle": { defaultKeys: "shift+tab" },
} as const;

export function createKeybindings(userBindings: KeybindingsConfig = {}): KeybindingsManager {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Pi exports its KeybindingsManager as a type only; VimEditor and CustomEditor call only matches(), which this pi-tui manager implements over Pi's default app bindings.
  return new TuiKeybindingsManager(APP_KEYBINDINGS, userBindings) as unknown as KeybindingsManager;
}

export function createTui() {
  const terminal = new RecordingTerminal();
  const tui = new TuiMainScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  return { terminal, tui };
}

/** A real VimEditor over Pi's installed Editor, with a recording host. */
export function createVimEditor(
  commands: readonly string[] = ["tree"],
  userBindings: KeybindingsConfig = {},
) {
  const { terminal, tui } = createTui();
  const host = {
    notify: vi.fn<VimEditorHost["notify"]>(),
    quit: vi.fn<VimEditorHost["quit"]>(),
    isPiCommand: (name: string) => commands.includes(name),
    copy: vi.fn<VimEditorHost["copy"]>(),
  };
  const editor = new VimEditor(tui, editorTheme, createKeybindings(userBindings), host);
  editor.focused = true;
  const type = (...inputs: string[]) => {
    for (const input of inputs) {
      for (const char of input.startsWith("\x1b") ? [input] : input.split(""))
        editor.handleInput(char);
    }
  };
  return { editor, host, terminal, tui, type };
}

export const ESC = "\x1b";
export const ENTER = "\r";
export const BACKSPACE = "\x7f";
export const CTRL_R = "\x12";
