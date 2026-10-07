import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  guardianOptionKey,
  guardianOptionKeys,
  parseGuardianOptions,
  type GuardianOptions,
  type GuardianSettingScope,
  type ToolPolicy,
} from "./guardian-settings.js";

const usage =
  "Usage: /guardian [on|off|status|policy|inherit [key]|set <key> <JSON>|tool <name> <allow|review|deny|default|inherit>] [--global|--project]; /guardian alone opens settings";

/** A tool entry change: a Tool Policy, `default` (null: built-in default), or `inherit`. */
export type ToolEntryValue = ToolPolicy | "default" | "inherit";
const toolEntryValues: readonly ToolEntryValue[] = [
  "allow",
  "review",
  "deny",
  "default",
  "inherit",
];

function isToolEntryValue(value: string): value is ToolEntryValue {
  return toolEntryValues.some((candidate) => candidate === value);
}

/** One parsed `/guardian` command. */
export type GuardianCommand =
  | { action: "menu" }
  | { action: "status" }
  | { action: "policy"; scope: GuardianSettingScope }
  | {
      action: "set";
      scope: GuardianSettingScope;
      key: keyof GuardianOptions;
      patch: GuardianOptions;
    }
  | { action: "inherit"; scope: GuardianSettingScope; key: keyof GuardianOptions }
  | { action: "tool"; scope: GuardianSettingScope; name: string; value: ToolEntryValue };

/** Parse one configuration change; validated patches cannot invent option keys. */
export function parseGuardianCommand(input: string): GuardianCommand {
  const flag = /\s+--(global|project)$/.exec(input.trim());
  const scope: GuardianSettingScope =
    flag?.[1] === "global" ? "global" : flag?.[1] === "project" ? "project" : "session";
  const text = flag ? input.trim().slice(0, flag.index) : input.trim();
  if (text === "" || text === "status") {
    if (flag) throw new Error(usage);
    return text === "" ? { action: "menu" } : { action: "status" };
  }
  if (text === "policy") return { action: "policy", scope };
  if (text === "on" || text === "off")
    return { action: "set", scope, key: "enabled", patch: { enabled: text === "on" } };
  const inherit = /^inherit(?:\s+(\S+))?$/.exec(text);
  if (inherit) return { action: "inherit", scope, key: guardianOptionKey(inherit[1] ?? "enabled") };
  const tool = /^tool\s+(\S+)\s+(\S+)$/.exec(text);
  if (tool?.[1] && tool[2]) {
    if (!isToolEntryValue(tool[2])) throw new Error(usage);
    return { action: "tool", scope, name: tool[1], value: tool[2] };
  }
  const set = /^set\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (!set?.[1] || !set[2]) throw new Error(usage);
  const key = guardianOptionKey(set[1]);
  const patch = parseGuardianOptions({ [key]: JSON.parse(set[2]) }, scope);
  return { action: "set", scope, key, patch };
}

/** Native command completion values replace the entire argument prefix. */
export function completeGuardianCommandArguments(prefix: string): AutocompleteItem[] {
  const candidates = ["on", "off", "status", "policy", "inherit", "set", "tool"];
  const keyPrefix = /^((?:set|inherit)\s+)\S*$/.exec(prefix)?.[1];
  if (keyPrefix) candidates.push(...guardianOptionKeys.map((key) => `${keyPrefix}${key}`));
  const valuePrefix = /^(tool\s+\S+\s+)\S*$/.exec(prefix)?.[1];
  if (valuePrefix) candidates.push(...toolEntryValues.map((value) => `${valuePrefix}${value}`));
  const scopePrefix = /^(.*\s+)(--\S*)?$/s.exec(prefix)?.[1];
  if (scopePrefix) {
    try {
      const command = parseGuardianCommand(scopePrefix);
      if ("scope" in command && command.scope === "session")
        candidates.push(`${scopePrefix}--global`, `${scopePrefix}--project`);
    } catch {
      // Incomplete commands and JSON values cannot accept a scope yet.
    }
  }
  return candidates
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value, label: value }));
}

/**
 * A scope's `tools` option after changing one entry; `undefined` when the scope no longer
 * authors any entry and should inherit the whole option.
 */
export function updatedToolEntries(
  authored: GuardianOptions["tools"],
  name: string,
  value: ToolEntryValue,
): GuardianOptions["tools"] {
  const next = { ...authored };
  if (value === "inherit") delete next[name];
  else next[name] = value === "default" ? null : value;
  return Object.keys(next).length ? next : undefined;
}
