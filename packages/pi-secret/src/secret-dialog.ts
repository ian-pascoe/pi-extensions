import { keyText } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { hintLine, type UiTheme } from "@ian-pascoe/pi-utils/ui";

/** Values shorter than this get a warning: they redact too much unrelated output. */
export const SHORT_SECRET_LENGTH = 8;

/** How the user answered a Secret Request. */
export type SecretDialogResult =
  | { readonly kind: "cancelled" }
  /** Entered values by Secret Name; a name without a value was skipped. */
  | { readonly kind: "submitted"; readonly values: ReadonlyMap<string, string> };

export interface SecretDialogOptions {
  readonly names: readonly string[];
  readonly reason: string | undefined;
  readonly lifetimeMinutes: number;
  readonly theme: Pick<UiTheme, "fg" | "bold">;
  readonly keybindings: Pick<KeybindingsManager, "matches">;
  readonly requestRender: () => void;
  readonly done: (result: SecretDialogResult) => void;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const BULLET = "•";

// oxlint-disable-next-line no-control-regex -- SAFETY: matching C0 and C1 control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The user-perceived characters of `text`, so one bullet stands for one character typed. */
function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

function lifetimeText(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * The Secret Request dialog: one masked field per Secret Name. It shows one bullet per character
 * and never renders a value, so neither the screen nor its scrollback can reveal one.
 */
export class SecretDialog implements Focusable {
  focused = false;
  private readonly values: string[];
  private active = 0;
  private paste: string | undefined;
  private finished = false;

  constructor(private readonly options: SecretDialogOptions) {
    this.values = options.names.map(() => "");
  }

  invalidate(): void {}

  private finish(result: SecretDialogResult): void {
    if (this.finished) return;
    this.finished = true;
    this.options.done(result);
  }

  /** End the request as cancelled, such as when the tool call is aborted. */
  cancel(): void {
    this.finish({ kind: "cancelled" });
  }

  private submit(): void {
    const values = new Map<string, string>();
    this.options.names.forEach((name, index) => {
      const value = this.values[index] ?? "";
      if (value !== "") values.set(name, value);
    });
    this.finish({ kind: "submitted", values });
  }

  private edit(change: (value: string) => string): void {
    this.values[this.active] = change(this.values[this.active] ?? "");
  }

  private move(step: number): void {
    const count = this.options.names.length;
    this.active = (this.active + step + count) % count;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    this.receive(data);
    this.options.requestRender();
  }

  private receive(data: string): void {
    if (this.paste === undefined && data.includes(PASTE_START)) {
      this.paste = "";
      data = data.slice(data.indexOf(PASTE_START) + PASTE_START.length);
    }
    if (this.paste !== undefined) {
      this.paste += data;
      const end = this.paste.indexOf(PASTE_END);
      if (end === -1) return;
      // A copied value often ends with a newline it does not contain.
      const pasted = this.paste.slice(0, end).replace(/[\r\n]+$/, "");
      const rest = this.paste.slice(end + PASTE_END.length);
      this.paste = undefined;
      this.edit((value) => value + pasted);
      if (rest !== "") this.receive(rest);
      return;
    }
    const { keybindings } = this.options;
    if (keybindings.matches(data, "tui.select.cancel")) return this.cancel();
    if (keybindings.matches(data, "tui.select.confirm") || data === "\n") return this.submit();
    if (matchesKey(data, Key.shift("tab")) || keybindings.matches(data, "tui.select.up"))
      return this.move(-1);
    if (matchesKey(data, Key.tab) || keybindings.matches(data, "tui.select.down"))
      return this.move(1);
    if (keybindings.matches(data, "tui.editor.deleteCharBackward"))
      return this.edit((value) => graphemes(value).slice(0, -1).join(""));
    if (
      keybindings.matches(data, "tui.editor.deleteToLineStart") ||
      keybindings.matches(data, "tui.editor.deleteWordBackward")
    )
      return this.edit(() => "");
    const printable = decodeKittyPrintable(data);
    if (printable !== undefined) return this.edit((value) => value + printable);
    if (!CONTROL_CHARACTERS.test(data)) this.edit((value) => value + data);
  }

  render(width: number): string[] {
    const { theme, names, reason, lifetimeMinutes } = this.options;
    const inner = Math.max(1, width - 2);
    const pad = (line: string) => truncateToWidth(` ${line}`, width);
    const lines = [theme.fg("border", "─".repeat(Math.max(1, width))), ""];
    lines.push(pad(theme.fg("accent", theme.bold("Secret request"))));
    if (reason !== undefined && reason.trim() !== "") {
      lines.push("");
      for (const line of wrapTextWithAnsi(theme.fg("text", reason.trim()), inner))
        lines.push(pad(line));
    }
    lines.push("");
    for (const line of wrapTextWithAnsi(
      theme.fg(
        "muted",
        `Values are kept for ${lifetimeText(lifetimeMinutes)} and never shown to the model. Leave a field empty to skip it.`,
      ),
      inner,
    ))
      lines.push(pad(line));
    lines.push("");
    const labelWidth = Math.max(...names.map((name) => visibleWidth(name)));
    names.forEach((name, index) => {
      const selected = index === this.active;
      const length = graphemes(this.values[index] ?? "").length;
      const marker = selected ? theme.fg("accent", "›") : " ";
      const label = selected
        ? theme.fg("accent", name.padEnd(labelWidth))
        : theme.fg("text", name.padEnd(labelWidth));
      const room = Math.max(1, inner - labelWidth - 4);
      const masked =
        length === 0
          ? theme.fg("dim", "(empty: skip)")
          : length <= room
            ? BULLET.repeat(length)
            : `${BULLET.repeat(Math.max(1, room - 8))}… (${length})`;
      const cursor = selected && this.focused ? CURSOR_MARKER : "";
      lines.push(pad(`${marker} ${label}  ${length === 0 ? cursor + masked : masked + cursor}`));
      if (length > 0 && length < SHORT_SECRET_LENGTH)
        lines.push(
          pad(
            theme.fg(
              "warning",
              `    shorter than ${SHORT_SECRET_LENGTH} characters: it may also hide unrelated output`,
            ),
          ),
        );
    });
    lines.push("");
    lines.push(
      pad(
        hintLine(theme, [
          { key: keyText("tui.select.confirm"), description: "submit" },
          { key: "tab", description: "next" },
          { key: "shift+tab", description: "previous" },
          { key: keyText("tui.select.cancel"), description: "cancel" },
        ]),
      ),
    );
    lines.push("", theme.fg("border", "─".repeat(Math.max(1, width))));
    return lines;
  }
}
