import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ImageContent, Message, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Evidence: the observed model's view of its context, without what Pi stores only for
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
/**
 * Tool-Call Reference: compact, shared by an observed tool call and its result. Derived from
 * the native call ID alone, so it is stable across projections and reviewer sessions and can
 * be recomputed from the observed transcript.
 */
export function toolCallRef(toolCallId: string): string {
  // Coerce rather than trust the stored shape: a malformed ID must not interrupt the consumer.
  return createHash("sha256").update(String(toolCallId)).digest("base64url").slice(0, 8);
}

/** Every Tool-Call Reference in projected evidence, from calls and their results. */
export function evidenceRefs(messages: readonly EvidenceMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "toolResult") return [message.ref];
    if (message.role !== "assistant") return [];
    return message.content.flatMap((block) => (block.type === "toolCall" ? [block.ref] : []));
  });
}

/**
 * Each observed message's role before Pi converted it for the model. Compaction and branch
 * summaries, custom messages (including findings delivered back to the observed agent), and `!` command results all
 * reach the model as `user` messages; only `user` origins are requests from the user.
 */
export function messageOrigins(
  messages: readonly Message[],
  sources: AgentSession["messages"],
): string[] {
  // Sources that reach the model as user messages, in order, grouped by timestamp.
  const byTime = Map.groupBy(
    sources.flatMap((source) => {
      const [converted] = convertToLlm([source]);
      return converted?.role === "user" ? [{ source, content: converted.content }] : [];
    }),
    ({ source }) => source.timestamp,
  );
  const used = new Set<object>();
  const origins = messages.map((message): string | undefined =>
    message.role === "user" ? undefined : message.role,
  );
  const claim = (index: number, matches: (content: Message["content"]) => boolean) => {
    const message = messages[index];
    if (message?.role !== "user" || origins[index]) return;
    const match = byTime
      .get(message.timestamp)
      ?.find(({ source, content }) => !used.has(source) && matches(content));
    if (!match) return;
    used.add(match.source);
    origins[index] = match.source.role;
  };
  // Exact conversions first; then, within a timestamp, the k-th unmatched message pairs with the
  // k-th unused source (a message a context hook rewrote, such as with images removed).
  for (const [index, message] of messages.entries())
    claim(index, (content) => isDeepStrictEqual(content, message.content));
  for (const index of messages.keys()) claim(index, () => true);
  return origins.map((origin) => origin ?? "unknown");
}

// Pi's compaction estimate for one image, plus a token for a longer attachment index.
const imageTokens =
  estimateTokens({
    role: "user",
    content: [{ type: "image", data: "", mimeType: "image/png" }],
    timestamp: 0,
  }) + 1;

/** Pi's chars/4 estimate of projected evidence messages, plus Pi's per-image estimate. */
export function evidenceTokens({ messages, images }: Evidence): number {
  return Math.ceil(JSON.stringify(messages).length / 4) + images.length * imageTokens;
}

/** One projected message with the native images its attachment blocks reference. */
export interface EvidenceItem {
  message: EvidenceMessage;
  images: ImageContent[];
}

/** Builds the text that replaces what `shortenEvidence` cut, given the number of omitted characters. */
export type OmissionMarker = (omitted: number) => string;

/** Tokens evidence items add to a serialized evidence list, by Pi's chars/4 heuristic. */
export function evidenceItemsCost(items: readonly EvidenceItem[]): number {
  return items.reduce(
    (total, { message, images }) =>
      total + Math.ceil((JSON.stringify(message).length + 1) / 4) + images.length * imageTokens,
    0,
  );
}

/**
 * Shorten every text (and serialized tool-call arguments) longer than `limit` characters,
 * appending `marker(omitted)`. Items that do not change keep their identity.
 */
