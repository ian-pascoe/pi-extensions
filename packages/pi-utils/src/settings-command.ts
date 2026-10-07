import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { LayeredSettingScope } from "./layered-settings.js";

/** One parsed settings command; `Extra` adds the command's own actions. */
export type SettingsCommand<Options, Key extends string, Extra = never> =
  | { action: "menu" }
  | { action: "status" }
  | { action: "set"; scope: LayeredSettingScope; key: Key; patch: Options }
  | { action: "inherit"; scope: LayeredSettingScope; key: Key }
  | Extra;

/** What a settings command supplies to {@link parseSettingsCommand}. */
export interface SettingsCommandSpec<Options, Key extends string, Extra = never> {
  /** Error message for a malformed command or a scope flag on `status` or the bare menu. */
  usage: string;
  /** Validate a typed option key, throwing for an unknown one. */
  optionKey: (text: string) => Key;
  /** Validate `{ [key]: value }` for one scope, throwing for an invalid value. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: The value is parsed user JSON; the spec's option schema validates it before use.
  parseOptions: (value: unknown, scope: LayeredSettingScope) => Options;
  /** The key and patch that `on` (true) and `off` (false) set; `inherit` alone clears this key. */
  toggle: (enabled: boolean) => { key: Key; patch: Options };
  /**
   * Command-specific actions, tried before the shared ones on the text with its scope flag
   * removed; `undefined` leaves the text to the shared parser.
   */
  parseExtra?: (text: string, scope: LayeredSettingScope) => Extra | undefined;
}

/**
 * Parse `[on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]`, plus the spec's
 * own actions. Blank input opens the menu. A trailing flag selects the scope, `session` by
 * default. Validation errors come from the spec; a malformed command throws `spec.usage`.
 */
export function parseSettingsCommand<Options, Key extends string, Extra = never>(
  input: string,
  spec: SettingsCommandSpec<Options, Key, Extra>,
): SettingsCommand<Options, Key, Extra> {
  const flag = /\s+--(global|project)$/.exec(input.trim());
  const scope: LayeredSettingScope =
    flag?.[1] === "global" ? "global" : flag?.[1] === "project" ? "project" : "session";
  const text = flag ? input.trim().slice(0, flag.index) : input.trim();
  if (text === "" || text === "status") {
    if (flag) throw new Error(spec.usage);
    return text === "" ? { action: "menu" } : { action: "status" };
  }
  const extra = spec.parseExtra?.(text, scope);
  if (extra !== undefined) return extra;
  if (text === "on" || text === "off")
    return { action: "set", scope, ...spec.toggle(text === "on") };
  const inherit = /^inherit(?:\s+(\S+))?$/.exec(text);
  if (inherit)
    return { action: "inherit", scope, key: spec.optionKey(inherit[1] ?? spec.toggle(true).key) };
  const set = /^set\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (!set?.[1] || !set[2]) throw new Error(spec.usage);
  const key = spec.optionKey(set[1]);
  // JSON.parse throws a SyntaxError for malformed values, reported to the user as is.
  const patch = spec.parseOptions({ [key]: JSON.parse(set[2]) }, scope);
  return { action: "set", scope, key, patch };
}

/** What a settings command supplies to {@link completeSettingsCommandArguments}. */
export interface SettingsCompletionSpec {
  /** Top-level words, such as `on` and `status`. */
  words: readonly string[];
  /** Option keys completed after `set ` and `inherit `. */
  optionKeys: readonly string[];
  /** The command's parser, used to offer a scope flag once the command is complete. */
  parse: (text: string) => { action: string; scope?: LayeredSettingScope };
  /** Further full-prefix completions, such as values for a command's own arguments. */
  extra?: (prefix: string) => readonly string[];
}

/** Native command completion values replace the entire argument prefix. */
export function completeSettingsCommandArguments(
  prefix: string,
  spec: SettingsCompletionSpec,
): AutocompleteItem[] {
  const candidates = [...spec.words];
  const keyPrefix = /^((?:set|inherit)\s+)\S*$/.exec(prefix)?.[1];
  if (keyPrefix) candidates.push(...spec.optionKeys.map((key) => `${keyPrefix}${key}`));
  candidates.push(...(spec.extra?.(prefix) ?? []));
  const scopePrefix = /^(.*\s+)(--\S*)?$/s.exec(prefix)?.[1];
  if (scopePrefix) {
    try {
      if (spec.parse(scopePrefix).scope === "session")
        candidates.push(`${scopePrefix}--global`, `${scopePrefix}--project`);
    } catch {
      // Incomplete commands and JSON values cannot accept a scope yet.
    }
  }
  return candidates
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value, label: value }));
}
