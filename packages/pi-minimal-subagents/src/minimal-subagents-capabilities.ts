import type { DelegationMode, ToolSelection } from "./minimal-subagents-types.js";

/** Lists Pi thinking levels in increasing effort order for schema validation and clamping. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Defaults explicit fanout to root → child → grandchild when settings omit a depth. */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;
/** Lists the six coordinator tools excluded from ordinary child capabilities. */
export const COORDINATOR_TOOL_NAMES = [
  "subagent",
  "agent_message",
  "subagent_wait",
  "subagent_status",
  "subagent_cancel",
  "subagent_delete",
] as const;

const READ_TOOL_BUNDLE = ["read", "grep", "find", "ls"];
const MODIFY_TOOL_BUNDLE = [...READ_TOOL_BUNDLE, "bash", "edit", "write"];
const THINKING_SUFFIX_PATTERN = /:(?:off|minimal|low|medium|high|xhigh|max)$/;

interface ModelReference {
  provider: string;
  id: string;
}

interface ScopedModelReference {
  model: ModelReference;
  thinkingLevel?: string;
}

/** Remove a recognized Pi thinking suffix without changing model IDs containing other colons. */
export function stripThinkingSuffix(modelPattern: string): string {
  return modelPattern.replace(THINKING_SUFFIX_PATTERN, "");
}

/** Build the authenticated runtime model enum from Pi's already-resolved model scope. */
export function buildEligibleModelIds(input: {
  availableModels: readonly ModelReference[];
  scopedModels: readonly ScopedModelReference[];
  scopeConfigured?: boolean;
}): string[] {
  const scopeConfigured = input.scopeConfigured ?? input.scopedModels.length > 0;
  const source = scopeConfigured
    ? input.scopedModels.map((entry) => entry.model)
    : input.availableModels;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const model of source) {
    const canonicalId = stripThinkingSuffix(`${model.provider}/${model.id}`);
    if (!seen.has(canonicalId)) {
      seen.add(canonicalId);
      result.push(canonicalId);
    }
  }

  return result;
}

/** Supplies inherited tools, the ancestor ceiling, and runtime availability for exact tool resolution. */
export interface ToolResolutionContext {
  ordinaryTools: readonly string[];
  capabilityCeiling: readonly string[];
  availableTools: readonly string[];
}

/** Resolve an exact ordinary-tool contract and reject missing or over-ceiling capabilities. */
export function resolveOrdinaryToolSelection(
  selection: ToolSelection | undefined,
  context: ToolResolutionContext,
): string[] {
  const requested =
    selection === undefined
      ? [...context.ordinaryTools]
      : selection === "none"
        ? []
        : selection === "read"
          ? READ_TOOL_BUNDLE
          : selection === "modify"
            ? MODIFY_TOOL_BUNDLE
            : selection;
  const uniqueRequested = [...new Set(requested)];
  const available = new Set(context.availableTools);
  const ceiling = new Set(context.capabilityCeiling);
  const missing = uniqueRequested.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Minimal subagents tool resolution: unavailable tool: ${missing.join(", ")}`);
  }

  const exceeded = uniqueRequested.filter((name) => !ceiling.has(name));
  if (exceeded.length > 0) {
    throw new Error(`Minimal subagents capability ceiling exceeded: ${exceeded.join(", ")}`);
  }

  return uniqueRequested;
}

/** Return an agent's hierarchy depth where the interactive root is depth zero. */
export function getSubagentDepth(agentId: string): number {
  if (agentId === "root") return 0;
  const segments = agentId.split(".").length;
  return agentId.startsWith("root.") ? segments - 1 : segments;
}

/** Report whether an explicit fanout contract remains below the configured delegation depth cap. */
export function canAgentContractSpawn(
  agentId: string,
  delegation?: DelegationMode,
  maxSubagentDepth = DEFAULT_MAX_SUBAGENT_DEPTH,
): boolean {
  return delegation === "fanout" && getSubagentDepth(agentId) < maxSubagentDepth;
}

/** Return ordinary tools only, excluding all six coordinator tools. */
export function excludeCoordinatorTools(toolNames: readonly string[]): string[] {
  const coordinatorNames = new Set<string>(COORDINATOR_TOOL_NAMES);
  return toolNames.filter((name) => !coordinatorNames.has(name));
}
