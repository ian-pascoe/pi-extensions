import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type Component, type SettingItem } from "@earendil-works/pi-tui";
import {
  cycleDisplay,
  EditorChooser,
  effectiveWithSource,
  errorText,
  ModelPicker,
  nextCycleValue,
  scopeRow,
  SettingsMenu,
  ValueInput,
  type SettingsMenuUi,
} from "@ian-pascoe/pi-utils/settings-menu";
import { Value } from "typebox/value";
import { updatedToolEntries, type ToolEntryValue } from "./guardian-command.js";
import { formatGuardianOption, type GuardianRenderTheme } from "./guardian-rendering.js";
import {
  classifierOff,
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
  /** `provider/id` names of selectable classifier models. */
  classifiers: readonly string[];
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
export interface GuardianMenuUi extends SettingsMenuUi {
  theme: GuardianRenderTheme;
}

const thinkingCycle = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const cycleValues = {
  enabled: ["inherit", "on", "off"],
  thinkingLevel: thinkingCycle,
  escalationThinkingLevel: thinkingCycle,
  onDeny: ["inherit", "block", "ask"],
  verbose: ["inherit", "on", "off"],
} as const satisfies Record<string, readonly string[]>;
type CycleKey = keyof typeof cycleValues;

function isCycleKey(key: keyof GuardianOptions): key is CycleKey {
  return Object.hasOwn(cycleValues, key);
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
  classifierModel:
    "Classifier that makes the First Pass, escalating to a language model when unsure; off uses the Guardian model",
  escalationThreshold:
    "Rejection Probability, from 0 to 1, at which a classifier's First Pass escalates",
  escalationModel:
    "Model of the Escalation Pass that rechecks a would-be Rejection or a classifier's doubt; inherit uses the Guardian model",
  escalationThinkingLevel:
    "Escalation Pass thinking level; inherit is low, or the Guardian thinking level if higher",
  tools: "Tool Policies: allow, review, or deny each tool's calls",
  commands:
    "Command Rules: allow, review, or deny bash commands by literal prefix, such as git describe=allow",
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
  commands: "prefix=allow|review|deny|default, comma-separated, as JSON, none, or inherit",
  reviewTimeoutMs: "seconds, or inherit",
  escalationThreshold: "a probability from 0 to 1, or inherit",
  evidenceBudgetTokens: "a token count, auto, or inherit",
  maxConsecutiveRejections: "a number (0 disables), or inherit",
} as const;
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
      case "commands":
        return parseCommandRules(value, scope);
      case "reviewTimeoutMs":
        return { reviewTimeoutMs: Math.round(Number(value) * 1_000) };
      case "escalationThreshold":
        return { escalationThreshold: value === "" ? Number.NaN : Number(value) };
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

/**
 * Command Rules typed in the menu: `none`, a JSON object, or comma-separated `prefix=value`
 * entries, where `default` writes `null` to reset an inherited entry.
 */
function parseCommandRules(value: string, scope: GuardianSettingScope) {
  if (value === "none") return parseGuardianOptions({ commands: {} }, scope);
  if (value.startsWith("{")) return parseGuardianOptions({ commands: JSON.parse(value) }, scope);
  const rules = new Map<string, string | null>();
  for (const entry of value.split(",")) {
    if (!entry.trim()) continue;
    const separator = entry.lastIndexOf("=");
    const prefix = entry.slice(0, Math.max(0, separator)).trim();
    const policy = entry.slice(separator + 1).trim();
    if (separator < 0 || !prefix)
      throw new Error(
        `Write each Command Rule as prefix=allow|review|deny|default: ${entry.trim()}`,
      );
    rules.set(prefix, policy === "default" ? null : policy);
  }
  return parseGuardianOptions({ commands: Object.fromEntries(rules) }, scope);
}

/** `/guardian` settings menu built from Pi's native settings list. */
export class GuardianSettingsMenu extends SettingsMenu {
  private scope: GuardianSettingScope = "session";
  private view: GuardianMenuView;
  private rows: SettingItem[] = [];
  private toolRows: SettingItem[] = [];

  constructor(
    private readonly host: GuardianMenuHost,
    protected override readonly ui: GuardianMenuUi,
    done: () => void,
  ) {
    super("Guardian settings", ui, done);
    this.view = host.view();
    this.rows = ["scope", ...guardianOptionKeys].map((id) => this.createRow(id));
    this.setList(this.rows, (id, value) => this.change(id, value));
  }

  protected headline(): readonly string[] {
    return this.view.headline;
  }

  /** Re-read the host after external state changes, such as a review starting. */
  override refresh(): void {
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
    if (id === "scope") return scopeRow(this.scope, this.view.scopes);
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
      case "escalationModel":
        return {
          ...row,
          currentValue: settings[key] ?? "inherit",
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
      case "classifierModel":
        return {
          ...row,
          currentValue: settings[key] ?? "inherit",
          submenu: (_value, done) =>
            new ModelPicker(
              [classifierOff, ...this.view.classifiers],
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
            new EditorChooser(
              this.ui,
              "Guardian Security Policy",
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
          const next = nextCycleValue(toolCycle, current) ?? "inherit";
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
    const effective = cycleValue(key, this.view.settings) ?? "default";
    const source = this.view.sources[key] ?? "default";
    return cycleDisplay({
      own: cycleValue(key, this.view.authored[this.scope] ?? {}),
      inEffect: effectiveWithSource(effective, source),
      source,
      scope: this.scope,
    });
  }

  private change(id: string, value: string): void {
    if (id === "scope") {
      if (Value.Check(guardianSettingScopeSchema, value)) this.scope = value;
      this.refresh();
      return;
    }
    const key = guardianOptionKey(id);
    if (!isCycleKey(key)) return;
    // Cycle from this scope's own value; the list's proposal is based on the display text.
    const values = cycleValues[key];
    const own = cycleValue(key, this.view.authored[this.scope] ?? {}) ?? "inherit";
    const next = nextCycleValue(values, own) ?? "inherit";
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
}
