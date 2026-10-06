import { createHash } from "node:crypto";
import type {
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

/**
 * Review Evidence: the observed model's view of its context, without what Pi stores only for
 * replay or display (signatures, `details`, provider/response metadata, native IDs).
 */
export type EvidenceBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  /** Reasoning the provider withheld; the observed model saw only an opaque payload. */
  | { type: "thinking"; redacted: true }
  | { type: "image"; attachment: number }
  | { type: "toolCall"; ref: string; name: string; arguments: ToolCall["arguments"] };
export type EvidenceMessage =
  | { role: "user"; content: string | EvidenceBlock[] }
  | {
      role: "assistant";
      content: EvidenceBlock[];
      /** Present only for responses that did not finish normally. */
      stopReason?: "error" | "aborted" | "length";
      errorMessage?: string;
    }
  | {
      role: "toolResult";
      ref: string;
      toolName: string;
      isError: boolean;
      content: EvidenceBlock[];
    };
export interface Evidence {
  messages: EvidenceMessage[];
  /** Native image attachments, referenced 1-based by `{ type: "image", attachment }` blocks. */
  images: ImageContent[];
}
/** Observed Setup: the observed system prompt and tool summaries that open a Context Seed. */
export interface ObservedSetup {
  systemPrompt: string | undefined;
  tools: { name: string; summary: string }[];
}

/**
 * Tool-Call Reference: compact, shared by an observed tool call and its result. Derived from
 * the native call ID alone, so it is stable across projections and Advisor Sessions and can
 * be recomputed from the observed transcript.
 */
export function toolCallRef(toolCallId: string): string {
  // Coerce rather than trust the stored shape: a malformed ID must not pause the Advisor.
  return createHash("sha256").update(String(toolCallId)).digest("base64url").slice(0, 8);
}

const summaryLimit = 160;

/** First sentence of a tool description's first line, bounded for the Observed Setup. */
function toolSummary(description: string): string {
  const line = description.trim().split("\n", 1)[0]?.trim() ?? "";
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > summaryLimit
    ? `${sentence.slice(0, summaryLimit - 1).trimEnd()}…`
    : sentence;
}

export function projectObservedSetup(
  context: Pick<Context, "systemPrompt" | "tools">,
): ObservedSetup {
  return {
    systemPrompt: context.systemPrompt,
    tools: (context.tools ?? []).map((tool: Tool) => ({
      name: tool.name,
      summary: toolSummary(tool.description),
    })),
  };
}

/** A Context Seed before projection: the native messages it keeps and how many it omits. */
export interface ContextSeed {
  observedSetup: ObservedSetup;
  messages: Message[];
  /** Messages between the original request and the newest kept messages that did not fit. */
  omitted: number;
}

/**
 * Fit a Context Seed to a token budget, estimated with Pi's compaction heuristic. The Observed
 * Setup and the original request are always kept: the first user message, or after compaction
 * the summary (which carries the earlier goal) and the first user message after it. The rest of
 * the budget takes the newest whole turns, so a tool call is never separated from its result.
 */
export function selectContextSeed(
  context: Pick<Context, "systemPrompt" | "tools" | "messages">,
  options: { budgetTokens: number; compacted?: boolean },
): ContextSeed {
  const { messages } = context;
  const observedSetup = projectObservedSetup(context);
  const anchors = new Set(
    messages
      .flatMap((message, index) => (message.role === "user" ? [index] : []))
      .slice(0, options.compacted ? 2 : 1),
  );
  let remaining =
    options.budgetTokens -
    estimateTokens({ role: "user", content: JSON.stringify(observedSetup), timestamp: 0 }) -
    messages.reduce(
      (total, message, index) => (anchors.has(index) ? total + estimateTokens(message) : total),
      0,
    );
  const kept = new Set(anchors);
  // Walk back one unit at a time: a user message, or an assistant message and its results.
  let end = messages.length;
  for (let start = end - 1; start >= 0; start--) {
    if (messages[start]?.role === "toolResult") continue;
    const unit = messages.slice(start, end);
    const cost = unit.reduce(
      (total, message, offset) =>
        anchors.has(start + offset) ? total : total + estimateTokens(message),
      0,
    );
    if (cost > remaining) break;
    remaining -= cost;
    for (let index = start; index < end; index++) kept.add(index);
    end = start;
  }
  return {
    observedSetup,
    messages: messages.filter((_message, index) => kept.has(index)),
    omitted: messages.length - kept.size,
  };
}

/** Project observed messages in order; attachment indexes restart at 1 for each projection. */
export function projectEvidence(messages: readonly Message[]): Evidence {
  const images: ImageContent[] = [];
  /** User and tool-result content; unknown future block types are omitted, not forwarded. */
  const media = (blocks: readonly (TextContent | ImageContent)[]) =>
    blocks.flatMap((block): EvidenceBlock[] => {
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "image") {
        images.push(block);
        return [{ type: "image", attachment: images.length }];
      }
      return [];
    });
  const projected = messages.flatMap((message): EvidenceMessage[] => {
    switch (message.role) {
      case "user":
        return [
          {
            role: "user",
            content: Array.isArray(message.content) ? media(message.content) : message.content,
          },
        ];
      case "toolResult":
        return [
          {
            role: "toolResult",
            ref: toolCallRef(message.toolCallId),
            toolName: message.toolName,
            isError: message.isError,
            content: media(message.content),
          },
        ];
      case "assistant": {
        const content = message.content.flatMap((block): EvidenceBlock[] => {
          if (block.type === "text") return [{ type: "text", text: block.text }];
          if (block.type === "thinking") {
            if (block.redacted) return [{ type: "thinking", redacted: true }];
            return block.thinking.trim() ? [{ type: "thinking", thinking: block.thinking }] : [];
          }
          if (block.type === "toolCall")
            return [
              {
                type: "toolCall",
                ref: toolCallRef(block.id),
                name: block.name,
                arguments: block.arguments,
              },
            ];
          return [];
        });
        const stop = message.stopReason;
        if (stop !== "error" && stop !== "aborted" && stop !== "length")
          return [{ role: "assistant", content }];
        const abnormal: EvidenceMessage = { role: "assistant", content, stopReason: stop };
        if (message.errorMessage) abnormal.errorMessage = message.errorMessage;
        return [abnormal];
      }
      default:
        // System messages reach the Advisor through the Observed Setup; unknown roles are omitted.
        return [];
    }
  });
  return { messages: projected, images };
}
