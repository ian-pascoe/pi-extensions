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
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { updatedToolEntries, type ToolEntryValue } from "./guardian-command.js";
import { formatGuardianOption, type GuardianRenderTheme } from "./guardian-rendering.js";
import {
  guardianOptionKey,
  guardianOptionKeys,
  guardianSettingScopeSchema,
  parseGuardianOptions,
  type GuardianChange,
  type GuardianOptions,
  type GuardianSettingScope,
  type GuardianSettingSource,
} from "./guardian-settings.js";

/** Authored options at each writable scope. */
export type GuardianScopedOptions = { [Scope in GuardianSettingScope]: GuardianOptions };

/** Everything the menu displays, read fresh after each change. */
export interface GuardianMenuView {
  /** Themed live status lines shown above the settings. */
  headline: readonly string[];
  /** Writable scopes; project only when trusted. */
  scopes: readonly GuardianSettingScope[];
  /** Effective settings after scope precedence. */
  settings: GuardianOptions;
  sources: Readonly<Partial<Record<keyof GuardianOptions, GuardianSettingSource>>>;
  authored: Readonly<Partial<GuardianScopedOptions>>;
  /** `provider/id` names of selectable models. */
  models: readonly string[];
  /** Tool names known to the Guarded Agent's session. */
  tools: readonly string[];
}

/** The extension's settings authority behind the menu. */
export interface GuardianMenuHost {
  view(): GuardianMenuView;
  /** Validate, persist, and apply one change; rejects with a user-facing message. */
  apply(scope: GuardianSettingScope, change: GuardianChange): Promise<void>;
}

/** Native UI collaborators supplied by `ctx.ui.custom`. */
export interface GuardianMenuUi {
  tui: TUI;
  keybindings: KeybindingsManager;
  theme: GuardianRenderTheme;
  externalEditorCommand?: string;
}

const cycleValues = {
  enabled: ["inherit", "on", "off"],
  thinkingLevel: ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
  onDeny: ["inherit", "block", "ask"],
  verbose: ["inherit", "on", "off"],
} as const satisfies Record<string, readonly string[]>;
type CycleKey = keyof typeof cycleValues;

function isCycleKey(key: keyof GuardianOptions): key is CycleKey {
  return key === "enabled" || key === "thinkingLevel" || key === "onDeny" || key === "verbose";
}

function cycleValue(key: CycleKey, options: GuardianOptions): string | undefined {
  if (key === "enabled" || key === "verbose") {
    const value = options[key];
    return value === undefined ? undefined : value ? "on" : "off";
  }
  return options[key];
}

const descriptions = {
  enabled: "Review tool calls before they run",
  model: "Guardian model; inherit follows the session's current model",
  thinkingLevel: "Guardian thinking level",
  tools: "Tool Policies: allow, review, or deny each tool's calls",
  safeCommands: "Extra Safe Command prefixes, such as npm test; merged across scopes",
  policy: "Security Policy added to the built-in policy",
  reviewTimeoutMs: "Deadline for each Guardian Review, in seconds; a timeout is a Review Failure",
  evidenceBudgetTokens:
    "Token budget for evidence; auto is a quarter of the Guardian model's context window, at most 32k",
  onDeny: "On a Rejection: block, or ask the user to allow once",
  maxConsecutiveRejections: "Rejection Streak that ends the agent's turn; 0 never ends it",
  verbose:
    "Ask for a rationale on every review and show allowed reviews in the transcript; off asks only for high-risk ones",
} satisfies Record<keyof GuardianOptions, string>;
const inputHints = {
  safeCommands: "comma-separated command prefixes, none, or inherit",
  reviewTimeoutMs: "seconds, or inherit",
  evidenceBudgetTokens: "a token count, auto, or inherit",
  maxConsecutiveRejections: "a number (0 disables), or inherit",
} as const;
const listActions = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.confirm",
  "tui.select.cancel",
] as const;
const toolCycle: readonly ToolEntryValue[] = ["inherit", "allow", "review", "deny", "default"];

