import { findCutPoint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { contextReference, noteIndex, type ReadonlySessionManager } from "./context-store.js";

export const CheckpointDetails = Type.Object({
  owner: Type.Literal("pi-context-management"),
  version: Type.Literal(1),
  handoff: Type.String(),
  reason: Type.String(),
  sourceSession: Type.String(),
  previousLeaf: Type.Union([Type.String(), Type.Null()]),
  // Read older checkpoints without continuing their independent token accounting.
  tailTokens: Type.Optional(Type.Number()),
});
export type CheckpointDetails = Static<typeof CheckpointDetails>;
export const HandoffRecord = Type.Object({
  version: Type.Literal(1),
  handoff: Type.String({ minLength: 1, maxLength: 64_000 }),
});
export const HANDOFF_ENTRY = "pi-context-handoff";

export function savedHandoff(manager: ReadonlySessionManager): string | undefined {
  for (const entry of manager.getBranch().toReversed()) {
    if (
      entry.type === "custom" &&
      entry.customType === HANDOFF_ENTRY &&
      Value.Check(HandoffRecord, entry.data)
    )
      return entry.data.handoff;
    if (entry.type === "compaction" && Value.Check(CheckpointDetails, entry.details))
      return entry.details.handoff;
  }
  return undefined;
}

/** Pi chooses retention; only protocol safety can shorten its contiguous suffix. */
function selectTail(
  manager: ReadonlySessionManager,
  reason: string,
  keepRecentTokens: number,
  nativeCutoff?: string,
) {
  const entries = manager.getBranch();
  const checkpointIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  const checkpoint = entries[checkpointIndex];
  const keptIndex =
    checkpoint?.type === "compaction"
      ? entries.findIndex((entry) => entry.id === checkpoint.firstKeptEntryId)
      : -1;
  const start = keptIndex >= 0 ? keptIndex : checkpointIndex + 1;
  let first =
    nativeCutoff === undefined
      ? start < entries.length
        ? findCutPoint(entries, start, entries.length, keepRecentTokens).firstKeptEntryIndex
        : entries.length
      : entries.findIndex((entry) => entry.id === nativeCutoff);
  if (first < start)
    throw new Error("Context Checkpoint cutoff is outside the active Context Window");

  // Pi removes overflow failures (including a retried length stop) from live messages only.
  const latestAssistant = entries.findLastIndex(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  const failed = entries.findLastIndex(
    (entry, index) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      (entry.message.stopReason === "error" ||
        entry.message.stopReason === "aborted" ||
        (reason === "overflow" &&
          index === latestAssistant &&
          entry.message.stopReason === "length")),
  );
  first = Math.max(first, failed + 1);
  const pending = new Set<string>();
  for (const entry of entries.slice(first)) {
    if (
      entry.type !== "message" &&
      entry.type !== "custom_message" &&
      entry.type !== "branch_summary"
    )
      continue;
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (!pending.delete(entry.message.toolCallId))
        throw new Error("History contains an orphan or duplicate tool result; Rollover refused");
      continue;
    }
    if (pending.size)
      throw new Error("History contains an incomplete tool batch; Rollover refused");
    if (entry.type === "message" && entry.message.role === "assistant") {
      for (const part of entry.message.content) {
        if (part.type !== "toolCall") continue;
        if (pending.has(part.id))
          throw new Error("History contains duplicate tool calls; Rollover refused");
        pending.add(part.id);
      }
    }
  }
  if (pending.size) throw new Error("History contains an incomplete tool batch; Rollover refused");
  return {
    first: entries[first]?.id,
    omitted: entries[first - 1] ? contextReference(manager, entries[first - 1]!.id) : undefined,
  };
}

export function planCheckpoint(
  manager: ReadonlySessionManager,
  handoff: string,
  reason: string,
  keepRecentTokens: number,
  nativeCutoff?: string,
) {
  const tail = selectTail(manager, reason, keepRecentTokens, nativeCutoff);
  const previousLeaf = manager.getLeafId();
  const summary = [
    "Context Window Handoff",
    reason === "normal"
      ? "Agent-written Handoff:"
      : "Emergency/native Rollover: saved Handoff may be stale or absent. Recover recent History before continuing.",
    handoff,
    noteIndex(manager, 4000),
    previousLeaf
      ? "Recent History: " + contextReference(manager, previousLeaf)
      : "No earlier recorded History.",
    tail.omitted ? "Omitted History: " + tail.omitted : "",
    "References belong to source session " +
      manager.getSessionId() +
      ". An inherited snapshot does not copy its Notes/History store: verify availability with context_history; ask the parent if unavailable.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const details: CheckpointDetails = {
    owner: "pi-context-management",
    version: 1,
    handoff,
    reason,
    sourceSession: manager.getSessionId(),
    previousLeaf,
  };
  return { summary, firstKeptEntryId: tail.first, details };
}
