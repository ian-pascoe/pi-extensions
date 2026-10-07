import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";

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
      this.error ? this.theme.fg("error", `✖ ${this.error}`) : this.theme.fg("dim", this.hint),
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
