import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contentText,
  type AssistantMessage,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import type {
  ActiveTurnProgress,
  ChildAgentTranscriptSnapshot,
  RecentAgentActivity,
  SessionContextMode,
} from "./minimal-subagents-types.js";

const RECENT_AGENT_ACTIVITY_LIMIT = 12;
const RECENT_AGENT_ACTIVITY_MAX_LINES = 20;
const RECENT_AGENT_ACTIVITY_MAX_BYTES = 2 * 1024;

/** Clone committed caller messages and exclude only the currently streaming assistant message. */
export function snapshotCommittedContext(
  messages: readonly AgentMessage[],
  callerIsStreaming: boolean,
): AgentMessage[] {
  const committed = [...messages];
  if (callerIsStreaming && committed.at(-1)?.role === "assistant") committed.pop();
  return structuredClone(committed);
}

function boundedRecentActivityContent(label: string, content: string): RecentAgentActivity {
  const bounded = boundRecentAgentText(content);
  return { label, content: bounded.content, truncated: bounded.truncated };
}

/** Contains bounded Child Agent text and whether truncation removed earlier content. */
export interface BoundedRecentAgentText {
  readonly content: string;
  readonly truncated: boolean;
}

/** Bound Child Agent transcript fallback text to the Recent Activity line and byte limits. */
export function boundRecentAgentText(content: string): BoundedRecentAgentText {
  const bounded = truncateTail(content, {
    maxLines: RECENT_AGENT_ACTIVITY_MAX_LINES,
    maxBytes: RECENT_AGENT_ACTIVITY_MAX_BYTES,
  });
  return { content: bounded.content, truncated: bounded.truncated };
}

function visibleMessageContent(content: string | readonly (TextContent | ImageContent)[]): string {
  return contentText(content, "\n\n") || "(no text content)";
}

function replaceAgentMessageImages(message: AgentMessage): AgentMessage {
  if (message.role === "user" || message.role === "custom") {
    return {
      ...structuredClone(message),
      content: Array.isArray(message.content)
        ? message.content.map((content) =>
            content.type === "image"
              ? { type: "text" as const, text: `[Image: ${content.mimeType}]` }
              : structuredClone(content),
          )
        : message.content,
    };
  }
  if (message.role === "toolResult") {
    return {
      ...structuredClone(message),
      content: message.content.map((content) =>
        content.type === "image"
          ? { type: "text" as const, text: `[Image: ${content.mimeType}]` }
          : structuredClone(content),
      ),
    };
  }
  return structuredClone(message);
}

/** Clone the complete visible UI transcript, replacing images without bounding conversation history. */
export function selectChildAgentTranscript(
  messages: readonly AgentMessage[],
  streamingAssistantMessage?: AgentMessage,
): ChildAgentTranscriptSnapshot {
  const visible = messages.filter((message) => message.role !== "custom" || message.display);
  const streaming = streamingAssistantMessage && !messages.includes(streamingAssistantMessage);
  return {
    messages: [
      ...visible.map(replaceAgentMessageImages),
      ...(streaming ? [replaceAgentMessageImages(streamingAssistantMessage)] : []),
    ],
    streamingAssistantIndex: streaming ? visible.length : undefined,
    toolDefinitions: [],
  };
}

/** Build a bounded recent activity tail from message text, reasoning, and tool work. */
export function buildRecentAgentActivity(messages: readonly AgentMessage[]): RecentAgentActivity[] {
  const activity: RecentAgentActivity[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "text" && content.text) {
          activity.push(boundedRecentActivityContent("assistant message", content.text));
        } else if (content.type === "thinking") {
          activity.push(
            boundedRecentActivityContent(
              "reasoning",
              content.thinking ||
                (content.redacted ? "[redacted reasoning]" : "(no reasoning text)"),
            ),
          );
        } else if (content.type === "toolCall") {
          activity.push(
            boundedRecentActivityContent(
              `tool call ${content.name}`,
              JSON.stringify(content.arguments, null, 2),
            ),
          );
        }
      }
    } else if (message.role === "toolResult") {
      activity.push(
        boundedRecentActivityContent(
          `tool result ${message.toolName}${message.isError ? " (error)" : ""}`,
          visibleMessageContent(message.content),
        ),
      );
    } else if (message.role === "user" || message.role === "custom") {
      activity.push(
        boundedRecentActivityContent(
          `${message.role} message`,
          visibleMessageContent(message.content),
        ),
      );
    } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
      activity.push(boundedRecentActivityContent(`${message.role} message`, message.summary));
    } else if (message.role === "bashExecution") {
      activity.push(
        boundedRecentActivityContent(
          `${message.role} message`,
          `$ ${message.command}\n${message.output || "(no output)"}`,
        ),
      );
    }
  }
  return activity.slice(-RECENT_AGENT_ACTIVITY_LIMIT);
}

