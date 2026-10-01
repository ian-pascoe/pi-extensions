import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";

/** DECSCUSR sequences: a bar for typing modes, a block for command modes, and the terminal default. */
const BAR_CURSOR = "\x1b[5 q";
const BLOCK_CURSOR = "\x1b[1 q";
const DEFAULT_CURSOR = "\x1b[0 q";
const SHOW_CURSOR = "\x1b[?25h";
const SOFTWARE_CURSOR_START = "\x1b[7m";
const SOFTWARE_CURSOR_END = "\x1b[0m";

/** The cursor style a Vim Mode asks for. */
export type CursorStyle = "bar" | "block";

/**
 * Drives the terminal's hardware cursor for Vim Modes: shows it, switches its style with
 * DECSCUSR on change only, and restores the terminal on shutdown.
 */
export class TerminalCursor {
  private written: CursorStyle | undefined;
  private readonly previousShowHardwareCursor: boolean;
  private restored = false;

  constructor(private readonly tui: TUI) {
    this.previousShowHardwareCursor = tui.getShowHardwareCursor();
    tui.setShowHardwareCursor(true);
  }

  /** Apply a style before a frame; re-enables the hardware cursor if Pi turned it off. */
  sync(style: CursorStyle): void {
    if (this.restored) return;
    if (!this.tui.getShowHardwareCursor()) this.tui.setShowHardwareCursor(true);
    if (this.written === style) return;
    this.written = style;
    this.tui.terminal.write(style === "bar" ? BAR_CURSOR : BLOCK_CURSOR);
  }

  /** True while the hardware cursor marks the prompt position. */
  get active(): boolean {
    return !this.restored && this.tui.getShowHardwareCursor();
  }

  /** Reset the terminal cursor; pass the session_shutdown event. Idempotent. */
  restore(event?: { reason?: string }): void {
    if (this.restored) return;
    this.restored = true;
    this.tui.terminal.write(DEFAULT_CURSOR);
    if (event?.reason === "quit") this.tui.terminal.write(SHOW_CURSOR);
    else this.tui.setShowHardwareCursor(this.previousShowHardwareCursor);
  }
}

/** Remove the editor's reverse-video software cursor that follows the hardware cursor marker. */
export function stripSoftwareCursor(lines: string[]): void {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const marker = line.indexOf(CURSOR_MARKER);
    if (marker === -1) continue;
    const start = marker + CURSOR_MARKER.length;
    if (!line.startsWith(SOFTWARE_CURSOR_START, start)) return;
    const contentStart = start + SOFTWARE_CURSOR_START.length;
    const end = line.indexOf(SOFTWARE_CURSOR_END, contentStart);
    if (end === -1) return;
    lines[index] =
      line.slice(0, start) +
      line.slice(contentStart, end) +
      line.slice(end + SOFTWARE_CURSOR_END.length);
    return;
  }
}
