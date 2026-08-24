import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type AgentToolResult,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import type { MinimalSubagentsModelRole } from "./minimal-subagents-config.js";
import {
  renderCoordinatorToolCall,
  renderCoordinatorToolResult,
  type CoordinatorToolName,
} from "./minimal-subagents-rendering.js";
import type { CoordinatorToolCallInput } from "./minimal-subagents-render-contract.js";
import type { createCoordinatorToolSchemas } from "./minimal-subagents-tool-schemas.js";
import type {
  AgentMessageResult,
  CallerSnapshot,
  CancelResult,
  DeleteResult,
  SpawnResult,
  StatusResult,
  WaitResult,
} from "./minimal-subagents-types.js";

const ORDINARY_CHILD_COORDINATOR_TOOL_NAMES = new Set([
  "agent_message",
  "subagent_wait",
  "subagent_status",
]);

/** Coordinator operations consumed by the six public coordinator tool definitions. */
export type CoordinatorToolOperations = Pick<
  MinimalSubagentsCoordinator,
  "spawn" | "inspectStatus" | "sendAgentMessage" | "wait" | "status" | "cancel" | "delete"
>;

/** Dependencies and caller policy used to create caller-bound coordinator tools. */
export interface CoordinatorToolDefinitionOptions {
  coordinator: CoordinatorToolOperations;
  callerId: string;
  allowFanoutTools?: boolean;
  modelRoles?: readonly MinimalSubagentsModelRole[];
  schemas: ReturnType<typeof createCoordinatorToolSchemas>;
  captureCaller: (context: ExtensionContext) => CallerSnapshot;
  onActivity?: () => void;
  onAttention?: (message: string) => void;
}

function buildModelRolePromptGuidelines(
  modelRoles: readonly MinimalSubagentsModelRole[],
): string[] | undefined {
  if (modelRoles.length === 0) return undefined;
  const roleLines = modelRoles.map((role) => {
    const thinkingGuidance = role.thinkingLevel ? `, thinking_level=${role.thinkingLevel}` : "";
    return `  - ${role.name} → model=${role.model}${thinkingGuidance}${role.hint ? ` — ${role.hint}` : ""}`;
  });
  return [
    ["Configured model roles are guidance, not constraints:", ...roleLines].join("\n"),
    "Choose a model based on the task. A listed thinking_level is a preference, not a constraint. Callers choose thinking_level independently for roles without one.",
  ];
}

async function runCoordinatorToolActivity<T>(
  options: CoordinatorToolDefinitionOptions,
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    return await operation();
  } finally {
    options.onActivity?.();
  }
}

type CoordinatorToolResultDetails =
  | SpawnResult
  | AgentMessageResult
  | WaitResult
  | StatusResult
  | CancelResult
  | DeleteResult
  | { agent_id: string; status: "waiting"; elapsed_ms: number };

function createCoordinatorToolRendering(toolName: CoordinatorToolName) {
  return {
    renderCall: (args: CoordinatorToolCallInput, theme: Theme) =>
      renderCoordinatorToolCall(toolName, args, theme),
    renderResult: (
      result: AgentToolResult<CoordinatorToolResultDetails>,
      renderOptions: ToolRenderResultOptions,
      theme: Theme,
      context: { args: CoordinatorToolCallInput; isError: boolean },
    ) =>
      renderCoordinatorToolResult(
        toolName,
        result,
        renderOptions,
        theme,
        context.args,
        context.isError,
      ),
  };
}