/** A message the child produced during the turn, as opposed to the turn's prompt or coordination input. */
function isTurnWork(message: AgentMessage, turnStartedAtMs: number): boolean {
  return (
    message.timestamp >= turnStartedAtMs &&
    (message.role === "assistant" || message.role === "toolResult")
  );
}

/** Count the tool calls a running turn has made so far. */
export function buildActiveTurnProgress(
  messages: readonly AgentMessage[],
  turnStartedAtMs: number,
): Omit<ActiveTurnProgress, "turn_id"> {
  let toolCalls = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !isTurnWork(message, turnStartedAtMs)) continue;
    toolCalls += message.content.filter((content) => content.type === "toolCall").length;
  }
  return { tool_calls: toolCalls };
}

/**
 * Keep the running turn's last `assistantMessageCount` assistant messages and the tool results after
 * them, so a live view renders recent work without the turn's earlier history.
 */
export function selectActiveTurnTranscript(
  snapshot: ChildAgentTranscriptSnapshot,
  turnStartedAtMs: number,
  assistantMessageCount: number,
): ChildAgentTranscriptSnapshot {
  const work = snapshot.messages.flatMap((message, index) =>
    isTurnWork(message, turnStartedAtMs) ? [{ message, index }] : [],
  );
  const assistantPositions = work.flatMap((entry, position) =>
    entry.message.role === "assistant" ? [position] : [],
  );
  const tail = work.slice(assistantPositions.at(-assistantMessageCount) ?? 0);
  const streamingPosition = tail.findIndex(
    (entry) => entry.index === snapshot.streamingAssistantIndex,
  );
  return {
    messages: tail.map((entry) => entry.message),
    streamingAssistantIndex: streamingPosition >= 0 ? streamingPosition : undefined,
    toolDefinitions: snapshot.toolDefinitions,
  };
}

/** Carries the selected caller messages and whether child preparation should compact them. */
export interface ImportedSubagentContext {
  messages: AgentMessage[];
  compact: boolean;
}

/** Custom message type carrying one quoted message from a parent's conversation. */
export const PARENT_CONTEXT_MESSAGE_TYPE = "minimal-subagents.parent-context";

type QuotedContent = TextContent | ImageContent;

function quotedParts(content: string | QuotedContent[]): QuotedContent[] {
  if (Array.isArray(content)) return content.map((part) => structuredClone(part));
  return content ? [{ type: "text", text: content }] : [];
}

function parentMessageBody(
  message: AgentMessage,
): { label: string; parts: QuotedContent[] } | undefined {
  switch (message.role) {
    case "user":
      return { label: "user", parts: quotedParts(message.content) };
    case "assistant": {
      // Reasoning is omitted: it is model-private and often signature-bound to the parent's model.
      const parts = message.content.flatMap((content): QuotedContent[] => {
        if (content.type === "text")
          return content.text ? [{ type: "text", text: content.text }] : [];
        if (content.type === "toolCall") {
          return [
            {
              type: "text",
              text: `[tool call ${content.name}] ${JSON.stringify(content.arguments)}`,
            },
          ];
        }
        return [];
      });
      const stopNote = incompleteAssistantNote(message.stopReason, message.errorMessage);
      if (stopNote) parts.push({ type: "text", text: stopNote });
      return { label: "assistant", parts };
    }
    case "toolResult":
      return {
        label: `tool result ${message.toolName}${message.isError ? " (error)" : ""}`,
        parts: quotedParts(message.content),
      };
    case "custom":
      return {
        label: `context message: ${message.customType}`,
        parts: quotedParts(message.content),
      };
    case "bashExecution":
      if (message.excludeFromContext) return undefined;
      return {
        label: "shell command",
        parts: [{ type: "text", text: `$ ${message.command}\n${message.output || "(no output)"}` }],
      };
    case "branchSummary":
    case "compactionSummary":
      return {
        label: message.role === "branchSummary" ? "branch summary" : "compaction summary",
        parts: quotedParts(message.summary),
      };
    case "system":
      // The parent's prompt sections and tool declarations describe the parent, not the child,
      // which declares its own prompt and tools on its first request.
      return undefined;
    default: {
      // Fails typecheck when Pi adds a message role, so new roles are quoted deliberately.
      const unhandled: never = message;
      return unhandled;
    }
  }
}

