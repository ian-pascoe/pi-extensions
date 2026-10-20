import { keyText } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { hintLine, type UiTheme } from "@ian-pascoe/pi-utils/ui";

/** How the user answered an approval dialog. */
export type ApprovalDialogResult =
  | { readonly kind: "cancelled" }
  /** Indices of the approved rows; every other row was denied. */
  | { readonly kind: "submitted"; readonly approved: ReadonlySet<number> };

/** One thing to approve: a Secret Name and where it is read from or saved to. */
export interface ApprovalRow {
  readonly name: string;
  readonly detail: string;
}

export interface ApprovalDialogOptions {
  readonly title: string;
  readonly reason: string | undefined;
  /** What approving means, such as how long a grant lasts. */
  readonly explanation: string;
  readonly rows: readonly ApprovalRow[];
  readonly theme: Pick<UiTheme, "fg" | "bold">;
  readonly keybindings: Pick<KeybindingsManager, "matches">;
  readonly requestRender: () => void;
  readonly done: (result: ApprovalDialogResult) => void;
}

/**
 * Approve or deny each row of a Grant Request or a save. Every row starts approved: Enter
 * submits, Space toggles the selected row, and Escape cancels them all.
 */
export class ApprovalDialog implements Focusable {
  focused = false;
  private readonly approved: boolean[];
  private active = 0;
  private finished = false;

  constructor(private readonly options: ApprovalDialogOptions) {
    this.approved = options.rows.map(() => true);
  }

  invalidate(): void {}

  private finish(result: ApprovalDialogResult): void {
    if (this.finished) return;
    this.finished = true;
    this.options.done(result);
  }

  /** End the request as cancelled, such as when the tool call is aborted. */
  cancel(): void {
    this.finish({ kind: "cancelled" });
  }

  private move(step: number): void {
    const count = this.options.rows.length;
    this.active = (this.active + step + count) % count;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    const { keybindings } = this.options;
    if (keybindings.matches(data, "tui.select.cancel")) this.cancel();
    else if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      const approved = new Set<number>();
      this.approved.forEach((yes, index) => {
        if (yes) approved.add(index);
      });
      this.finish({ kind: "submitted", approved });
    } else if (data === " ") this.approved[this.active] = !this.approved[this.active];
    else if (matchesKey(data, Key.shift("tab")) || keybindings.matches(data, "tui.select.up"))
      this.move(-1);
    else if (matchesKey(data, Key.tab) || keybindings.matches(data, "tui.select.down"))
      this.move(1);
    this.options.requestRender();
  }

  render(width: number): string[] {
    const { theme, rows, reason, title, explanation } = this.options;
    const inner = Math.max(1, width - 2);
    const pad = (line: string) => truncateToWidth(` ${line}`, width);
    const lines = [theme.fg("border", "─".repeat(Math.max(1, width))), ""];
    lines.push(pad(theme.fg("accent", theme.bold(title))));
    if (reason !== undefined && reason.trim() !== "") {
      lines.push("");
      for (const line of wrapTextWithAnsi(theme.fg("text", reason.trim()), inner))
        lines.push(pad(line));
    }
    lines.push("");
    for (const line of wrapTextWithAnsi(theme.fg("muted", explanation), inner))
      lines.push(pad(line));
    lines.push("");
    rows.forEach((row, index) => {
      const selected = index === this.active;
      const marker = selected ? theme.fg("accent", "›") : " ";
      // A checkbox for the toggle state; Status Marks are reserved for outcomes (ADR-0006).
      const box = this.approved[index]
        ? theme.fg("accent", "[x] allow")
        : theme.fg("muted", "[ ] deny ");
      const label = theme.fg(selected ? "accent" : "text", row.name);
      lines.push(pad(`${marker} ${box} ${label}`));
      // The location gets its own lines, so a long one is wrapped rather than cut off.
      for (const line of wrapTextWithAnsi(theme.fg("muted", row.detail), Math.max(1, inner - 4)))
        lines.push(pad(`    ${line}`));
    });
    lines.push("");
    lines.push(
      pad(
        hintLine(theme, [
          { key: keyText("tui.select.confirm"), description: "submit" },
          { key: "space", description: "allow/deny" },
          { key: "tab", description: "next" },
          { key: keyText("tui.select.cancel"), description: "cancel" },
        ]),
      ),
    );
    lines.push("", theme.fg("border", "─".repeat(Math.max(1, width))));
    return lines;
  }
}
