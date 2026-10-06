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
import type { TUI } from "@earendil-works/pi-tui";
import type { MinimalSubagentsCoordinator } from "./minimal-subagents-coordinator.js";
import { withTroubleshootingHint } from "./troubleshooting-skill.js";
import type { MinimalSubagentsModelRole } from "./minimal-subagents-config.js";
import {
  renderCoordinatorToolCall,
  renderCoordinatorToolResult,
  type CoordinatorToolName,
  type LiveTurnRenderer,
} from "./minimal-subagents-rendering.js";
import {
  createTranscriptRenderCache,
  TranscriptRail,
  type TranscriptRenderCache,
} from "./minimal-subagents-transcript.js";
import {
  CoordinatorToolOutputSchemas,
  type CoordinatorToolCallInput,
} from "./minimal-subagents-render-contract.js";
import type { createCoordinatorToolSchemas } from "./minimal-subagents-tool-schemas.js";
import type {
  ActiveTurnProgress,
  AgentDetail,
  AgentMessageResult,
  CallerSnapshot,
  CancelResult,
  DeleteResult,
  SpawnResult,
  StatusResult,
  WaitDeliveredTurnResult,
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
  | "spawn"
  | "inspectStatus"
  | "previewActiveTurn"
  | "inspectActiveTurnTranscript"
  | "sendAgentMessage"
  | "wait"
  | "status"
  | "cancel"
  | "delete"
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
    [
      "Configured model roles are guidance, not constraints. Pass role to launch with a role's model and thinking_level; an explicit model or thinking_level overrides the role's value:",
      ...roleLines,
    ].join("\n"),
    "Choose a role or model based on the task. A listed thinking_level is a preference, not a constraint. Callers choose thinking_level independently for roles without one.",
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

/** The compact launch result, plus the full agent detail its transcript renderer displays. */
type SpawnResultDetails = SpawnResult & { agent?: AgentDetail };

type CoordinatorToolResultDetails =
  | SpawnResultDetails
  | AgentMessageResult
  | WaitResult
  | StatusResult
  | CancelResult
  | DeleteResult
  | WaitProgressDetails;

/** Partial `subagent_wait` details: elapsed wait time plus the child's running-turn progress. */
type WaitProgressDetails = {
  agent_id: string;
  status: "waiting";
  elapsed_ms: number;
} & Partial<ActiveTurnProgress>;

type CoordinatorToolDefinition = ToolDefinition & {
  readonly outputSchema: (typeof CoordinatorToolOutputSchemas)[keyof typeof CoordinatorToolOutputSchemas];
};

/** Native transcript components are re-rendered on each wait update, so their render requests are not needed. */
const NON_RENDERING_TUI: Pick<TUI, "requestRender"> = { requestRender: () => undefined };

/** Pi's per-call render context; the installed Pi does not export its named type. */
type CoordinatorToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

/** Renderer state Pi keeps for one tool row across its partial and final renders. */
interface CoordinatorToolRowState {
  liveTurnCache?: TranscriptRenderCache;
}

function createCoordinatorToolRendering(
  options: CoordinatorToolDefinitionOptions,
  toolName: CoordinatorToolName,
) {
  return {
    renderCall: (
      args: CoordinatorToolCallInput,
      theme: Theme,
      context: { expanded: boolean } | undefined,
    ) => renderCoordinatorToolCall(toolName, args, theme, context?.expanded ?? false),
    renderResult: (
      result: AgentToolResult<CoordinatorToolResultDetails>,
      renderOptions: ToolRenderResultOptions,
      theme: Theme,
      context: CoordinatorToolRenderContext,
    ) => {
      const rowState: CoordinatorToolRowState = context.state;
      const renderLiveTurn: LiveTurnRenderer = (agentId, turnId, expanded) => {
        const snapshot = options.coordinator.inspectActiveTurnTranscript(
          options.callerId,
          agentId,
          turnId,
        );
        if (!snapshot || snapshot.messages.length === 0) return undefined;
        return new TranscriptRail(
          snapshot,
          // SAFETY: Native transcript components only call requestRender on the TUI they receive.
          NON_RENDERING_TUI as TUI,
          context.cwd,
          expanded,
          (rowState.liveTurnCache ??= createTranscriptRenderCache()),
          theme,
        );
      };
      return renderCoordinatorToolResult(
        toolName,
        result,
        renderOptions,
        theme,
        context.args,
        context.isError,
        toolName === "subagent_wait" ? renderLiveTurn : undefined,
      );
    },
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
    structuredContent: JSON.parse(json),
  };
}

/**
 * One line saying an already-delivered result is not repeated and how to reread it, followed by
 * any Coordination Messages the wait drained, which the parent has not seen yet.
 */
function alreadyDeliveredContent(
  result: WaitDeliveredTurnResult,
): AgentToolResult<WaitResult>["content"] {
  const notice = `Result of ${result.agent_id} turn ${result.turn_id} (${result.status}) was already delivered automatically; call subagent_wait with turn_id "${result.turn_id}" to reread it.`;
  if (!result.messages) return [{ type: "text", text: notice }];
  const messages = truncateHead(JSON.stringify({ messages: result.messages }, null, 2), {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return [{ type: "text", text: `${notice}\n${messages.content}` }];
}

/**
 * Report a failed operation that still carries declared output: the model sees an error and
 * codemode scripts receive `structuredContent` instead of a data-less rejection.
 */
function failedStructuredToolResult<TDetails extends CoordinatorToolResultDetails>(
  prefix: string,
  result: TDetails,
  options: { troubleshootingHint: boolean },
): AgentToolResult<TDetails> & { isError: true } {
  const success = structuredToolResult(result);
  const text = `${prefix}:\n${textOf(success)}`;
  return {
    ...success,
    content: [
      {
        type: "text" as const,
        text: options.troubleshootingHint ? withTroubleshootingHint(text) : text,
      },
    ],
    isError: true,
  };
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
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
): CoordinatorToolDefinition[] {
  const modelRolePromptGuidelines = buildModelRolePromptGuidelines(options.modelRoles ?? []);
  const spawnTool = defineTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Create a persistent nested agent asynchronously. Returns its canonical agent ID, active turn ID, and resolved model and tools immediately. Root-child IDs omit the root prefix; nested IDs retain the parent path. Children start without your conversation unless session_context opts in, so the task must be self-contained. Its final response is delivered automatically unless you claim it with subagent_wait. To continue an idle child later, send it agent_message; that starts a new turn you can wait on.",
    promptSnippet: "Spawn a persistent child with a prefix-free root-child ID",
    promptGuidelines: modelRolePromptGuidelines,
    parameters: options.schemas.subagent,
    // A spawn must finish registering before a wait or message in the same batch can target it.
    executionMode: "sequential",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      return runCoordinatorToolActivity(options, async () => {
        const result = await options.coordinator.spawn(
          options.callerId,
          parameters,
          options.captureCaller(context),
        );
        // The model and codemode receive the compact launch result; the transcript renderer
        // additionally receives the full detail it displays.
        const status = options.coordinator.inspectStatus(result.agent_id);
        const details: SpawnResultDetails = { ...result };
        if ("agent" in status) details.agent = status.agent;
        return { ...structuredToolResult(result), details };
      });
    },
    ...createCoordinatorToolRendering(options, "subagent"),
  });

  const messageTool = defineTool({
    name: "agent_message",
    label: "Agent Message",
    description:
      "Send one coordination message to a direct parent, direct sibling, or direct child. The result says whether it was delivered through an active wait, queued into the recipient's active turn, started a new turn on an idle child (with its turn_id), or failed.",
    promptSnippet: "Coordinate required mid-turn action with one adjacent agent",
    parameters: options.schemas.agent_message,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
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
        return result.disposition === "failed"
          ? failedStructuredToolResult("Minimal subagents message delivery failed", result, {
              // The coordinator already appends the hint to `error`.
              troubleshootingHint: false,
            })
          : structuredToolResult(result);
      });
    },
    ...createCoordinatorToolRendering(options, "agent_message"),
  });

  const waitTool = defineTool({
    name: "subagent_wait",
    label: "Subagent Wait",
    description:
      "Wait for one direct child's oldest observable turn whose result you have neither claimed nor received, or select an exact retained turn_id. An active child may first return event=message; later unconsumed items still fall back automatically. A settled turn returns event=turn, with any queued messages in messages; waiting again returns the same result. Without turn_id, a result already delivered to you automatically returns event=turn with already_delivered=true and no output; pass its turn_id to reread it. Timeout returns event=timeout with detailed child status and never cancels the child.",
    promptSnippet: "Wait for one direct child's exact turn",
    parameters: options.schemas.subagent_wait,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(_toolCallId, parameters, signal, onUpdate) {
      const startedAt = Date.now();
      const updateWaitingResult = () => {
        const details: WaitProgressDetails = {
          agent_id: parameters.agent_id,
          status: "waiting",
          elapsed_ms: Date.now() - startedAt,
          ...options.coordinator.previewActiveTurn(
            options.callerId,
            parameters.agent_id,
            parameters.turn_id,
          ),
        };
        onUpdate?.({
          content: [{ type: "text", text: `Waiting for ${parameters.agent_id}` }],
          details,
        });
      };
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
          const details = {
            ...result,
            source_agent_id: result.agent_id,
            source_turn_id: result.turn_id,
          };
          const toolResult = structuredToolResult(result);
          return {
            ...toolResult,
            content:
              "already_delivered" in result ? alreadyDeliveredContent(result) : toolResult.content,
            details,
            structuredContent: JSON.parse(JSON.stringify(details)),
          };
        });
      } finally {
        clearInterval(waitingInterval);
      }
    },
    ...createCoordinatorToolRendering(options, "subagent_wait"),
  });

  const statusTool = defineTool({
    name: "subagent_status",
    label: "Subagent Status",
    description:
      "List direct children when agent_id is omitted, or inspect one direct child's launch contract, result, usage, dependencies, and bounded recent activity including message text and reasoning. The root may inspect any descendant.",
    promptSnippet: "Inspect direct child state",
    parameters: options.schemas.subagent_status,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, parameters) {
      return runCoordinatorToolActivity(options, () =>
        structuredToolResult(options.coordinator.status(options.callerId, parameters.agent_id)),
      );
    },
    ...createCoordinatorToolRendering(options, "subagent_status"),
  });

  const cancelTool = defineTool({
    name: "subagent_cancel",
    label: "Subagent Cancel",
    description:
      "Abort active work for one direct child while preserving sessions for later continuation. Recursive cancellation includes its subtree and defaults to true.",
    promptSnippet: "Cancel active subagent turns without deleting sessions",
    parameters: options.schemas.subagent_cancel,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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
    ...createCoordinatorToolRendering(options, "subagent_cancel"),
  });

  const deleteTool = defineTool({
    name: "subagent_delete",
    label: "Subagent Delete",
    description:
      "Delete one direct child's persistent session and retain durable ID tombstones. Recursive deletion includes its subtree and defaults to true.",
    promptSnippet: "Delete subagent sessions and tombstone their IDs",
    parameters: options.schemas.subagent_delete,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
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
          return failedStructuredToolResult("Minimal subagents deletion partially failed", result, {
            troubleshootingHint: true,
          });
        }
        return structuredToolResult(result);
      });
    },
    ...createCoordinatorToolRendering(options, "subagent_delete"),
  });

  const coordinatorTools: CoordinatorToolDefinition[] = [
    Object.assign(spawnTool, { outputSchema: CoordinatorToolOutputSchemas.subagent }),
    Object.assign(messageTool, { outputSchema: CoordinatorToolOutputSchemas.agent_message }),
    Object.assign(waitTool, { outputSchema: CoordinatorToolOutputSchemas.subagent_wait }),
    Object.assign(statusTool, { outputSchema: CoordinatorToolOutputSchemas.subagent_status }),
    Object.assign(cancelTool, { outputSchema: CoordinatorToolOutputSchemas.subagent_cancel }),
    Object.assign(deleteTool, { outputSchema: CoordinatorToolOutputSchemas.subagent_delete }),
  ];
  const allowFanoutTools = options.allowFanoutTools ?? options.callerId === "root";
  return allowFanoutTools
    ? coordinatorTools
    : coordinatorTools.filter((tool) => ORDINARY_CHILD_COORDINATOR_TOOL_NAMES.has(tool.name));
}
