import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export type PiSessionMessage = { id: string; role: "user" | "assistant"; text: string };

const extractUserText = (content: string | (TextContent | ImageContent)[]) => {
  if (!Array.isArray(content)) return content;
  return content
    .flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text.trim()] : []))
    .join("\n");
};

const extractAssistantText = (content: (TextContent | ThinkingContent | ToolCall)[]) => {
  return content
    .flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text.trim()] : []))
    .join("\n");
};

/** Extracts user and assistant text from the Pi-owned session-entry protocol. */
export const extractPiSessionMessages = (entries: readonly SessionEntry[]): PiSessionMessage[] => {
  return entries.flatMap<PiSessionMessage>((entry) => {
    if (entry.type !== "message") return [];

    const { message } = entry;
    if (message.role === "user") {
      return [{ id: entry.id, role: message.role, text: extractUserText(message.content) }];
    }
    if (message.role === "assistant") {
      return [{ id: entry.id, role: message.role, text: extractAssistantText(message.content) }];
    }
    return [];
  });
};

export const formatMessage = (message: PiSessionMessage) => {
  const text = message.text.trim();
  if (!text) return "";
  return `[${message.role}]: ${text}`;
};

export const formatMessages = (messages: readonly PiSessionMessage[]) => {
  return messages.map(formatMessage).filter(Boolean).join("\n\n");
};

export const turnKey = (messages: readonly PiSessionMessage[]) => {
  return messages.map((message) => message.id).join(":");
};

export const selectMessagesInTurn = (messages: readonly PiSessionMessage[]) => {
  const latestUserMessageIndex = messages.findLastIndex((message) => message.role === "user");
  return messages.slice(latestUserMessageIndex === -1 ? 0 : latestUserMessageIndex);
};

export const selectMessagesForRecall = (
  messages: readonly PiSessionMessage[],
  options: { maxRecallTurns: number; maxRecallChars: number },
) => {
  const selected: PiSessionMessage[] = [];
  let userTurns = 0;
  let charCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const formatted = formatMessage(message);
    if (!formatted) continue;

    const separatorLength = selected.length === 0 ? 0 : 2;
    const nextCharCount = charCount + separatorLength + formatted.length;
    if (selected.length > 0 && nextCharCount > options.maxRecallChars) break;

    selected.unshift(message);
    charCount = nextCharCount;

    if (message.role === "user") {
      userTurns++;
      if (userTurns >= options.maxRecallTurns) break;
    }
  }

  return selected;
};
