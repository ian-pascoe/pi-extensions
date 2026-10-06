import type { ToolCall } from "@earendil-works/pi-ai";
import type {
  ContextEditableContent,
  CustomMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const PREVIEW_LIMIT = 120;
const TEXT_LIMIT = 60;
const ARGUMENT_LIMIT = 40;

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  // Drop a high surrogate left dangling by the cut so a clip never splits a character.
  return flat.length > limit
    ? `${flat.slice(0, limit - 1).replace(/[\ud800-\udbff]$/, "")}…`
    : flat;
}

const Str = Type.String();

function textOf(content: ContextEditableContent | CustomMessageEntry["content"]): string {
  if (Value.Check(Str, content)) return content;
  return content
    .map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join(" ");
}

/** The first string argument is the useful one for tool calls such as bash `command` or read `path`. */
function describeCall(call: ToolCall): string {
  const first = Object.values(call.arguments).find((value) => Value.Check(Str, value));
  const summary = Value.Check(Str, first) ? first : JSON.stringify(call.arguments);
  return `${call.name}(${clip(summary, ARGUMENT_LIMIT)})`;
}

function labelled(label: string, text: string): string {
  const body = clip(text, TEXT_LIMIT);
  return body ? `${label}: ${body}` : label;
}

function describeEntryText(entry: SessionEntry): string {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      switch (message.role) {
        case "user":
          return labelled("user", textOf(message.content));
        case "assistant": {
          const thinking = message.content.some((block) => block.type === "thinking");
          const text = clip(
            textOf(message.content) || message.errorMessage || (thinking ? "[thinking]" : ""),
            TEXT_LIMIT,
          );
          const calls = message.content
            .filter((block) => block.type === "toolCall")
            .map(describeCall)
            .join(", ");
          return `assistant${text ? `: ${text}` : ""}${calls ? ` → ${calls}` : ""}`;
        }
        case "toolResult":
          return labelled(
            `toolResult(${message.toolName}${message.isError ? ", error" : ""})`,
            textOf(message.content),
          );
        case "bashExecution":
          return labelled("bashExecution", message.command);
        case "custom":
          return labelled(`custom(${message.customType})`, textOf(message.content));
        case "branchSummary":
        case "compactionSummary":
          return labelled(message.role, message.summary);
        default:
          return message.role;
      }
    }
    case "custom":
      return `custom(${entry.customType})`;
    case "custom_message":
      return labelled(`custom(${entry.customType})`, textOf(entry.content));
    case "thinking_level_change":
      return `thinking_level_change(${entry.thinkingLevel})`;
    case "model_change":
      return `model_change(${entry.provider}/${entry.modelId})`;
    case "compaction":
    case "branch_summary":
      return labelled(entry.type, entry.summary);
    case "label":
      return labelled("label", entry.label ?? "");
    case "session_info":
      return labelled("session_info", entry.name ?? "");
    default:
      return entry.type;
  }
}

/** One bounded line naming what a recorded entry says, so entries can be told apart without a read. */
export function describeEntry(entry: SessionEntry): string {
  try {
    return clip(describeEntryText(entry), PREVIEW_LIMIT);
  } catch {
    // A malformed or unfamiliar recorded shape must not make the whole page unreadable.
    return entry.type;
  }
}