/** Convert one typed or selected menu value into a validated change. */
export function parseGuardianMenuValue(
  key: keyof GuardianOptions,
  text: string,
  scope: GuardianSettingScope,
): GuardianChange {
  const value = text.trim();
  if (value === "inherit") return { action: "inherit", key };
  const patch = (() => {
    switch (key) {
      case "enabled":
        return { enabled: value === "on" ? true : value === "off" ? false : value };
      case "verbose":
        return { verbose: value === "on" ? true : value === "off" ? false : value };
      case "safeCommands":
        return {
          safeCommands:
            value === "none"
              ? []
              : value
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean),
        };
      case "reviewTimeoutMs":
        return { reviewTimeoutMs: Math.round(Number(value) * 1_000) };
      case "evidenceBudgetTokens":
        return { evidenceBudgetTokens: value === "auto" ? value : Number(value) };
      case "maxConsecutiveRejections":
        return { maxConsecutiveRejections: value === "" ? Number.NaN : Number(value) };
      default:
        if (value === "") throw new Error(`Enter a value for ${key}, or inherit`);
        return { [key]: value };
    }
  })();
  return { action: "set", key, patch: parseGuardianOptions(patch, scope) };
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
    private readonly theme: GuardianRenderTheme,
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

/** Choose between editing the Security Policy in Pi's editor and inheriting it. */
class PolicyChooser implements Component {
  private readonly list: SelectList;
  private editor: ExtensionEditorComponent | undefined;

