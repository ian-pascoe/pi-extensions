import {
  completeSettingsCommandArguments,
  parseSettingsCommand,
  type SettingsCommand,
} from "@ian-pascoe/pi-utils/settings-command";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  advisorOptionKey,
  advisorOptionKeys,
  parseAdvisorOptions,
  type AdvisorOptions,
  type AdvisorSettingScope,
} from "./advisor-settings.js";

/** Native command completion values replace the entire argument prefix. */
export function completeAdvisorCommandArguments(prefix: string): AutocompleteItem[] {
  return completeSettingsCommandArguments(prefix, {
    words: ["on", "off", "status", "prompt", "inherit", "set"],
    optionKeys: advisorOptionKeys,
    parse: parseAdvisorCommand,
  });
}

const usage =
  "Usage: /advisor [on|off|status|prompt|inherit [key]|set <key> <JSON>] [--global|--project]; /advisor alone opens settings";

/** One parsed `/advisor` command. */
export type AdvisorCommand = SettingsCommand<
  AdvisorOptions,
  keyof AdvisorOptions,
  { action: "prompt"; scope: AdvisorSettingScope }
>;

/** Parse one configuration change; validated patches cannot invent option keys. */
export function parseAdvisorCommand(input: string): AdvisorCommand {
  return parseSettingsCommand(input, {
    usage,
    optionKey: advisorOptionKey,
    parseOptions: parseAdvisorOptions,
    toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
    parseExtra: (text, scope) => (text === "prompt" ? { action: "prompt", scope } : undefined),
  });
}
