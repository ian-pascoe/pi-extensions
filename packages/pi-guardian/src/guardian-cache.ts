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

const CacheMarker = Type.Object({ type: Type.String(), ttl: Type.Optional(Type.String()) });

/** The parts of an Anthropic Messages payload a breakpoint touches. */
const AnthropicPayload = Type.Object({
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

/** The parts of a Bedrock Converse payload a breakpoint touches. */
const BedrockPayload = Type.Object({
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
  const content = payload.messages.find((message) => message.role === "user")?.content;
  const tailContent = payload.messages.at(-1)?.content;
  const tail = Array.isArray(tailContent) ? tailContent.at(-1)?.cache_control : undefined;
  // Without a tail marker the adapter has caching off (`cacheRetention: "none"`).
  if (!tail || !Array.isArray(content) || evidenceBlocks >= content.length) return false;
  const block = content[evidenceBlocks - 1];
  if (block?.type !== "text") return false;
  block.cache_control = { ...tail };
  return true;
}

/** Bedrock Converse: insert a copy of the tail's `cachePoint` after the last evidence block. */
function markBedrock(payload: BedrockPayload, evidenceBlocks: number): boolean {
  const content = payload.messages.find((message) => message.role === "user")?.content;
  const tail = payload.messages.at(-1)?.content.at(-1)?.cachePoint;
  // Without a tail cache point the adapter has caching off, or the model does not support it.
  if (!tail || !content || evidenceBlocks >= content.length) return false;
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
 * The breakpoint uses the third of Anthropic's four slots, beside the system prompt's and the
 * tail's. Anthropic finds an earlier entry by looking back at most {@link anthropicLookbackBlocks}
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
