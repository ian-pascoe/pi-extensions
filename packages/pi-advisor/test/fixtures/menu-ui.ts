import { stripVTControlCharacters } from "node:util";
import { vi } from "vitest";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";

export const keys = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
};

/** A terminal that never touches the process TTY. */
class QuietTerminal implements Terminal {
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  get columns(): number {
    return 100;
  }
  get rows(): number {
    return 40;
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

/** A real pi-tui screen and Pi's default TUI bindings, without rendering to a terminal. */
export function createMenuTui() {
  const tui = new TuiMainScreen(new QuietTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Pi exports its KeybindingsManager as a type only; the menu's editor calls only matches(), which this pi-tui manager implements.
  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
  return { tui, keybindings };
}

/** Read and drive whichever menu component is currently shown. */
export function menuDriver(current: () => Component | undefined) {
  const screen = () =>
    (current()?.render(100) ?? [])
      .map((line) => stripVTControlCharacters(line).trimEnd())
      .join("\n");
  const press = (...inputs: string[]) => {
    for (const input of inputs) current()?.handleInput?.(input);
  };
  const type = (text: string) => press(...text.split(""));
  /** Move the cursor to the row whose label starts with `label`. */
  const goTo = (label: string) => {
    for (let step = 0; step < 20; step++) {
      const selected = screen()
        .split("\n")
        .find((line) => line.trimStart().startsWith("→"));
      if (selected?.replace("→", "").trimStart().startsWith(label)) return;
      press(keys.down);
    }
    throw new Error(`No menu row ${label}`);
  };
  return { screen, press, type, goTo };
}