export function shortenEvidence(
  items: readonly EvidenceItem[],
  limit: number,
  marker: OmissionMarker,
): EvidenceItem[] {
  return items.map((item) => {
    let changed = false;
    const cut = (text: string) => {
      const shortened = `${text.slice(0, limit)}\n${marker(text.length - limit)}`;
      if (shortened.length >= text.length) return text;
      changed = true;
      return shortened;
    };
    const block = (part: EvidenceBlock): EvidenceBlock => {
      if (part.type === "text") return { type: "text", text: cut(part.text) };
      if (part.type === "thinking" && "thinking" in part)
        return { type: "thinking", thinking: cut(part.thinking) };
      if (part.type !== "toolCall") return part;
      const json = JSON.stringify(part.arguments);
      const shortened = cut(json);
      // Oversized arguments become their marked JSON prefix, which no longer parses.
      return shortened === json ? part : { ...part, arguments: { shortenedJson: shortened } };
    };
    const { message } = item;
    const next: EvidenceMessage =
      message.role === "user"
        ? {
            role: "user",
            content: Array.isArray(message.content)
              ? message.content.map(block)
              : cut(message.content),
          }
        : { ...message, content: message.content.map(block) };
    return changed ? { message: next, images: item.images } : item;
  });
}

/**
 * The items unchanged if they cost at most `allowance` tokens, else shortened with the longest
 * per-string limit that fits; `undefined` when even fully shortened they do not fit.
 */
export function fitEvidence(
  items: readonly EvidenceItem[],
  allowance: number,
  marker: OmissionMarker,
): EvidenceItem[] | undefined {
  if (evidenceItemsCost(items) <= allowance) return [...items];
  let low = 0;
  let high = JSON.stringify(items.map(({ message }) => message)).length;
  if (evidenceItemsCost(shortenEvidence(items, low, marker)) > allowance) return undefined;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (evidenceItemsCost(shortenEvidence(items, middle, marker)) <= allowance) low = middle;
    else high = middle - 1;
  }
  return shortenEvidence(items, low, marker);
}

/** Join individually projected messages, renumbering their image attachments. */
export function combineEvidence(items: readonly EvidenceItem[]): Evidence {
  const images: ImageContent[] = [];
  const messages = items.map(({ message, images: own }) => {
    const offset = images.length;
    images.push(...own);
    if (!offset || !own.length || !Array.isArray(message.content)) return message;
    const content = message.content.map((block) =>
      block.type === "image" ? { ...block, attachment: block.attachment + offset } : block,
    );
    return { ...message, content };
  });
  return { messages, images };
}

/** Opt-in cap on tool-result text; projection without one never shortens any text. */
export interface ToolResultCap {
  /** Longest tool-result text kept whole, in characters; longer text keeps its head and tail. */
  limit: number;
  /** Builds the text that replaces the omitted middle, given the number of omitted characters. */
  marker: OmissionMarker;
}

/** Options for projecting evidence; every option is opt-in. */
export interface ProjectionOptions {
  /** Cap each tool result's text, so oversized results keep a head, a tail, and a marker. */
  toolResultCap?: ToolResultCap | undefined;
}

/**
 * `text` unchanged if it is within `cap.limit` characters or capping would not shorten it, else
 * its head and tail (about half the limit each) around `cap.marker(omitted)`. Pure, so equal
 * input always gives equal output; a cut never splits a surrogate pair.
 */
export function capText(text: string, cap: ToolResultCap): string {
  if (text.length <= cap.limit) return text;
  let head = Math.ceil(cap.limit / 2);
  let tail = text.length - (cap.limit - head);
  const high = (index: number) => {
    const code = text.charCodeAt(index);
    return code >= 0xd800 && code <= 0xdbff;
  };
  const low = (index: number) => {
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  if (head > 0 && high(head - 1)) head--;
  if (tail < text.length && low(tail)) tail++;
  const capped = `${text.slice(0, head)}\n${cap.marker(tail - head)}\n${text.slice(tail)}`;
  return capped.length >= text.length ? text : capped;
}

/**
 * Project observed messages in order; attachment indexes restart at 1 for each projection.
 * Without `options.toolResultCap`, text is never shortened.
 */
export function projectEvidence(
  messages: readonly Message[],
  options: ProjectionOptions = {},
): Evidence {
  const images: ImageContent[] = [];
  const { toolResultCap } = options;
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
            content: media(message.content).map((block) =>
              toolResultCap && block.type === "text"
                ? { type: "text", text: capText(block.text, toolResultCap) }
                : block,
            ),
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
        // System messages reach the consumer through its own setup summary; unknown roles are omitted.
        return [];
    }
  });
  return { messages: projected, images };
}

/** Project one observed message; `undefined` when its role is omitted from evidence. */
export function projectEvidenceItem(
  message: Message,
  options?: ProjectionOptions,
): EvidenceItem | undefined {
  const {
    messages: [only],
    images,
  } = projectEvidence([message], options);
  return only ? { message: only, images } : undefined;
}
