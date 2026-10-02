import {
  DynamicBorder,
  ExtensionEditorComponent,
  getSelectListTheme,
  getSettingsListTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  SettingsList,
  type Component,
  type SelectItem,
  type SettingItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { formatAdvisorOption, type AdvisorRenderTheme } from "./advisor-rendering.js";
import {
  advisorOptionKeys,
  advisorSettingScopeSchema,
  parseAdvisorOptions,
  type AdvisorChange,
  type AdvisorOptions,
  type AdvisorSettingScope,
  type AdvisorSettingSource,
} from "./advisor-settings.js";

/** Authored options at each writable scope. */
export type AdvisorScopedOptions = { [Scope in AdvisorSettingScope]: AdvisorOptions };

/** Everything the menu displays, read fresh after each change. */
export interface AdvisorMenuView {
  /** Themed live status lines shown above the settings. */
  headline: readonly string[];
  paused: boolean;
  /** Writable scopes; project only when trusted. */
  scopes: readonly AdvisorSettingScope[];
  /** Effective options after scope precedence. */
  settings: AdvisorOptions;
  sources: Readonly<Partial<Record<keyof AdvisorOptions, AdvisorSettingSource>>>;
  authored: Readonly<Partial<AdvisorScopedOptions>>;
  /** `provider/id` names of selectable models. */
  models: readonly string[];
  /** Tool names known to the observed session. */
  tools: readonly string[];
}

/** The extension's settings authority behind the menu. */
export interface AdvisorMenuHost {
  view(): AdvisorMenuView;
  /** Validate, persist, and apply one change; rejects with a user-facing message. */
  apply(scope: AdvisorSettingScope, change: AdvisorChange): Promise<void>;
  /** Retry a Paused Advisor with its current settings. */
  resume(): Promise<void>;
}

/** Native UI collaborators supplied by `ctx.ui.custom`. */
export interface AdvisorMenuUi {
  tui: TUI;
  keybindings: KeybindingsManager;
  theme: AdvisorRenderTheme;
  externalEditorCommand?: string;
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const descriptions = {
  enabled: "Review this session's work",
  includeSubagents: "Also review Minimal Subagents Child Agents",
  prompt: "Review instructions; replaces the whole prompt",
  model: "Advisor model; inherit follows the observed agent",
  thinkingLevel: "Advisor thinking level; inherit follows the observed agent",
  allowedTools: "Tools the Advisor may call (Tool Grant)",
  catchUpThreshold: "Backlog that pauses the observed agent; a positive integer or off",
  reviewTimeoutMs: "Deadline for each Review, in seconds",
  maxToolCalls: "Investigative tool calls per Review",
  maxCorrectiveTurns: "Automatic Corrective Turns per request",
  maxFindingsPerReview: "Findings accepted from one Review (1–32)",
} satisfies Record<keyof AdvisorOptions, string>;
const inheritRow = "\u0000inherit";
const listActions = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.confirm",
  "tui.select.cancel",
] as const;

/** Convert one typed or selected menu value into a validated change. */
export function parseAdvisorMenuValue(
  key: keyof AdvisorOptions,
  text: string,
  scope: AdvisorSettingScope,
): AdvisorChange {
  const value = text.trim();
  if (value === "inherit") return { action: "inherit", key };
  if (value === "") throw new Error(`Enter a value for ${key}, or inherit`);
  const patch = (() => {
    switch (key) {
      case "enabled":
      case "includeSubagents":
        return { [key]: value === "on" ? true : value === "off" ? false : value };
      case "catchUpThreshold":
        return { catchUpThreshold: value === "off" ? value : Number(value) };
      case "reviewTimeoutMs":
        return { reviewTimeoutMs: Math.round(Number(value) * 1_000) };
      case "maxToolCalls":
      case "maxCorrectiveTurns":
      case "maxFindingsPerReview":
        return { [key]: Number(value) };
      default:
        return { [key]: value };
    }
  })();
  return { action: "set", key, patch: parseAdvisorOptions(patch, scope) };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Single-line value entry with inline validation. */
class ValueInput implements Component {
  private readonly input: Input;
  private error: string | undefined;

  constructor(
    private readonly title: string,
    private readonly hint: string,
    private readonly theme: AdvisorRenderTheme,
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

/** Fuzzy-searchable model list with an inherit choice. */
class ModelPicker implements Component {
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

/** Choose between editing the prompt in Pi's editor component and inheriting it. */
class PromptChooser implements Component {
  private readonly list: SelectList;
  private editor: ExtensionEditorComponent | undefined;

  constructor(
    ui: AdvisorMenuUi,
    prompt: string,
    submit: (text: string) => void,
    inherit: () => void,
    cancel: () => void,
  ) {
    this.list = new SelectList(
      [
        { value: "edit", label: "Edit…" },
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
        "Advisor Prompt",
        prompt,
        submit,
        cancel,
        undefined,
        ui.externalEditorCommand,
      );
      this.editor.focused = true;
    };
  }
  handleInput(data: string): void {
    (this.editor ?? this.list).handleInput(data);
  }
  render(width: number): string[] {
    return (this.editor ?? this.list).render(width);
  }
  invalidate(): void {
    (this.editor ?? this.list).invalidate();
  }
}

/** `/advisor` settings menu built from Pi's native settings list. */
export class AdvisorSettingsMenu implements Component {
  private scope: AdvisorSettingScope = "session";
  private view: AdvisorMenuView;
  private rows: SettingItem[] = [];
  private list: SettingsList;
  private error: string | undefined;
  private lastRow = "enabled";
  private readonly border: DynamicBorder;

  constructor(
    private readonly host: AdvisorMenuHost,
    private readonly ui: AdvisorMenuUi,
    private readonly done: () => void,
  ) {
    this.view = host.view();
    this.border = new DynamicBorder((text) => ui.theme.fg("border", text));
    this.list = this.createList();
  }

  /** Re-read the host after external state changes, such as a Review starting. */
  refresh(): void {
    const paused = this.view.paused;
    try {
      this.view = this.host.view();
    } catch (cause) {
      // Keep the last good view; an unreadable settings file is reported inline.
      this.error = errorText(cause);
      return;
    }
    if (!this.view.scopes.includes(this.scope)) this.scope = "session";
    if (paused !== this.view.paused) {
      this.list = this.createList();
      this.list.selectItem(this.view.paused ? "resume" : this.lastRow);
      return;
    }
    for (const row of this.rows) Object.assign(row, this.createRow(row.id));
  }

  private createList(): SettingsList {
    this.rows = [...(this.view.paused ? ["resume"] : []), "scope", ...advisorOptionKeys].map((id) =>
      this.createRow(id),
    );
    return new SettingsList(
      this.rows,
      this.rows.length,
      getSettingsListTheme(),
      (id, value) => this.change(id, value),
      this.done,
    );
  }

  private createRow(id: string): SettingItem {
    if (id === "resume")
      return {
        id,
        label: "Resume",
        currentValue: "retry",
        values: ["retry"],
        description: "Retry the paused Advisor with its current settings",
      };
    if (id === "scope")
      return {
        id,
        label: "Scope",
        currentValue: this.scope,
        values: [...this.view.scopes],
        description: "Where edits are written",
      };
    return this.optionRow(advisorOptionKeys.find((key) => key === id) ?? "enabled");
  }

  private optionRow(key: keyof AdvisorOptions): SettingItem {
    const source = this.view.sources[key] ?? "default";
    const settings = this.view.settings;
    const row = {
      id: key,
      label: source === "default" ? key : `${key} [${source}]`,
      description: descriptions[key],
    };
    switch (key) {
      case "enabled":
      case "includeSubagents":
        return {
          ...row,
          currentValue: settings[key] ? "on" : "off",
          values: ["on", "off", "inherit"],
        };
      case "thinkingLevel":
        return {
          ...row,
          currentValue: settings.thinkingLevel ?? "inherit",
          values: [...thinkingLevels, "inherit"],
        };
      case "model":
        return {
          ...row,
          currentValue: settings.model ?? "inherit",
          submenu: (_value, done) =>
            new ModelPicker(
              this.view.models,
              (value) => {
                this.apply(parseAdvisorMenuValue("model", value, this.scope));
                done();
              },
              () => done(),
            ),
        };
      case "allowedTools":
        return {
          ...row,
          currentValue: formatAdvisorOption(settings, key),
          submenu: (_value, done) => this.toolChecklist(() => done()),
        };
      case "prompt":
        return {
          ...row,
          currentValue: formatAdvisorOption(settings, key),
          submenu: (_value, done) =>
            new PromptChooser(
              this.ui,
              settings.prompt ?? "",
              (text) => {
                this.applyParsed(() => ({
                  action: "set",
                  key,
                  patch: parseAdvisorOptions({ prompt: text }, this.scope),
                }));
                done();
              },
              () => {
                this.apply({ action: "inherit", key });
                done();
              },
              () => done(),
            ),
        };
      default:
        return {
          ...row,
          currentValue: formatAdvisorOption(settings, key),
          submenu: (_value, done) =>
            new ValueInput(
              key,
              key === "catchUpThreshold"
                ? "a positive integer, off, or inherit"
                : key === "reviewTimeoutMs"
                  ? "seconds, or inherit"
                  : "a number, or inherit",
              this.ui.theme,
              (text) => {
                this.apply(parseAdvisorMenuValue(key, text, this.scope));
                done();
              },
              () => done(),
            ),
        };
    }
  }

  private toolChecklist(close: () => void): Component {
    const granted = this.view.settings.allowedTools ?? [];
    const names = [
      ...this.view.tools,
      ...granted.filter((name) => !this.view.tools.includes(name)),
    ];
    const rows: SettingItem[] = [
      ...names.map((name) => ({
        id: name,
        label: this.view.tools.includes(name) ? name : `${name} (unavailable)`,
        currentValue: granted.includes(name) ? "on" : "off",
        values: ["on", "off"],
      })),
      { id: inheritRow, label: "inherit", currentValue: "", values: ["inherit"] },
    ];
    return new SettingsList(
      rows,
      Math.min(rows.length, 12),
      getSettingsListTheme(),
      (id, value) => {
        if (id === inheritRow) {
          this.apply({ action: "inherit", key: "allowedTools" });
          close();
          return;
        }
        const current = this.host.view().settings.allowedTools ?? [];
        const allowedTools =
          value === "on"
            ? [...current.filter((name) => name !== id), id]
            : current.filter((name) => name !== id);
        this.apply({ action: "set", key: "allowedTools", patch: { allowedTools } });
      },
      close,
      { enableSearch: rows.length > 12 },
    );
  }

  private change(id: string, value: string): void {
    if (id === "resume") {
      this.run(() => this.host.resume());
      return;
    }
    if (id === "scope") {
      if (Value.Check(advisorSettingScopeSchema, value)) this.scope = value;
      this.refresh();
      return;
    }
    this.lastRow = id;
    const key = advisorOptionKeys.find((option) => option === id);
    if (!key) return;
    const row = this.rows.find((item) => item.id === id);
    // Inheriting is a no-op when this scope has no value; step to the next real value.
    const skip = value === "inherit" && this.view.authored[this.scope]?.[key] === undefined;
    const next = skip ? (row?.values?.[0] ?? value) : value;
    this.applyParsed(() => parseAdvisorMenuValue(key, next, this.scope));
  }

  /** Apply now (Pi settings semantics); the list refreshes when the host settles. */
  private apply(change: AdvisorChange): void {
    this.run(() => this.host.apply(this.scope, change));
  }

  /** Report a parse failure inline instead of applying. */
  private applyParsed(parse: () => AdvisorChange): void {
    let change: AdvisorChange;
    try {
      change = parse();
    } catch (cause) {
      this.error = errorText(cause);
      this.refresh();
      return;
    }
    this.apply(change);
  }

  private run(task: () => Promise<void>): void {
    this.error = undefined;
    void task()
      .catch((cause: unknown) => {
        this.error = errorText(cause);
      })
      .finally(() => {
        this.refresh();
        this.ui.tui.requestRender();
      });
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const { theme } = this.ui;
    return [
      ...this.border.render(width),
      ` ${theme.bold("Advisor settings")}`,
      ...this.view.headline.map((line) => ` ${line}`),
      "",
      ...this.list.render(width),
      ...(this.error ? [theme.fg("error", ` ✖ ${this.error}`)] : []),
      ...this.border.render(width),
    ];
  }

  invalidate(): void {
    this.list.invalidate();
  }
}
