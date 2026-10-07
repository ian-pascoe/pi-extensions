import type { Context, Tool } from "@earendil-works/pi-ai";
import {
  combineEvidence,
  evidenceItemsCost,
  fitEvidence,
  projectEvidenceItem,
  shortenEvidence,
  type Evidence,
  type EvidenceItem,
} from "@ian-pascoe/pi-utils/evidence";

export {
  evidenceRefs,
  evidenceTokens,
  messageOrigins,
  projectEvidence,
  toolCallRef,
  type Evidence,
  type EvidenceBlock,
  type EvidenceMessage,
} from "@ian-pascoe/pi-utils/evidence";

/** Marks text shortened to fit the Context Seed budget. */
const omissionMarker = (omitted: number) =>
  `[… ${omitted} characters omitted from the Context Seed]`;

/** Observed Setup: the observed system prompt and tool summaries that open a Context Seed. */
export interface ObservedSetup {
  systemPrompt: string | undefined;
  tools: { name: string; summary: string }[];
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

/** A Context Seed: the Observed Setup and the observed messages that fit its token budget. */
export interface ContextSeed extends Evidence {
  observedSetup: ObservedSetup;
  /** Zero-based positions of the kept observed messages, ascending. */
  kept: number[];
  /** Long texts shortened, with a marker, so the newest messages fit. */
  shortened: number;
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
  const projected = messages.map((message): EvidenceItem[] => {
    const item = projectEvidenceItem(message);
    return item ? [item] : [];
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

  const chosen = new Map<number, EvidenceItem[]>();
  let remaining =
    options.budgetTokens - Math.ceil(JSON.stringify({ observedSetup, messages: [] }).length / 4);
  const anchorItems = [...anchors].flatMap(content);
  const recentItems = [...recent].flatMap(content);
  // Shorten the newest turn first, then the original request too, so both always appear.
  const required =
    fitEvidence(recentItems, remaining - evidenceItemsCost(anchorItems), omissionMarker)?.concat(
      anchorItems,
    ) ??
    fitEvidence([...recentItems, ...anchorItems], remaining, omissionMarker) ??
    shortenEvidence([...recentItems, ...anchorItems], 0, omissionMarker);
  remaining -= evidenceItemsCost(required);
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
    const items = fitEvidence(content(unit), remaining, omissionMarker);
    if (!items) break;
    chosen.set(unit, items);
    remaining -= evidenceItemsCost(items);
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
    ...combineEvidence(items),
    kept,
    shortened: items.filter((item, index) => item.message !== original[index]?.message).length,
  };
}
