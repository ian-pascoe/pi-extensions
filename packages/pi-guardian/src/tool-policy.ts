import type { CustomToolCallEvent, ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { judgeCommand } from "./safe-command.js";
import { sensitivePathReason, type SensitivePathContext } from "./sensitive-paths.js";
import type { PolicyEntries, ToolPolicy } from "./guardian-settings.js";

/** Which rule supplied a call's Tool Policy, in precedence order. */
export type ToolPolicySource = "command" | "setting" | "default" | "annotation" | "fallback";

/** A Tool Policy resolved for one call, with why. */
export interface ResolvedToolPolicy {
  policy: ToolPolicy;
  source: ToolPolicySource;
  /** Why a built-in default or Command Rule reviews or denies this particular call. */
  detail?: string;
}

/** Pi's built-in tools that only read; the only calls that run while settings are unreadable. */
export const readOnlyBuiltIns: readonly string[] = ["read", "grep", "find", "ls"];

/** Tools whose calls run without review by default. */
export const allowedByDefault: readonly string[] = [
  ...readOnlyBuiltIns,
  "codemode",
  "tool_search",
  "todo",
  "web_search",
  // Context Management: session-local notes, journal reads, and handoffs.
  "context_notes",
  "context_history",
  "context_rollover",
];
/** Tools reviewed by default regardless of their annotations. */
export const reviewedByDefault: readonly string[] = [
  "terminal_start",
  "terminal_send",
  "powershell",
];

/** Pi's built-in tools that write the file at their `path` argument. */
export function isFileWrite(toolName: string): boolean {
  return toolName === "edit" || toolName === "write";
}

/** Everything Tool Policy resolution reads for one call. */
export interface ToolPolicyInput {
  toolName: string;
  /** The call's arguments after earlier `tool_call` handlers ran. */
  input: CustomToolCallEvent["input"];
  /** Configured Tool Policies (`tools` setting), merged across scopes. */
  configured: Readonly<Record<string, ToolPolicy>>;
  /** Configured Command Rules (`commands` setting), merged across scopes. */
  commands: Readonly<PolicyEntries>;
  /** The tool's author-supplied annotations, if any. */
  annotations: ToolAnnotations | undefined;
  paths: SensitivePathContext;
}

/** Built-in default Tool Policy for one call, or `undefined` when the tool has none. */
function builtInDefault(call: ToolPolicyInput): ResolvedToolPolicy | undefined {
  const { toolName, input } = call;
  if (allowedByDefault.includes(toolName)) return { policy: "allow", source: "default" };
  if (reviewedByDefault.includes(toolName)) return { policy: "review", source: "default" };
  if (isFileWrite(toolName)) {
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
    const judged = typeof command === "string" ? judgeCommand(command, call.commands) : undefined;
    if (judged?.verdict === "allow") return { policy: "allow", source: "default" };
    const reason =
      judged?.verdict === "review" && judged.rule
        ? `the user's Command Rule ${JSON.stringify(judged.rule.prefix)} requires review`
        : "not a Safe Command";
    return { policy: "review", source: "default", detail: withCommandRules(reason, call.commands) };
  }
  return undefined;
}

/**
 * A reviewed `bash` call's reason, naming the user's `deny` and `review` Command Rules: they
 * match only segments whose leading words are literal, so the Guardian judges commands that
 * reach the same effect another way, such as through a wrapper or a path.
 */
function withCommandRules(reason: string, rules: Readonly<PolicyEntries>): string {
  const named = (policy: ToolPolicy) =>
    Object.entries(rules).flatMap(([prefix, value]) =>
      value === policy ? [JSON.stringify(prefix)] : [],
    );
  const denied = named("deny");
  const reviewed = named("review");
  const parts = [reason];
  if (denied.length)
    parts.push(`the user denies commands starting with ${denied.join(", ")} (Command Rules)`);
  if (reviewed.length)
    parts.push(`the user requires review of commands starting with ${reviewed.join(", ")}`);
  return parts.join("; ");
}

/**
 * Resolve one call's Tool Policy: a `deny` Command Rule for `bash`, else the configured `tools`
 * entry, else the built-in default (including Safe Command, Command Rule, and Sensitive Path
 * handling), else a `readOnlyHint` annotation without `openWorldHint`, else review.
 */
export function resolveToolPolicy(call: ToolPolicyInput): ResolvedToolPolicy {
  // A `deny` Command Rule is a hard limit, whatever the `bash` Tool Policy says.
  const command = call.toolName === "bash" ? call.input["command"] : undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; only a string command can match a Command Rule.
  if (typeof command === "string") {
    const judged = judgeCommand(command, call.commands);
    if (judged.verdict === "deny")
      return {
        policy: "deny",
        source: "command",
        detail: `the user's Command Rule ${JSON.stringify(judged.rule.prefix)} denies this command`,
      };
  }
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
