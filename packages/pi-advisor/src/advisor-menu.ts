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
export interface AdvisorMenuUi extends SettingsMenuUi {
  theme: AdvisorRenderTheme;
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
  thinkingLevel: "Advisor thinking level; inherit uses the default (high)",
  allowedTools: "Tools the Advisor may call (Tool Grant)",
  catchUpThreshold: "Review Backlog that starts a Catch-up Wait; a positive integer or off",
  reviewTimeoutMs: "Deadline for each Review, in seconds",
  maxToolCalls: "Investigative tool calls per Review",
  maxCorrectiveTurns: "Automatic Corrective Turns per request",
  maxFindingsPerReview: "Findings accepted from one Review (1–32)",
  maxNitsPerRequest: "Nits delivered per request; further Nits are dropped (0 delivers none)",
  seedBudgetTokens:
    "Token budget for the Context Seed; auto is a quarter of the Advisor model's context window, at most 50k",
  reviewEvery:
    "When Reviews run: every turn, every N turns, or once per request; a tool error reviews at once",
  maxSessionTokens:
    "Advisor Session size that triggers native compaction; auto is half the Advisor model's context window, at most 100k",
} satisfies Record<keyof AdvisorOptions, string>;
const inheritRow = "\u0000inherit";
const inputHints = {
  catchUpThreshold: "a positive integer, off, or inherit",
  reviewTimeoutMs: "seconds, or inherit",
  maxToolCalls: "a number, or inherit",
  maxCorrectiveTurns: "a number, or inherit",
  maxFindingsPerReview: "a number from 1 to 32, or inherit",
  maxNitsPerRequest: "a number, or inherit",
  seedBudgetTokens: "a token count, auto, or inherit",
  reviewEvery: "turn, request, a number of turns, or inherit",
  maxSessionTokens: "a token count, auto, or inherit",
} as const;

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
      case "maxSessionTokens":
        return { maxSessionTokens: value === "auto" ? value : Number(value) };
      case "reviewEvery":
        return {
          reviewEvery: value === "turn" || value === "request" ? value : Number(value),
        };
      case "maxToolCalls":
      case "maxCorrectiveTurns":
      case "maxFindingsPerReview":
      case "maxNitsPerRequest":
        return { [key]: Number(value) };
      default:
        return { [key]: value };
    }
  })();
  return { action: "set", key, patch: parseAdvisorOptions(patch, scope) };
}

/** Menu row ids that are not Advisor options. */
const actionRows = { resume: "resume", scope: "scope" } as const;

/** `/advisor` settings menu built from Pi's native settings list. */
export class AdvisorSettingsMenu extends SettingsMenu {
  private scope: AdvisorSettingScope = "session";
  private view: AdvisorMenuView;
  private rows: SettingItem[] = [];
  private lastRow: string = actionRows.scope;
  private submenuOpen = false;
  private rebuildPending = false;

  constructor(
    private readonly host: AdvisorMenuHost,
    protected override readonly ui: AdvisorMenuUi,
    done: () => void,
  ) {
    super("Advisor settings", ui, done);
    this.view = host.view();
    this.createList();
  }

  protected headline(): readonly string[] {
    return this.view.headline;
  }

  /** Re-read the host after external state changes, such as a Review starting. */
  override refresh(): void {
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
    this.createList().selectItem(this.view.paused ? actionRows.resume : this.lastRow);
  }

  private createList(): SettingsList {
    const ids = [
      ...(this.view.paused ? [actionRows.resume] : []),
      actionRows.scope,
      ...advisorOptionKeys,
    ];
    this.rows = ids.map((id) => this.createRow(id));
    return this.setList(this.rows, (id, value) => this.change(id, value));
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
    if (id === actionRows.scope) return scopeRow(this.scope, this.view.scopes);
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
              new EditorChooser(
                this.ui,
                "Advisor Prompt",
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
    const effective = cycleValue(key, this.view.settings);
    const source = this.view.sources[key] ?? "default";
    return cycleDisplay({
      own: cycleValue(key, this.view.authored[this.scope] ?? {}),
      inEffect: effective === undefined ? "observed agent" : effectiveWithSource(effective, source),
      source,
      scope: this.scope,
    });
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
    const next = nextCycleValue(values, own) ?? "inherit";
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
}
