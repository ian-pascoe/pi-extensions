import { createHash } from "node:crypto";
import type { Context, ImageContent, Message, Tool, ToolCall } from "@earendil-works/pi-ai";

/**
 * Review evidence: the observed model's view of its context, without what Pi stores only for
 * replay or display (signatures, `details`, provider/response metadata, per-message IDs).
 */
export type EvidenceBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; attachment: number }
  | { type: "toolCall"; ref: string; name: string; arguments: ToolCall["arguments"] };
export type EvidenceMessage =
  | { role: "user"; content: string | EvidenceBlock[] }
  | {
      role: "assistant";
      content: EvidenceBlock[];
      /** Present only for turns the observed model never received back. */
      stopReason?: "error" | "aborted";
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
/** Observed system prompt and tools, introduced once per Advisor Session. */
export interface ContextSeed {
  systemPrompt: string | undefined;
  tools: { name: string; summary: string }[];
}

/**
 * Compact reference to an observed tool call, shared by the call and its result. It is
 * derived from the native call ID alone, so it is stable across projections and Advisor
 * Sessions and can be recomputed from the observed transcript.
 */
export function toolCallRef(toolCallId: string): string {
  return createHash("sha256").update(toolCallId).digest("base64url").slice(0, 8);
}

const summaryLimit = 160;

/** First sentence of a tool description's first line, bounded for the context seed. */
function toolSummary(description: string): string {
  const line = description.trim().split("\n", 1)[0]?.trim() ?? "";
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > summaryLimit
    ? `${sentence.slice(0, summaryLimit - 1).trimEnd()}…`
    : sentence;
}

export function projectContextSeed(context: Pick<Context, "systemPrompt" | "tools">): ContextSeed {
  return {
    systemPrompt: context.systemPrompt,
    tools: (context.tools ?? []).map((tool: Tool) => ({
      name: tool.name,
      summary: toolSummary(tool.description),
    })),
  };
}

/** Project observed messages in order; attachment indexes restart at 1 for each projection. */
export function projectEvidence(messages: readonly Message[]): Evidence {
  const images: ImageContent[] = [];
  const attach = (image: ImageContent): EvidenceBlock => {
    images.push(image);
    return { type: "image", attachment: images.length };
  };
  const projected = messages.flatMap((message): EvidenceMessage[] => {
    switch (message.role) {
      case "system":
        // Prompt and tool changes reach the Advisor through the context seed.
        return [];
      case "user":
        return [
          {
            role: "user",
            content: Array.isArray(message.content)
              ? message.content.map((block) =>
                  block.type === "image" ? attach(block) : { type: "text", text: block.text },
                )
              : message.content,
          },
        ];
      case "toolResult":
        return [
          {
            role: "toolResult",
            ref: toolCallRef(message.toolCallId),
            toolName: message.toolName,
            isError: message.isError,
            content: message.content.map((block) =>
              block.type === "image" ? attach(block) : { type: "text", text: block.text },
            ),
          },
        ];
      case "assistant": {
        const content = message.content.flatMap((block): EvidenceBlock[] => {
          if (block.type === "text") return [{ type: "text", text: block.text }];
          if (block.type === "thinking")
            return block.thinking.trim() ? [{ type: "thinking", thinking: block.thinking }] : [];
          return [
            {
              type: "toolCall",
              ref: toolCallRef(block.id),
              name: block.name,
              arguments: block.arguments,
            },
          ];
        });
        if (message.stopReason !== "error" && message.stopReason !== "aborted")
          return [{ role: "assistant", content }];
        const failed: EvidenceMessage = {
          role: "assistant",
          content,
          stopReason: message.stopReason,
        };
        if (message.errorMessage) failed.errorMessage = message.errorMessage;
        return [failed];
      }
    }
  });
  return { messages: projected, images };
}
