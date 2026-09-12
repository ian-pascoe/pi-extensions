import { advisorOptionKey, parseAdvisorOptions, type AdvisorOptions } from "./advisor-settings.js";

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
