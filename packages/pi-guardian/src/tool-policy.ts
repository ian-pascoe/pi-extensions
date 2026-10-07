import type { CustomToolCallEvent, ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { isSafeCommand } from "./safe-command.js";
import { sensitivePathReason, type SensitivePathContext } from "./sensitive-paths.js";
import type { ToolPolicy } from "./guardian-settings.js";

/** Which rule supplied a call's Tool Policy, in precedence order. */
export type ToolPolicySource = "setting" | "default" | "annotation" | "fallback";

/** A Tool Policy resolved for one call, with why. */
export interface ResolvedToolPolicy {
  policy: ToolPolicy;
  source: ToolPolicySource;
  /** Why a built-in default sends this particular call to review. */
  detail?: string;
}

/** Tools whose calls run without review by default. */
export const allowedByDefault: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "codemode",
  "tool_search",
  "todo",
  "web_search",
];
/** Tools reviewed by default regardless of their annotations. */
export const reviewedByDefault: readonly string[] = [
  "terminal_start",
  "terminal_send",
  "powershell",
];

/** Everything Tool Policy resolution reads for one call. */
export interface ToolPolicyInput {
  toolName: string;
  /** The call's arguments after earlier `tool_call` handlers ran. */
  input: CustomToolCallEvent["input"];
  /** Configured Tool Policies (`tools` setting), merged across scopes. */
  configured: Readonly<Record<string, ToolPolicy>>;
  /** Configured Safe Command prefixes (`safeCommands` setting). */
  safeCommands: readonly string[];
  /** The tool's author-supplied annotations, if any. */
  annotations: ToolAnnotations | undefined;
  paths: SensitivePathContext;
}

/** Built-in default Tool Policy for one call, or `undefined` when the tool has none. */
function builtInDefault(call: ToolPolicyInput): ResolvedToolPolicy | undefined {
  const { toolName, input } = call;
  if (allowedByDefault.includes(toolName)) return { policy: "allow", source: "default" };
  if (reviewedByDefault.includes(toolName)) return { policy: "review", source: "default" };
  if (toolName === "edit" || toolName === "write") {
    const path = input["path"];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; a non-string path cannot be judged and is reviewed.
    if (typeof path !== "string")
      return { policy: "review", source: "default", detail: "the target path is not a string" };
    const reason = sensitivePathReason(path, call.paths);
    return reason
      ? { policy: "review", source: "default", detail: `Sensitive Path: ${reason}` }
      : { policy: "allow", source: "default" };
  }
  if (toolName === "bash") {
    const command = input["command"];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; a non-string command cannot be judged and is reviewed.
    if (typeof command === "string" && isSafeCommand(command, call.safeCommands))
      return { policy: "allow", source: "default" };
    return { policy: "review", source: "default", detail: "not a Safe Command" };
  }
  return undefined;
}

/**
 * Resolve one call's Tool Policy: the configured `tools` entry, else the built-in default
 * (including Safe Command and Sensitive Path exemptions), else a `readOnlyHint` annotation without
 * `openWorldHint`, else review.
 */
export function resolveToolPolicy(call: ToolPolicyInput): ResolvedToolPolicy {
  const configured = Object.hasOwn(call.configured, call.toolName)
    ? call.configured[call.toolName]
    : undefined;
  if (configured) return { policy: configured, source: "setting" };
  const fallback = builtInDefault(call);
  if (fallback) return fallback;
  // A read-only tool that reaches the open world, such as a URL fetch, can still send data out.
  if (call.annotations?.readOnlyHint === true && call.annotations.openWorldHint !== true)
    return { policy: "allow", source: "annotation" };
  return { policy: "review", source: "fallback" };
}
