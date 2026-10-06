import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Context,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";

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

/** Every Tool-Call Reference in projected Review Evidence, from calls and their results. */
export function evidenceRefs(messages: readonly EvidenceMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "toolResult") return [message.ref];
    if (message.role !== "assistant") return [];
    return message.content.flatMap((block) => (block.type === "toolCall" ? [block.ref] : []));
  });
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

/**
 * Each observed message's role before Pi converted it for the model. Compaction and branch
 * summaries, custom messages (including delivered Advisor findings), and `!` command results all
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

/** A Context Seed: the Observed Setup and the observed messages that fit its token budget. */
export interface ContextSeed extends Evidence {
  observedSetup: ObservedSetup;
  /** Zero-based positions of the kept observed messages, ascending. */
  kept: number[];
  /** Long texts shortened, with a marker, so the newest messages fit. */
  shortened: number;
}

interface Projected {
  message: EvidenceMessage;
  images: ImageContent[];
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

/** Tokens a projected message adds to the seed JSON, by Pi's chars/4 heuristic. */
function cost(items: readonly Projected[]): number {
  return items.reduce(
    (total, { message, images }) =>
      total + Math.ceil((JSON.stringify(message).length + 1) / 4) + images.length * imageTokens,
    0,
  );
}

/** Shorten every text longer than `limit` characters, marking how much was cut. */
function shorten(items: readonly Projected[], limit: number): Projected[] {
  return items.map((item) => {
    let changed = false;
    const cut = (text: string) => {
      const shortened = `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted from the Context Seed]`;
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

/** The unit unchanged if it fits, else with the longest per-string limit that fits. */
function fit(items: readonly Projected[], allowance: number): Projected[] | undefined {
  if (cost(items) <= allowance) return [...items];
  let low = 0;
  let high = JSON.stringify(items.map(({ message }) => message)).length;
  if (cost(shorten(items, low)) > allowance) return undefined;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (cost(shorten(items, middle)) <= allowance) low = middle;
    else high = middle - 1;
  }
  return shorten(items, low);
}

/**
 * Fit a Context Seed to a token budget, measured as Pi's chars/4 estimate of the seed JSON with
 * Pi's per-image estimate. Always kept: the Observed Setup; the original request (the first
 * user request, or after compaction the summary, which carries the earlier goal, and the first
 * request after it); and the newest turn with the request that prompted it, shortened if they
 * alone exceed the budget. The rest takes the newest turns that fit, shortening only the oldest
 * one included. A turn (an assistant message with its tool results) is never split.
 */
export function selectContextSeed(
  context: Pick<Context, "systemPrompt" | "tools" | "messages">,
  options: { budgetTokens: number; origins?: readonly string[] },
): ContextSeed {
  const { messages } = context;
  const observedSetup = projectObservedSetup(context);
  const projected = messages.map((message): Projected[] => {
    const {
      messages: [only],
      images,
    } = projectEvidence([message]);
    return only ? [{ message: only, images }] : [];
  });
  // Fall back to the converted role only when no converted user message has a known origin.
  const origins = options.origins?.some(
    (origin, index) => messages[index]?.role === "user" && origin !== "unknown",
  )
    ? options.origins
    : undefined;
  const isRequest = (index: number) =>
    origins ? origins[index] === "user" : messages[index]?.role === "user";
  // Units: a message, with any tool results that follow it.
  const starts = messages.flatMap((message, index) =>
    index === 0 || message.role !== "toolResult" ? [index] : [],
  );
  const units = starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? messages.length,
  }));
  const unitAt = (position: number) => units.findLastIndex((unit) => unit.start <= position);
  const content = (unit: number) => {
    const { start, end } = units[unit] ?? { start: 0, end: 0 };
    return projected.slice(start, end).flat();
  };
  const summary = options.origins?.indexOf("compactionSummary") ?? -1;
  const request = messages.findIndex((_message, index) => index > summary && isRequest(index));
  const newest = units.length - 1;
  const prompt = messages.findLastIndex(
    (_message, index) => index <= (units[newest]?.start ?? -1) && isRequest(index),
  );
  const anchors = new Set([summary, request].filter((index) => index >= 0).map(unitAt));
  const recent = new Set([prompt, messages.length - 1].filter((index) => index >= 0).map(unitAt));
  for (const unit of anchors) recent.delete(unit);

  const chosen = new Map<number, Projected[]>();
  let remaining =
    options.budgetTokens - Math.ceil(JSON.stringify({ observedSetup, messages: [] }).length / 4);
  const anchorItems = [...anchors].flatMap(content);
  const recentItems = [...recent].flatMap(content);
  // Shorten the newest turn first, then the original request too, so both always appear.
  const required =
    fit(recentItems, remaining - cost(anchorItems))?.concat(anchorItems) ??
    fit([...recentItems, ...anchorItems], remaining) ??
    shorten([...recentItems, ...anchorItems], 0);
  remaining -= cost(required);
  const shortenedRequired = new Map(
    [...recentItems, ...anchorItems].map((item, index) => [item, required[index]] as const),
  );
  for (const unit of [...anchors, ...recent])
    chosen.set(
      unit,
      content(unit).map((item) => shortenedRequired.get(item) ?? item),
    );
  for (let unit = newest; unit >= 0; unit--) {
    if (chosen.has(unit)) continue;
    const items = fit(content(unit), remaining);
    if (!items) break;
    chosen.set(unit, items);
    remaining -= cost(items);
    if (items.some((item, index) => item !== content(unit)[index])) break;
  }

  const ordered = [...chosen.keys()].toSorted((left, right) => left - right);
  const kept = ordered.flatMap((unit) => {
    const { start, end } = units[unit] ?? { start: 0, end: 0 };
    return Array.from({ length: end - start }, (_value, offset) => start + offset);
  });
  const items = ordered.flatMap((unit) => chosen.get(unit) ?? []);
  const original = ordered.flatMap(content);
  return {
    observedSetup,
    ...combine(items),
    kept,
    shortened: items.filter((item, index) => item.message !== original[index]?.message).length,
  };
}

/** Join individually projected messages, renumbering their image attachments. */
function combine(items: readonly Projected[]): Evidence {
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
