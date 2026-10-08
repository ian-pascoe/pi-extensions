import {
  DynamicBorder,
  ExtensionEditorComponent,
  getSelectListTheme,
  getSettingsListTheme,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  SettingsList,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
  type SettingItem,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { SEPARATOR, statusMark } from "./ui.js";

/** The theme methods the settings widgets draw with; Pi's `Theme` satisfies it. */
export type SettingsMenuTheme = Pick<Theme, "fg" | "bold">;

/** A thrown value's message, or its string form. */
export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The value after `current` in `values`, wrapping around; `undefined` when `values` is empty.
 * A `current` that is not in `values` yields the first value.
 */
export function nextCycleValue<Value extends string>(
  values: readonly Value[],
  current: string,
): Value | undefined {
  return values[(values.findIndex((value) => value === current) + 1) % values.length];
}

/**
 * Single-line value entry with inline validation. `submit` may throw a user-facing message,
 * which is shown in place of the hint until the next keystroke.
 */
export class ValueInput implements Component {
  private readonly input: Input;
  private error: string | undefined;

  constructor(
    private readonly title: string,
    private readonly hint: string,
    private readonly theme: SettingsMenuTheme,
    submit: (text: string) => void,
    cancel: () => void,
  ) {
    this.input = new Input({ placeholder: hint });
    this.input.focused = true;
    this.input.onSubmit = (text) => {
      try {
        submit(text);
      } catch (cause) {
        this.error = errorText(cause);
      }
    };
    this.input.onEscape = cancel;
  }
  handleInput(data: string): void {
    this.error = undefined;
    this.input.handleInput(data);
  }
  render(width: number): string[] {
    return [
      this.theme.bold(this.title),
      ...this.input.render(width),
      this.error
        ? `${statusMark(this.theme, "failed")} ${this.theme.fg("error", this.error)}`
        : this.theme.fg("dim", this.hint),
    ];
  }
  invalidate(): void {
    this.input.invalidate();
  }
}

const listActions = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.confirm",
  "tui.select.cancel",
] as const;

/** Fuzzy-searchable model list whose first choice is `inherit`. */
export class ModelPicker implements Component {
  private readonly input = new Input({ placeholder: "type to search" });
  private list: SelectList;

  constructor(
    private readonly models: readonly string[],
    private readonly choose: (value: string) => void,
    private readonly cancel: () => void,
  ) {
    this.input.focused = true;
    this.list = this.createList("");
  }
  private createList(query: string): SelectList {
    const items: SelectItem[] = ["inherit", ...this.models].map((value) => ({
      value,
      label: value,
    }));
    const list = new SelectList(
      query ? fuzzyFilter(items, query, (item) => item.value) : items,
      10,
      getSelectListTheme(),
    );
    list.onSelect = (item) => this.choose(item.value);
    list.onCancel = this.cancel;
    return list;
  }
  handleInput(data: string): void {
    const bindings = getKeybindings();
    if (listActions.some((action) => bindings.matches(data, action))) {
      this.list.handleInput(data);
      return;
    }
    this.input.handleInput(data);
    this.list = this.createList(this.input.getValue());
  }
  render(width: number): string[] {
    return [...this.input.render(width), ...this.list.render(width)];
  }
  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }
}

/** Native UI collaborators a settings menu needs, as supplied by `ctx.ui.custom`. */
export interface SettingsMenuUi {
  tui: TUI;
  keybindings: KeybindingsManager;
  theme: SettingsMenuTheme;
  externalEditorCommand?: string;
}

/** The `Scope` row every settings menu starts with; its values are the writable scopes. */
export function scopeRow(scope: string, scopes: readonly string[]): SettingItem {
  return {
    id: "scope",
    label: "Scope",
    currentValue: scope,
    values: [...scopes],
    description: "Where edits are written",
  };
}

/** `effective · source`, the usual `inEffect` text for `cycleDisplay`. */
export function effectiveWithSource(effective: string, source: string): string {
  return `${effective}${SEPARATOR}${source}`;
}

/**
 * A cycled option's display: the selected scope's own value, or what it inherits, noting when a
 * higher-precedence scope overrides it. `inEffect` describes the effective value and its source.
 */
