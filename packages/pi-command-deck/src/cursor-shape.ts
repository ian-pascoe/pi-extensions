import { CURSOR_MARKER, type TUI } from "@earendil-works/pi-tui";

/** DECSCUSR sequences: a bar for typing modes, a block for command modes, and the terminal default. */
const BAR_CURSOR = "\x1b[5 q";
const BLOCK_CURSOR = "\x1b[1 q";
const DEFAULT_CURSOR = "\x1b[0 q";
const SHOW_CURSOR = "\x1b[?25h";
/**
 * The editor's software cursor around the cursor cell. pi-tui before 1.2 draws it in reverse video;
 * pi-tui 1.2 wraps the cell in zero-width fake-cursor markers that the TUI resolves each frame.
 */
export const LEGACY_SOFTWARE_CURSOR = { start: "\x1b[7m", end: "\x1b[0m" } as const;
export const FAKE_CURSOR = { start: "\x1b_pi:fc\x07", end: "\x1b_pi:/fc\x07" } as const;
const SOFTWARE_CURSORS = [FAKE_CURSOR, LEGACY_SOFTWARE_CURSOR];

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
    const cursor = SOFTWARE_CURSORS.find((candidate) => line.startsWith(candidate.start, start));
    if (!cursor) return;
    const contentStart = start + cursor.start.length;
    const end = line.indexOf(cursor.end, contentStart);
    if (end === -1) return;
    lines[index] =
      line.slice(0, start) + line.slice(contentStart, end) + line.slice(end + cursor.end.length);
    return;
  }
}
