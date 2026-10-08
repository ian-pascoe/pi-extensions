import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  completeSettingsCommandArguments,
  parseSettingsCommand,
  type SettingsCommand,
} from "@ian-pascoe/pi-utils/settings-command";
import {
  guardianOptionKey,
  guardianOptionKeys,
  parseGuardianOptions,
  type GuardianOptions,
  type AuthoredPolicyEntries,
  type GuardianSettingScope,
  type ToolPolicy,
} from "./guardian-settings.js";

const usage =
  "Usage: /guardian [on|off|status|policy|inherit [key]|set <key> <JSON>|tool <name> <allow|review|deny|default|inherit>|command <prefix> <allow|review|deny|default|inherit>] [--global|--project]; /guardian alone opens settings";

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
export type GuardianCommand = SettingsCommand<
  GuardianOptions,
  keyof GuardianOptions,
  | { action: "policy"; scope: GuardianSettingScope }
  | { action: "tool"; scope: GuardianSettingScope; name: string; value: ToolEntryValue }
  | { action: "command"; scope: GuardianSettingScope; prefix: string; value: ToolEntryValue }
>;

/** Parse one configuration change; validated patches cannot invent option keys. */
export function parseGuardianCommand(input: string): GuardianCommand {
  return parseSettingsCommand(input, {
    usage,
    optionKey: guardianOptionKey,
    parseOptions: parseGuardianOptions,
    toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
    parseExtra: (text, scope) => {
      if (text === "policy") return { action: "policy", scope };
      // A Command Rule's prefix is every word between `command` and the value.
      const rule = /^command\s+(.+?)\s+(\S+)$/s.exec(text);
      if (rule?.[1] && rule[2]) {
        if (!isToolEntryValue(rule[2])) throw new Error(usage);
        // Validate the prefix now, so a typo is reported before any change is written.
        parseGuardianOptions({ commands: { [rule[1]]: null } }, scope);
        return { action: "command", scope, prefix: rule[1], value: rule[2] };
      }
      const tool = /^tool\s+(\S+)\s+(\S+)$/.exec(text);
      if (!tool?.[1] || !tool[2]) return undefined;
      if (!isToolEntryValue(tool[2])) throw new Error(usage);
      return { action: "tool", scope, name: tool[1], value: tool[2] };
    },
  });
}

/** Native command completion values replace the entire argument prefix. */
export function completeGuardianCommandArguments(prefix: string): AutocompleteItem[] {
  return completeSettingsCommandArguments(prefix, {
    words: ["on", "off", "status", "policy", "inherit", "set", "tool", "command"],
    optionKeys: guardianOptionKeys,
    parse: parseGuardianCommand,
    extra: (value) => {
      const valuePrefix = /^((?:tool|command)\s+\S+\s+)\S*$/.exec(value)?.[1];
      return valuePrefix ? toolEntryValues.map((entry) => `${valuePrefix}${entry}`) : [];
    },
  });
}

/**
 * A scope's `tools` or `commands` option after changing one entry; `undefined` when the scope no
 * longer authors any entry and should inherit the whole option.
 */
export function updatedToolEntries(
  authored: AuthoredPolicyEntries | undefined,
  name: string,
  value: ToolEntryValue,
): AuthoredPolicyEntries | undefined {
  const next = { ...authored };
  if (value === "inherit") delete next[name];
  else next[name] = value === "default" ? null : value;
  return Object.keys(next).length ? next : undefined;
}
