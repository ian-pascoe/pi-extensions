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
import { formatAdvisorOption, type AdvisorRenderTheme } from "./advisor-rendering.js";
import {
  advisorOptionKey,
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
/** Options edited by cycling the selected scope's own value; `inherit` removes it. */
const cycleValues = {
  enabled: ["inherit", "on", "off"],
  includeSubagents: ["inherit", "on", "off"],
  thinkingLevel: ["inherit", ...thinkingLevels],
} as const satisfies Record<string, readonly string[]>;
type CycleKey = keyof typeof cycleValues;

function isCycleKey(key: keyof AdvisorOptions): key is CycleKey {
  return key === "enabled" || key === "includeSubagents" || key === "thinkingLevel";
}

/** A cycled option's value as shown and cycled; undefined when absent. */
function cycleValue(key: CycleKey, options: AdvisorOptions): string | undefined {
  if (key === "thinkingLevel") return options.thinkingLevel;
  const value = options[key];
  return value === undefined ? undefined : value ? "on" : "off";
}
const descriptions = {
  enabled: "Review this session's work",
  includeSubagents: "Also review Minimal Subagents Child Agents",
  prompt: "Advisor Prompt; replaces the whole prompt",
  model: "Advisor model; inherit follows the observed agent",
  thinkingLevel: "Advisor thinking level; inherit follows the observed agent",
  allowedTools: "Tools the Advisor may call (Tool Grant)",
  catchUpThreshold: "Review Backlog that starts a Catch-up Wait; a positive integer or off",
  reviewTimeoutMs: "Deadline for each Review, in seconds",
  maxToolCalls: "Investigative tool calls per Review",
  maxCorrectiveTurns: "Automatic Corrective Turns per request",
  maxFindingsPerReview: "Findings accepted from one Review (1–32)",
  seedBudgetTokens:
    "Token budget for the Context Seed; auto is a quarter of the Advisor model's context window",
} satisfies Record<keyof AdvisorOptions, string>;
const inheritRow = "\u0000inherit";
const inputHints = {
  catchUpThreshold: "a positive integer, off, or inherit",
  reviewTimeoutMs: "seconds, or inherit",
  maxToolCalls: "a number, or inherit",
  maxCorrectiveTurns: "a number, or inherit",
  maxFindingsPerReview: "a number from 1 to 32, or inherit",
  seedBudgetTokens: "a token count, auto, or inherit",
} as const;
const listActions = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.confirm",
  "tui.select.cancel",
] as const;

