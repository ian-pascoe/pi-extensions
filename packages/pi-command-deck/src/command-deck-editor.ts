import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { renderDeckBorder, withEmptyPromptPlaceholder } from "./deck-chrome.js";
import { VimEditor, type VimEditorHost } from "./vim-editor.js";

const EMPTY_PROMPT = " Type your prompt...";

/** Live, already-colored labels for the Deck Header and Mode Rail. */
export interface CommandDeckLabels {
  theme(): Theme;
  headerLeft(): string;
  headerRight(): string;
  railRight(): string;
}

/** The Command Deck: a Vim editor framed by the Deck Header and Mode Rail. */
export class CommandDeckEditor extends VimEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    host: VimEditorHost,
    private readonly labels: CommandDeckLabels,
  ) {
    super(tui, editorTheme, keybindings, host);
    this.setPaddingX(0);
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    return renderDeckBorder(
      this.labels.headerLeft(),
      `${this.scrollIndicator("↑", hiddenLineCount)}${this.labels.headerRight()}`,
      width,
      (text) => this.borderColor(text),
    );
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    const theme = this.labels.theme();
    const modeLabel = this.getModeLabel();
    const mode = modeLabel === undefined ? "" : theme.fg("accent", ` ${modeLabel} `);
    return renderDeckBorder(
      mode,
      `${this.scrollIndicator("↓", hiddenLineCount)}${this.labels.railRight()}`,
      width,
      (text) => this.borderColor(text),
    );
  }

  /** Hidden-line count shown ahead of the shorter right label so truncation keeps it. */
  private scrollIndicator(arrow: string, hiddenLineCount: number): string {
    return hiddenLineCount > 0 ? this.labels.theme().fg("dim", ` ${arrow}${hiddenLineCount}`) : "";
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const firstContentRow = lines[1];
    if (this.getText() === "" && firstContentRow !== undefined) {
      lines[1] = withEmptyPromptPlaceholder(
        firstContentRow,
        this.labels.theme().fg("muted", EMPTY_PROMPT),
        width,
      );
    }
    return lines;
  }
}