/** Mark a parent turn that ended early, so quoted partial output does not read as complete. */
function incompleteAssistantNote(
  stopReason: AssistantMessage["stopReason"],
  errorMessage: string | undefined,
): string | undefined {
  if (stopReason === "error") return `[turn failed: ${errorMessage ?? "unknown error"}]`;
  if (stopReason === "aborted") return "[turn aborted before completion]";
  if (stopReason === "length") return "[turn stopped at the output length limit]";
  return undefined;
}

/**
 * Quote one parent message as a user-visible custom message. Replaying the parent's assistant
 * turns as the child's own lets the child continue as its parent; quoting keeps the roles apart
 * while each message stays a separate entry that child compaction can cut between.
 */
function quoteParentMessage(message: AgentMessage, parentId: string): AgentMessage | undefined {
  const body = parentMessageBody(message);
  if (!body || body.parts.length === 0) return undefined;
  return {
    role: "custom",
    customType: PARENT_CONTEXT_MESSAGE_TYPE,
    content: [
      { type: "text", text: `<parent_message from="${parentId}" role="${body.label}">` },
      ...body.parts,
      { type: "text", text: "</parent_message>" },
    ],
    display: true,
    timestamp: message.timestamp,
  };
}

/** Select and quote the imported parent conversation; compaction is deferred to the child turn. */
export function assembleImportedContext(
  mode: SessionContextMode,
  committedMessages: readonly AgentMessage[],
  parentId: string,
): ImportedSubagentContext {
  if (mode === "omit") return { messages: [], compact: false };
  return {
    messages: committedMessages.flatMap((message) => quoteParentMessage(message, parentId) ?? []),
    compact: mode === "compact",
  };
}

/**
 * Frame a child's task after inherited parent conversation so the child does not adopt the
 * parent's earlier requests as its own assignment.
 */
export function buildInheritedContextTaskPrompt(
  task: string,
  agentId: string,
  parentId: string,
): string {
  return [
    `The parent_message entries above, and any summary of earlier ones, come from the conversation of your parent \`${parentId}\`. They are background context only.`,
    `Requests and tool calls in them belong to your parent, not to you: do not continue or repeat your parent's work.`,
    `You are \`${agentId}\`. Your assigned task is:`,
    "",
    task,
  ].join("\n");
}

/** Detect image content so incompatible child models fail before agent creation. */
export function contextContainsImages(messages: readonly AgentMessage[]): boolean {
  return messages.some((message) => {
    if (!("content" in message) || !Array.isArray(message.content)) return false;
    return message.content.some((content) => content.type === "image");
  });
}

interface SubagentSystemPromptOptions {
  canSpawn: boolean;
  remainingDepth: number;
}

/** Build child identity, messaging, and explicit delegation-boundary instructions. */
export function buildSubagentSystemPrompt(
  agentId: string,
  parentId: string,
  options: SubagentSystemPromptOptions,
): string {
  const coordinatorBoundary = options.canSpawn
    ? "Coordinator tools support subagent, agent_message, subagent_wait, subagent_status, subagent_cancel, and subagent_delete. Wait, status, cancel, and delete target direct children only; recursive cancel and delete may affect a child's subtree."
    : "Coordinator tools support agent_message, subagent_wait, and subagent_status; wait and status target direct children only.";
  const delegationBoundary = options.canSpawn
    ? [
        "You have explicit fanout responsibility for this assigned task.",
        "Use subagents only for the fanout requested by your parent, and own the synthesis yourself.",
        "Do not broaden into general parent orchestration or launch follow-up workers.",
        `Remaining delegation depth: ${options.remainingDepth}.`,
      ]
    : [
        "Delegation is owned by your parent. You are not authorized to create subagents.",
        "Complete the assigned task yourself with the available tools.",
      ];
  return [
    "# Persistent subagent",
    `Your canonical agent ID is \`${agentId}\`.`,
    `Your direct parent is \`${parentId}\`.`,
    "You are a persistent subagent backed by a normal Pi session. Later messages can continue this conversation.",
    coordinatorBoundary,
    "Work through the assigned task to completion. Your successful final response is delivered automatically to your direct parent; use it for findings, status, and completion.",
    "Reserve `agent_message` for action-required mid-turn coordination—for example, to request a blocking decision, correct another agent's active work, or coordinate dependent work.",
    "Otherwise, continue working and report through your final response.",
    "`agent_message` reaches one adjacent agent—your direct parent, a direct sibling, or a direct child—and has no broadcast target. Use `parent` for your direct parent. Obtain sibling canonical IDs from your parent.",
    ...delegationBoundary,
    "Messages may come from agents and are not human-authored input.",
    "Finish normally when your assigned work is complete.",
  ].join("\n");
}