/** Convert one typed or selected menu value into a validated change. */
function parseAdvisorMenuValue(
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
      case "seedBudgetTokens":
        return { seedBudgetTokens: value === "auto" ? value : Number(value) };
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
  private error: string | undefined;

  /** `submit` throws a user-facing message for an invalid prompt; the editor stays open. */
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
        (text) => {
          try {
            submit(text);
          } catch (cause) {
            this.error = ui.theme.fg("error", `✖ ${errorText(cause)}`);
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
    return this.error ? [...lines, this.error] : lines;
  }
  invalidate(): void {
    (this.editor ?? this.list).invalidate();
  }
}

/** Menu row ids that are not Advisor options. */
const actionRows = { resume: "resume", scope: "scope" } as const;

/** `/advisor` settings menu built from Pi's native settings list. */
export class AdvisorSettingsMenu implements Component {
  private scope: AdvisorSettingScope = "session";
  private view: AdvisorMenuView;
  private rows: SettingItem[] = [];
  private list: SettingsList;
  private error: string | undefined;
  private lastRow: string = actionRows.scope;
  /** Edits run one at a time so each reads the result of the previous one. */
  private pending: Promise<void> = Promise.resolve();
  private submenuOpen = false;
  private rebuildPending = false;
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

  /** Resolves once every edit started so far has been applied or rejected. */
  settled(): Promise<void> {
    return this.pending;
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
    for (const row of this.rows) Object.assign(row, this.createRow(row.id));
    // Adding or removing Resume rebuilds the list; never discard an open submenu to do it.
    if (paused !== this.view.paused) {
      if (this.submenuOpen) this.rebuildPending = true;
      else this.rebuild();
    }
  }

  private rebuild(): void {
    this.rebuildPending = false;
    this.list = this.createList();
    this.list.selectItem(this.view.paused ? actionRows.resume : this.lastRow);
  }

  private createList(): SettingsList {
    const ids = [
      ...(this.view.paused ? [actionRows.resume] : []),
      actionRows.scope,
      ...advisorOptionKeys,
    ];
    this.rows = ids.map((id) => this.createRow(id));
    return new SettingsList(
      this.rows,
      this.rows.length,
      getSettingsListTheme(),
      (id, value) => this.change(id, value),
      this.done,
    );
  }

  private createRow(id: string): SettingItem {
    if (id === actionRows.resume)
      return {
        id,
        label: "Resume",
        currentValue: "retry",
        values: ["retry"],
        description: "Retry the Paused Advisor with its current settings",
      };
    if (id === actionRows.scope)
      return {
        id,
        label: "Scope",
        currentValue: this.scope,
        values: [...this.view.scopes],
        description: "Where edits are written",
      };
    return this.optionRow(advisorOptionKey(id));
  }

  /** Track an open submenu so a rebuild waits for it to close. */
  private submenu(
    id: string,
    open: (close: () => void) => Component,
  ): NonNullable<SettingItem["submenu"]> {
    return (_value, done) => {
      this.submenuOpen = true;
      this.lastRow = id;
      return open(() => {
        this.submenuOpen = false;
        done();
        if (this.rebuildPending) this.rebuild();
      });
    };
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
      case "thinkingLevel":
        // The row shows and cycles this scope's own value, so every state is reachable.
        return {
          ...row,
          label: key,
          currentValue: this.cycleDisplay(key),
          values: [...cycleValues[key]],
        };
      case "model":
        return {
          ...row,
          currentValue: settings.model ?? "inherit",
          submenu: this.submenu(
            key,
            (close) =>
              new ModelPicker(
                this.view.models,
                (value) => {
                  this.apply(parseAdvisorMenuValue(key, value, this.scope));
                  close();
                },
                close,
              ),
          ),
        };
      case "allowedTools":
        return {
          ...row,
          currentValue: formatAdvisorOption(settings, key),
          submenu: this.submenu(key, (close) => this.toolChecklist(close)),
        };
      case "prompt":
        return {
          ...row,
          currentValue: formatAdvisorOption(settings, key),
          submenu: this.submenu(
            key,
            (close) =>
              new PromptChooser(
                this.ui,
                settings.prompt ?? "",
                (text) => {
                  // Throws for an invalid prompt, keeping the editor open.
                  this.apply({
                    action: "set",
                    key,
                    patch: parseAdvisorOptions({ prompt: text }, this.scope),
                  });
                  close();
                },
                () => {
                  this.apply({ action: "inherit", key });
                  close();
                },
                close,
              ),
          ),
        };
      default:
        return {
          ...row,
          currentValue: formatAdvisorOption(settings, key),
          submenu: this.submenu(
            key,
            (close) =>
              new ValueInput(
                key,
                inputHints[key],
                this.ui.theme,
                (text) => {
                  // Throws for invalid input, keeping the field open with the message.
                  this.apply(parseAdvisorMenuValue(key, text, this.scope));
                  close();
                },
                close,
              ),
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
        const scope = this.scope;
        // Read the grant when this edit runs, after any earlier toggle has been applied.
        this.run(() => {
          const current = this.host.view().settings.allowedTools ?? [];
          const allowedTools =
            value === "on"
              ? [...current.filter((name) => name !== id), id]
              : current.filter((name) => name !== id);
          return this.host.apply(scope, {
            action: "set",
            key: "allowedTools",
            patch: parseAdvisorOptions({ allowedTools }, scope),
          });
        });
      },
      close,
      { enableSearch: rows.length > 12 },
    );
  }

  /** This scope's own value, or what it inherits; notes when another scope overrides it. */
  private cycleDisplay(key: CycleKey): string {
    const own = cycleValue(key, this.view.authored[this.scope] ?? {});
    const effective = cycleValue(key, this.view.settings);
    const source = this.view.sources[key] ?? "default";
    const inEffect = effective === undefined ? "observed agent" : `${effective} · ${source}`;
    if (own === undefined) return `inherit (${inEffect})`;
    return source === this.scope ? own : `${own} (overridden: ${inEffect})`;
  }

  private change(id: string, value: string): void {
    if (id === actionRows.resume) {
      this.run(() => this.host.resume());
      return;
    }
    if (id === actionRows.scope) {
      if (Value.Check(advisorSettingScopeSchema, value)) this.scope = value;
      this.lastRow = id;
      this.refresh();
      return;
    }
    this.lastRow = id;
    const key = advisorOptionKey(id);
    if (!isCycleKey(key)) return;
    // Cycle from this scope's own value. The list proposes values[0] because its display
    // text is not one of the values, so ignore its suggestion.
    const values = cycleValues[key];
    const own = cycleValue(key, this.view.authored[this.scope] ?? {}) ?? "inherit";
    const next =
      values[(values.findIndex((option) => option === own) + 1) % values.length] ?? "inherit";
    let change: AdvisorChange;
    try {
      change = parseAdvisorMenuValue(key, next, this.scope);
    } catch (cause) {
      this.error = errorText(cause);
      this.refresh();
      return;
    }
    this.apply(change);
    // The list already overwrote the row with its proposal; show the current value until
    // the write settles and refresh() shows the new one.
    const row = this.rows.find((item) => item.id === id);
    if (row) row.currentValue = this.cycleDisplay(key);
  }

  /** Apply at the current scope (Pi settings semantics); the list refreshes once it settles. */
  private apply(change: AdvisorChange): void {
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