function structuredToolResult<TDetails extends CoordinatorToolResultDetails>(
  result: TDetails,
): AgentToolResult<TDetails> {
  const json = JSON.stringify(result, null, 2);
  const truncated = truncateHead(json, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return {
    content: [{ type: "text" as const, text: truncated.content }],
    details: result,
  };
}

function failedStructuredOperation(prefix: string, result: DeleteResult): never {
  const json = JSON.stringify(result);
  const truncated = truncateHead(json, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  throw new Error(`${prefix}: ${truncated.content}`);
}

function callerSourceTurnId(
  coordinator: CoordinatorToolOperations,
  callerId: string,
  toolCallId: string,
): string {
  if (callerId === "root") return `root:${toolCallId}`;
  const status = coordinator.inspectStatus(callerId);
  return "agent" in status && status.agent.active_turn_id
    ? status.agent.active_turn_id
    : `${callerId}:${toolCallId}`;
}

/** Create caller-bound definitions for the six coordinator tools shared by root and children. */
export function createCoordinatorToolDefinitions(
  options: CoordinatorToolDefinitionOptions,
): ToolDefinition[] {
  const modelRolePromptGuidelines = buildModelRolePromptGuidelines(options.modelRoles ?? []);
  const spawnTool = defineTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Create a persistent nested agent asynchronously. Returns its canonical agent ID and active turn ID immediately. Root-child IDs omit the root prefix; nested IDs retain the parent path.",
    promptSnippet: "Spawn a persistent child with a prefix-free root-child ID",
    promptGuidelines: modelRolePromptGuidelines,
    parameters: options.schemas.subagent,
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return runCoordinatorToolActivity(options, async () => {
        const result = await options.coordinator.spawn(
          options.callerId,
          parameters,
          options.captureCaller(context),
        );
        const status = options.coordinator.inspectStatus(result.agent_id);
        const details: SpawnResult & {
          agent?: import("./minimal-subagents-types.js").AgentDetail;
        } = {
          ...result,
        };
        if (status && "agent" in status) details.agent = status.agent;
        return structuredToolResult(details);
      });
    },
    ...createCoordinatorToolRendering("subagent"),
  });

  const messageTool = defineTool({
    name: "agent_message",
    label: "Agent Message",
    description:
      "Send one mid-turn coordination message to a direct parent, direct sibling, or direct child. The result says whether it was delivered through an active wait, queued for the recipient, or failed.",
    promptSnippet: "Coordinate required mid-turn action with one adjacent agent",
    parameters: options.schemas.agent_message,
    async execute(toolCallId, parameters) {
      return runCoordinatorToolActivity(options, async () => {
        const result = await options.coordinator.sendAgentMessage(
          options.callerId,
          {
            agent_id: parameters.agent_id,
            message: parameters.message,
          },
          callerSourceTurnId(options.coordinator, options.callerId, toolCallId),
        );
        return structuredToolResult(result);
      });
    },
    ...createCoordinatorToolRendering("agent_message"),
  });

  const waitTool = defineTool({
    name: "subagent_wait",
    label: "Subagent Wait",
    description:
      "Wait for one direct child's oldest observable turn, or select an exact retained turn_id. An active child may first return event=message; later unconsumed items still fall back automatically. An already settled turn returns event=turn once with queued messages in messages. Timeout returns event=timeout with detailed child status and never cancels the child.",
    promptSnippet: "Wait for one direct child's exact turn",
    parameters: options.schemas.subagent_wait,
    async execute(_toolCallId, parameters, signal, onUpdate) {
      const startedAt = Date.now();
      const updateWaitingResult = () =>
        onUpdate?.({
          content: [{ type: "text", text: `Waiting for ${parameters.agent_id}` }],
          details: {
            agent_id: parameters.agent_id,
            status: "waiting",
            elapsed_ms: Date.now() - startedAt,
          },
        });
      updateWaitingResult();
      const waitingInterval = setInterval(updateWaitingResult, 1_000);
      waitingInterval.unref?.();
      try {
        return await runCoordinatorToolActivity(options, async () => {
          const result = await options.coordinator.wait(
            options.callerId,
            parameters.agent_id,
            parameters.timeout_ms,
            signal,
            parameters.turn_id,
          );
          return {
            ...structuredToolResult(result),
            details: {
              ...result,
              source_agent_id: result.agent_id,
              source_turn_id: result.turn_id,
            },
          };
        });
      } finally {
        clearInterval(waitingInterval);
      }
    },
    ...createCoordinatorToolRendering("subagent_wait"),
  });

  const statusTool = defineTool({
    name: "subagent_status",
    label: "Subagent Status",
    description:
      "List direct children when agent_id is omitted, or inspect one direct child's launch contract, result, usage, dependencies, and bounded recent activity including message text and reasoning.",
    promptSnippet: "Inspect direct child state",
    parameters: options.schemas.subagent_status,
    async execute(_toolCallId, parameters) {
      return runCoordinatorToolActivity(options, () =>
        structuredToolResult(options.coordinator.status(options.callerId, parameters.agent_id)),
      );
    },
    ...createCoordinatorToolRendering("subagent_status"),
  });

  const cancelTool = defineTool({
    name: "subagent_cancel",
    label: "Subagent Cancel",
    description:
      "Abort active work for one direct child while preserving sessions for later continuation. Recursive cancellation includes its subtree and defaults to true.",
    promptSnippet: "Cancel active subagent turns without deleting sessions",
    parameters: options.schemas.subagent_cancel,
    async execute(_toolCallId, parameters) {
      return runCoordinatorToolActivity(options, async () =>
        structuredToolResult(
          await options.coordinator.cancel(
            options.callerId,
            parameters.agent_id,
            parameters.recursive ?? true,
          ),
        ),
      );
    },
    ...createCoordinatorToolRendering("subagent_cancel"),
  });

  const deleteTool = defineTool({
    name: "subagent_delete",
    label: "Subagent Delete",
    description:
      "Delete one direct child's persistent session and retain durable ID tombstones. Recursive deletion includes its subtree and defaults to true.",
    promptSnippet: "Delete subagent sessions and tombstone their IDs",
    parameters: options.schemas.subagent_delete,
    async execute(_toolCallId, parameters) {
      return runCoordinatorToolActivity(options, async () => {
        const result = await options.coordinator.delete(
          options.callerId,
          parameters.agent_id,
          parameters.recursive ?? true,
        );
        if (result.failures.length > 0) {
          options.onAttention?.(
            `Minimal subagents deletion partially failed for ${parameters.agent_id}`,
          );
          failedStructuredOperation("Minimal subagents deletion partially failed", result);
        }
        return structuredToolResult(result);
      });
    },
    ...createCoordinatorToolRendering("subagent_delete"),
  });

  const coordinatorTools = [spawnTool, messageTool, waitTool, statusTool, cancelTool, deleteTool];
  const allowFanoutTools = options.allowFanoutTools ?? options.callerId === "root";
  return allowFanoutTools
    ? coordinatorTools
    : coordinatorTools.filter((tool) => ORDINARY_CHILD_COORDINATOR_TOOL_NAMES.has(tool.name));
}
