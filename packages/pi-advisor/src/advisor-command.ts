import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  advisorOptionKey,
  advisorOptionKeys,
  parseAdvisorOptions,
  type AdvisorOptions,
} from "./advisor-settings.js";

/** Native command completion values replace the entire argument prefix. */
export function completeAdvisorCommandArguments(prefix: string): AutocompleteItem[] {
  const candidates = ["on", "off", "status", "prompt", "inherit", "set"];
  const keyPrefix = /^((?:set|inherit)\s+)\S*$/.exec(prefix)?.[1];
  if (keyPrefix) candidates.push(...advisorOptionKeys.map((key) => `${keyPrefix}${key}`));
  const scopePrefix = /^(.*\s+)(--\S*)?$/s.exec(prefix)?.[1];
  if (scopePrefix) {
    try {
      const command = parseAdvisorCommand(scopePrefix);
      if (command.action !== "status" && command.scope === "session")
        candidates.push(`${scopePrefix}--global`, `${scopePrefix}--project`);
    } catch {
      // Incomplete commands and JSON values cannot accept a scope yet.
    }
  }
  return candidates
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value, label: value }));
}

const usage =
  "Usage: /advisor [on|off|status|prompt|inherit [key]|set <key> <JSON>] [--global|--project]";

/** Parse one configuration change; validated patches cannot invent option keys. */
export function parseAdvisorCommand(input: string) {
  const flag = /\s+--(global|project)$/.exec(input.trim());
  const scope =
    flag?.[1] === "global"
      ? ("global" as const)
      : flag?.[1] === "project"
        ? ("project" as const)
        : ("session" as const);
  const text = (flag ? input.trim().slice(0, flag.index) : input.trim()) || "status";
  if (text === "status") {
    if (flag) throw new Error(usage);
    return { action: "status" as const };
  }
  if (text === "prompt") return { action: "prompt" as const, scope };
  if (text === "on" || text === "off") {
    return { action: "set" as const, scope, patch: { enabled: text === "on" } };
  }
  const inherit = /^inherit(?:\s+(\S+))?$/.exec(text);
  if (inherit) {
    return { action: "inherit" as const, scope, key: advisorOptionKey(inherit[1] ?? "enabled") };
  }
  const set = /^set\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (!set?.[1] || !set[2]) throw new Error(usage);
  const patch: AdvisorOptions = parseAdvisorOptions({ [set[1]]: JSON.parse(set[2]) }, scope);
  return { action: "set" as const, scope, patch };
}