  constructor(
    ui: GuardianMenuUi,
    policy: string,
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
        "Guardian Security Policy",
        policy,
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

const scopeRow = "scope";

/** `/guardian` settings menu built from Pi's native settings list. */
export class GuardianSettingsMenu implements Component {
  private scope: GuardianSettingScope = "session";
  private view: GuardianMenuView;
  private rows: SettingItem[] = [];
  private readonly list: SettingsList;
  private error: string | undefined;
  /** Edits run one at a time so each reads the result of the previous one. */
  private pending: Promise<void> = Promise.resolve();
  private readonly border: DynamicBorder;
  private toolRows: SettingItem[] = [];

  constructor(
    private readonly host: GuardianMenuHost,
    private readonly ui: GuardianMenuUi,
    private readonly done: () => void,
  ) {
    this.view = host.view();
    this.border = new DynamicBorder((text) => ui.theme.fg("border", text));
    this.rows = [scopeRow, ...guardianOptionKeys].map((id) => this.createRow(id));
    this.list = new SettingsList(
      this.rows,
      this.rows.length,
      getSettingsListTheme(),
      (id, value) => this.change(id, value),
      this.done,
    );
  }

  /** Resolves once every edit started so far has been applied or rejected. */
  settled(): Promise<void> {
    return this.pending;
  }

  /** Re-read the host after external state changes, such as a review starting. */
  refresh(): void {
    try {
      this.view = this.host.view();
    } catch (cause) {
      this.error = errorText(cause);
      return;
    }
    if (!this.view.scopes.includes(this.scope)) this.scope = "session";
    for (const row of this.rows) Object.assign(row, this.createRow(row.id));
    for (const row of this.toolRows) row.currentValue = this.toolDisplay(row.id);
  }

  private createRow(id: string): SettingItem {
    if (id === scopeRow)
      return {
        id,
        label: "Scope",
        currentValue: this.scope,
        values: [...this.view.scopes],
        description: "Where edits are written",
      };
    return this.optionRow(guardianOptionKey(id));
  }

  private optionRow(key: keyof GuardianOptions): SettingItem {
    const source = this.view.sources[key] ?? "default";
    const settings = this.view.settings;
    const row = {
      id: key,
      label: source === "default" ? key : `${key} [${source}]`,
      description: descriptions[key],
    };
    if (isCycleKey(key))
      return {
        ...row,
        label: key,
        currentValue: this.cycleDisplay(key),
        values: [...cycleValues[key]],
      };
    switch (key) {
      case "model":
        return {
          ...row,
          currentValue: settings.model ?? "inherit",
          submenu: (_value, done) =>
            new ModelPicker(
              this.view.models,
              (value) => {
                this.apply(parseGuardianMenuValue(key, value, this.scope));
                done();
              },
              () => done(),
            ),
        };
      case "tools":
        return {
          ...row,
          currentValue: formatGuardianOption(settings, key),
          submenu: (_value, done) => this.toolList(() => done()),
        };
      case "policy":
        return {
          ...row,
          currentValue: formatGuardianOption(settings, key),
          submenu: (_value, done) =>
            new PolicyChooser(
              this.ui,
              settings.policy ?? "",
              (text) => {
                this.apply({
                  action: "set",
                  key,
                  patch: parseGuardianOptions({ policy: text }, this.scope),
                });
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
          currentValue: formatGuardianOption(settings, key),
          submenu: (_value, done) =>
            new ValueInput(
              key,
              inputHints[key],
              this.ui.theme,
              (text) => {
                // Throws for invalid input, keeping the field open with the message.
                this.apply(parseGuardianMenuValue(key, text, this.scope));
                done();
              },
              () => done(),
            ),
        };
    }
  }

  /** This scope's own entry for a tool, then the effective Tool Policy. */
  private toolDisplay(name: string): string {
    const own = this.view.authored[this.scope]?.tools;
    const value = own && Object.hasOwn(own, name) ? (own[name] ?? "default") : "inherit";
    const effective = this.view.settings.tools?.[name];
    return `${value} (${effective ?? "built-in default"})`;
  }

  /** Each known tool's entry at the selected scope, cycled inherit → allow → review → deny → default. */
  private toolList(close: () => void): Component {
    const configured = Object.keys(this.view.settings.tools ?? {});
    const names = [...new Set([...this.view.tools, ...configured])].toSorted();
    this.toolRows = names.map((name) => ({
      id: name,
      label: this.view.tools.includes(name) ? name : `${name} (unavailable)`,
      currentValue: this.toolDisplay(name),
      values: [...toolCycle],
    }));
    return new SettingsList(
      this.toolRows,
      Math.min(this.toolRows.length, 12),
      getSettingsListTheme(),
      (name) => {
        const scope = this.scope;
        // Read the entry when this edit runs, after any earlier toggle has been applied.
        this.run(() => {
          const own = this.host.view().authored[scope]?.tools;
          const current = own && Object.hasOwn(own, name) ? (own[name] ?? "default") : "inherit";
          const next =
            toolCycle[(toolCycle.findIndex((value) => value === current) + 1) % toolCycle.length] ??
            "inherit";
          const tools = updatedToolEntries(own, name, next);
          return this.host.apply(
            scope,
            tools
              ? { action: "set", key: "tools", patch: parseGuardianOptions({ tools }, scope) }
              : { action: "inherit", key: "tools" },
          );
        });
      },
      () => {
        this.toolRows = [];
        close();
      },
      { enableSearch: this.toolRows.length > 12 },
    );
  }

  /** This scope's own value, or what it inherits; notes when another scope overrides it. */
  private cycleDisplay(key: CycleKey): string {
    const own = cycleValue(key, this.view.authored[this.scope] ?? {});
    const effective = cycleValue(key, this.view.settings) ?? "default";
    const source = this.view.sources[key] ?? "default";
    if (own === undefined) return `inherit (${effective} · ${source})`;
    return source === this.scope ? own : `${own} (overridden: ${effective} · ${source})`;
  }

  private change(id: string, value: string): void {
    if (id === scopeRow) {
      if (Value.Check(guardianSettingScopeSchema, value)) this.scope = value;
      this.refresh();
      return;
    }
    const key = guardianOptionKey(id);
    if (!isCycleKey(key)) return;
    // Cycle from this scope's own value; the list's proposal is based on the display text.
    const values = cycleValues[key];
    const own = cycleValue(key, this.view.authored[this.scope] ?? {}) ?? "inherit";
    const next =
      values[(values.findIndex((option) => option === own) + 1) % values.length] ?? "inherit";
    try {
      this.apply(parseGuardianMenuValue(key, next, this.scope));
    } catch (cause) {
      this.error = errorText(cause);
    }
    const row = this.rows.find((item) => item.id === id);
    if (row) row.currentValue = this.cycleDisplay(key);
  }

  /** Apply at the current scope; the list refreshes once it settles. */
  private apply(change: GuardianChange): void {
    const scope = this.scope;
    this.run(() => this.host.apply(scope, change));
  }

  private run(task: () => Promise<void>): void {
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
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse(event);
  }

  render(width: number): string[] {
    const { theme } = this.ui;
    return [
      ...this.border.render(width),
      ` ${theme.bold("Guardian settings")}`,
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