export function cycleDisplay(input: {
  own: string | undefined;
  inEffect: string;
  source: string;
  scope: string;
}): string {
  if (input.own === undefined) return `inherit (${input.inEffect})`;
  return input.source === input.scope ? input.own : `${input.own} (overridden: ${input.inEffect})`;
}

/** Choose between editing a long text in Pi's editor component and inheriting it. */
export class EditorChooser implements Component {
  private readonly list: SelectList;
  private editor: ExtensionEditorComponent | undefined;
  private error: string | undefined;

  /** `submit` throws a user-facing message for invalid text; the editor stays open. */
  constructor(
    private readonly ui: SettingsMenuUi,
    editorTitle: string,
    text: string,
    submit: (text: string) => void,
    inherit: () => void,
    cancel: () => void,
  ) {
    this.list = new SelectList(
      [
        { value: "edit", label: "Edit..." },
        { value: "inherit", label: "inherit" },
      ],
      2,
      getSelectListTheme(),
    );
    this.list.onCancel = cancel;
    this.list.onSelect = (item) => {
      if (item.value === "inherit") {
        inherit();
        return;
      }
      this.editor = new ExtensionEditorComponent(
        ui.tui,
        ui.keybindings,
        editorTitle,
        text,
        (edited) => {
          try {
            submit(edited);
          } catch (cause) {
            this.error = errorText(cause);
          }
        },
        cancel,
        undefined,
        ui.externalEditorCommand,
      );
      this.editor.focused = true;
    };
  }
  handleInput(data: string): void {
    this.error = undefined;
    (this.editor ?? this.list).handleInput(data);
  }
  render(width: number): string[] {
    const lines = (this.editor ?? this.list).render(width);
    if (!this.error) return lines;
    const mark = statusMark(this.ui.theme, "failed");
    return [
      ...lines,
      ...wrapTextWithAnsi(`${mark} ${this.ui.theme.fg("error", this.error)}`, width),
    ];
  }
  invalidate(): void {
    (this.editor ?? this.list).invalidate();
  }
}

/**
 * The shared `/advisor` and `/guardian` settings menu frame: Pi's settings-screen look (a border,
 * an accent title, live status lines, then a native settings list) plus a serialized edit queue.
 * A subclass supplies its rows, behavior, and `refresh`.
 */
export abstract class SettingsMenu implements Component {
  /** The last failed edit, shown under the list until the next edit starts. */
  protected error: string | undefined;
  /** Edits run one at a time so each reads the result of the previous one. */
  private pending: Promise<void> = Promise.resolve();
  private list: SettingsList | undefined;
  private readonly border: DynamicBorder;

  constructor(
    private readonly title: string,
    protected readonly ui: SettingsMenuUi,
    private readonly done: () => void,
  ) {
    this.border = new DynamicBorder((text) => ui.theme.fg("border", text));
  }

  /** Themed live status lines shown above the settings. */
  protected abstract headline(): readonly string[];

  /** Re-read the host after external state changes, such as a Review starting. */
  abstract refresh(): void;

  /** Show a native settings list of `rows`, replacing any earlier one. */
  protected setList(
    rows: SettingItem[],
    onChange: (id: string, value: string) => void,
  ): SettingsList {
    const list = new SettingsList(rows, rows.length, getSettingsListTheme(), onChange, this.done);
    this.list = list;
    return list;
  }

  /** Resolves once every edit started so far has been applied or rejected. */
  settled(): Promise<void> {
    return this.pending;
  }

  /** Queue an edit; a failure shows inline, and the menu refreshes once it settles. */
  protected run(task: () => Promise<void>): void {
    this.error = undefined;
    this.pending = this.pending
      .then(task)
      .catch((cause: unknown) => {
        this.error = errorText(cause);
      })
      .finally(() => {
        this.refresh();
        this.ui.tui.requestRender();
      });
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list?.handleMouse(event);
  }

  render(width: number): string[] {
    const { theme } = this.ui;
    const indented = (text: string) => wrapTextWithAnsi(` ${text}`, width);
    return [
      ...this.border.render(width),
      ...indented(theme.fg("accent", theme.bold(this.title))),
      ...this.headline().flatMap(indented),
      "",
      ...(this.list?.render(width) ?? []),
      ...(this.error
        ? indented(`${statusMark(theme, "failed")} ${theme.fg("error", this.error)}`)
        : []),
      ...this.border.render(width),
    ];
  }

  invalidate(): void {
    this.list?.invalidate();
  }
}
