import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import type {
  ChildAgentTranscriptSnapshot,
  RecentAgentActivity,
  SessionContextMode,
} from "./minimal-subagents-types.js";

const RECENT_AGENT_ACTIVITY_LIMIT = 12;
const CHILD_AGENT_TRANSCRIPT_MESSAGE_LIMIT = 24;
const CHILD_AGENT_TRANSCRIPT_PAIR_WINDOW = CHILD_AGENT_TRANSCRIPT_MESSAGE_LIMIT * 2;
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

function omitAgentMessageImages(message: AgentMessage): AgentMessage {
  if (message.role === "user" || message.role === "custom") {
    return {
      ...structuredClone(message),
      content: Array.isArray(message.content)
        ? message.content
            .filter((content) => content.type !== "image")
            .map((content) => structuredClone(content))
        : message.content,
    };
  }
  if (message.role === "toolResult") {
    return {
      ...structuredClone(message),
      content: message.content
        .filter((content) => content.type !== "image")
        .map((content) => structuredClone(content)),
    };
  }
  return structuredClone(message);
}

interface IndexedTranscriptMessage {
  message: AgentMessage;
  originalIndex: number;
  streaming: boolean;
}

/** Select at most 48 recent raw messages, retaining cross-cutoff tool pairs and omitting images. */
export function selectChildAgentTranscript(
  messages: readonly AgentMessage[],
  streamingAssistantMessage?: AgentMessage,
): ChildAgentTranscriptSnapshot {
  const pairWindow = messages.slice(-CHILD_AGENT_TRANSCRIPT_PAIR_WINDOW);
  const firstWindowIndex = messages.length - pairWindow.length;
  const indexed: IndexedTranscriptMessage[] = [
    ...pairWindow.map((message, windowIndex) => ({
      message,
      originalIndex: firstWindowIndex + windowIndex,
      streaming: false,
    })),
    ...(streamingAssistantMessage
      ? [
          {
            message: streamingAssistantMessage,
            originalIndex: messages.length,
            streaming: true,
          },
        ]
      : []),
  ];
  const tail = indexed.slice(-CHILD_AGENT_TRANSCRIPT_MESSAGE_LIMIT).map((item) => ({
    ...item,
    message: omitAgentMessageImages(item.message),
  }));
  const selectedIndexes = new Set(tail.map(({ originalIndex }) => originalIndex));
  const calls = new Map<
    string,
    { originalIndex: number; assistant: Extract<AgentMessage, { role: "assistant" }> }
  >();
  for (const item of indexed) {
    if (item.message.role !== "assistant") continue;
    for (const content of item.message.content) {
      if (content.type === "toolCall") {
        calls.set(content.id, { originalIndex: item.originalIndex, assistant: item.message });
      }
    }
  }

  const retained = tail.filter(
    (item) => item.message.role !== "toolResult" || calls.has(item.message.toolCallId),
  );
  const missingCalls = new Map<
    number,
    { assistant: Extract<AgentMessage, { role: "assistant" }>; callIds: Set<string> }
  >();
  for (const item of retained) {
    if (item.message.role !== "toolResult") continue;
    const call = calls.get(item.message.toolCallId);
    if (!call || selectedIndexes.has(call.originalIndex)) continue;
    const missing = missingCalls.get(call.originalIndex) ?? {
      assistant: call.assistant,
      callIds: new Set<string>(),
    };
    missing.callIds.add(item.message.toolCallId);
    missingCalls.set(call.originalIndex, missing);
  }
  const prefixes: IndexedTranscriptMessage[] = [...missingCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([originalIndex, missing]) => ({
      message: {
        ...structuredClone(missing.assistant),
        content: missing.assistant.content
          .filter((content) => content.type === "toolCall" && missing.callIds.has(content.id))
          .map((content) => structuredClone(content)),
      },
      originalIndex,
      streaming: false,
    }));
  const selected = [...prefixes, ...retained];
  const streamingAssistantIndex = selected.findIndex(({ streaming }) => streaming);
  return {
    messages: selected.map(({ message }) => message),
    streamingAssistantIndex: streamingAssistantIndex >= 0 ? streamingAssistantIndex : undefined,
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

/** Carries the selected caller messages and whether child preparation should compact them. */
export interface ImportedSubagentContext {
  messages: AgentMessage[];
  compact: boolean;
}

/** Select the imported message snapshot and defer expensive compact preparation to the child turn. */
export function assembleImportedContext(
  mode: SessionContextMode,
  committedMessages: AgentMessage[],
): ImportedSubagentContext {
  if (mode === "omit") return { messages: [], compact: false };
  return { messages: committedMessages, compact: mode === "compact" };
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
