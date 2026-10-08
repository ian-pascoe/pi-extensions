import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Prompt-cache breakpoints for a Guardian Review's request.
 *
 * A review is one user message: evidence blocks, then the Reviewed Call, which differs on every
 * review. Pi's Anthropic and Bedrock adapters mark only the system prompt and the last block of
 * the last message, so the only cache entry a review writes ends at its own Reviewed Call and no
 * later request can read it. Marking the last evidence block as well gives the next review, whose
 * evidence extends this one's, an earlier breakpoint to read. Every other API caches matching
 * prefixes by itself and is left untouched.
 */

/** A request payload hook, as Pi's stream options take it. */
export type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

/** Anthropic reads the cache only at a breakpoint or up to this many blocks before one. */
export const anthropicLookbackBlocks = 20;

/** Anthropic and Bedrock allow at most this many cache breakpoints in one request. */
export const maxCacheBreakpoints = 4;

const CacheMarker = Type.Object({ type: Type.String(), ttl: Type.Optional(Type.String()) });
const Cacheable = Type.Object({ cache_control: Type.Optional(CacheMarker) });

/** The parts of an Anthropic Messages payload a breakpoint touches. */
const AnthropicPayload = Type.Object({
  system: Type.Optional(Type.Array(Cacheable)),
  tools: Type.Optional(Type.Array(Cacheable)),
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.Union([
        Type.String(),
        Type.Array(Type.Object({ type: Type.String(), cache_control: Type.Optional(CacheMarker) })),
      ]),
    }),
  ),
});

const BedrockCacheable = Type.Object({ cachePoint: Type.Optional(CacheMarker) });

/** The parts of a Bedrock Converse payload a breakpoint touches. */
const BedrockPayload = Type.Object({
  system: Type.Optional(Type.Array(BedrockCacheable)),
  toolConfig: Type.Optional(Type.Object({ tools: Type.Optional(Type.Array(BedrockCacheable)) })),
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.Array(
        Type.Object({ text: Type.Optional(Type.String()), cachePoint: Type.Optional(CacheMarker) }),
      ),
    }),
  ),
});

type AnthropicPayload = Static<typeof AnthropicPayload>;
type BedrockPayload = Static<typeof BedrockPayload>;

/** Anthropic Messages: copy the tail's `cache_control` onto the last evidence block. */
function markAnthropic(payload: AnthropicPayload, evidenceBlocks: number): boolean {
  const blocks = payload.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const marked = blocks.filter((block) => block.cache_control);
  const existing =
    marked.length +
    (payload.system ?? []).filter((block) => block.cache_control).length +
    (payload.tools ?? []).filter((block) => block.cache_control).length;
  // The adapter's tail marker is the last one in the messages, wherever the adapter put it: a
  // model with managed effort has empty system messages after the user message. Without any,
  // the adapter has caching off (`cacheRetention: "none"`).
  const tail = marked.at(-1)?.cache_control;
  if (!tail || existing >= maxCacheBreakpoints) return false;
  const content = payload.messages.find((message) => message.role === "user")?.content;
  if (!Array.isArray(content) || evidenceBlocks >= content.length) return false;
  const block = content[evidenceBlocks - 1];
  if (block?.type !== "text") return false;
  block.cache_control = { ...tail };
  return true;
}

/** Bedrock Converse: insert a copy of the tail's `cachePoint` after the last evidence block. */
function markBedrock(payload: BedrockPayload, evidenceBlocks: number): boolean {
  const points = payload.messages.flatMap((message) =>
    message.content.filter((block) => block.cachePoint),
  );
  const existing =
    points.length +
    (payload.system ?? []).filter((block) => block.cachePoint).length +
    (payload.toolConfig?.tools ?? []).filter((block) => block.cachePoint).length;
  // Without a tail cache point the adapter has caching off, or the model does not support it.
  const tail = points.at(-1)?.cachePoint;
  if (!tail || existing >= maxCacheBreakpoints) return false;
  const content = payload.messages.find((message) => message.role === "user")?.content;
  if (!content || evidenceBlocks >= content.length) return false;
  // The adapter drops whitespace-only text blocks, so `evidenceBlocks` indexes the sent content
  // only because every evidence block holds text; the guard below keeps it from marking a stray.
  if (content[evidenceBlocks - 1]?.text === undefined) return false;
  content.splice(evidenceBlocks, 0, { cachePoint: { ...tail } });
  return true;
}

/**
 * A payload hook that adds a cache breakpoint after a review request's first `evidenceBlocks`
 * text blocks, the evidence that precedes the Reviewed Call. It reuses the cache setting the
 * adapter put on the request's tail, so it does nothing where caching is off, and it touches only
 * `anthropic-messages` and `bedrock-converse-stream` payloads, in place.
 *
 * The breakpoint is one more of the four a request may hold, beside the system prompt's and the
 * tail's, so it is skipped when the request already holds four (a Claude subscription login
 * marks two system blocks). Anthropic finds an earlier entry by looking back at most {@link anthropicLookbackBlocks}
 * blocks from a breakpoint, so a review whose evidence grew by more than that writes anew.
 */
export function evidenceCacheBreakpoint(evidenceBlocks: number): PayloadHook {
  return (payload, model: Model<Api>) => {
    if (evidenceBlocks < 1) return undefined;
    if (model.api === "anthropic-messages" && Value.Check(AnthropicPayload, payload))
      return markAnthropic(payload, evidenceBlocks) ? payload : undefined;
    if (model.api === "bedrock-converse-stream" && Value.Check(BedrockPayload, payload))
      return markBedrock(payload, evidenceBlocks) ? payload : undefined;
    return undefined;
  };
}

/**
 * Run payload hooks in order, each seeing the previous one's result. Returns the last replacement
 * a hook made, or `undefined` when none replaced the payload.
 */
export function composePayloadHooks(...hooks: readonly PayloadHook[]): PayloadHook {
  return async (payload, model) => {
    let current = payload;
    let replaced = false;
    for (const hook of hooks) {
      const next = await hook(current, model);
      if (next === undefined) continue;
      current = next;
      replaced = true;
    }
    return replaced ? current : undefined;
  };
}
