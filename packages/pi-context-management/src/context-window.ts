import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  estimateTokens,
  type AgentSession,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { contextReference, noteIndex, type ReadonlySessionManager } from "./context-store.js";
import type { ContextSettings } from "./context-settings.js";

export const CheckpointDetails = Type.Object({
  owner: Type.Literal("pi-context-management"),
  version: Type.Literal(1),
  handoff: Type.String(),
  reason: Type.String(),
  sourceSession: Type.String(),
  previousLeaf: Type.Union([Type.String(), Type.Null()]),
  tailTokens: Type.Number(),
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

/** Contiguous suffix of complete protocol groups; never retain an orphan or failed response. */
function selectTail(manager: ReadonlySessionManager, limit: number) {
  const groups: SessionEntry[][] = [];
  for (const entry of manager.buildContextEntries()) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const group = groups.at(-1);
      const leader = group?.[0];
      const callId = entry.message.toolCallId;
      if (
        leader?.type !== "message" ||
        leader.message.role !== "assistant" ||
        !leader.message.content.some((part) => part.type === "toolCall" && part.id === callId)
      ) {
        throw new Error(
          "History contains an orphan tool result; repair the source session before Rollover",
        );
      }
      group!.push(entry);
    } else groups.push([entry]);
  }
  if (limit === 0) {
    const last = groups.at(-1)?.[0];
    return {
      first: undefined,
      tokens: 0,
      omitted: last ? contextReference(manager, last.id) : undefined,
    };
  }
  let first: string | undefined;
  let omitted: string | undefined;
  let tokens = 0;
  for (const group of groups.toReversed()) {
    const leader = group[0]!;
    if (
      leader.type === "message" &&
      leader.message.role === "assistant" &&
      (leader.message.stopReason === "error" || leader.message.stopReason === "aborted")
    ) {
      omitted = contextReference(manager, leader.id);
      break;
    }
    const calls =
      leader.type === "message" && leader.message.role === "assistant"
        ? leader.message.content.filter((part) => part.type === "toolCall")
        : [];
    const results = group.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult"
        ? [entry.message.toolCallId]
        : [],
    );
    if (
      calls.length !== results.length ||
      new Set(results).size !== results.length ||
      new Set(calls.map((call) => call.id)).size !== calls.length ||
      !calls.every((call) => results.includes(call.id))
    ) {
      throw new Error("History contains an incomplete tool batch; Rollover refused");
    }
    const size = buildSessionContext(group).messages.reduce(
      (sum, message) => sum + estimateTokens(message),
      0,
    );
    if (tokens + size > limit) {
      omitted = contextReference(manager, leader.id);
      break;
    }
    tokens += size;
    first = leader.id;
  }
  return { first, tokens, omitted };
}

export function planCheckpoint(
  manager: ReadonlySessionManager,
  handoff: string,
  reason: string,
  tailTokens: number,
  indexCharacters = 4000,
) {
  const tail = selectTail(manager, tailTokens);
  const previousLeaf = manager.getLeafId();
  const summary = [
    "Context Window Handoff",
    reason === "normal"
      ? "Agent-written Handoff:"
      : "Emergency/native Rollover: saved Handoff may be stale or absent. Recover recent History before continuing.",
    handoff,
    indexCharacters > 0
      ? noteIndex(manager, indexCharacters)
      : "Note Index omitted for space; list available Notes with context_notes.",
    previousLeaf
      ? "Recent History: " + contextReference(manager, previousLeaf)
      : "No earlier recorded History.",
    tail.omitted ? "Omitted complete History group: " + tail.omitted : "",
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
    tailTokens: tail.tokens,
  };
  return { summary, firstKeptEntryId: tail.first, details };
}

export function messageTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function textTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

/** Conservative estimate, not a provider tokenizer. Native overflow recovery remains the backstop. */
export function contextBudget(
  session: AgentSession,
  settings: ContextSettings,
  messages = session.messages,
) {
  const model = session.model;
  if (!model) throw new Error("Select a model before managing its Context Window");
  const outputReserve = Math.max(model.maxTokens, settings.outputReserveTokens);
  const usableInput = model.contextWindow - outputReserve;
  const staticTokens =
    textTokens(session.agent.state.systemPrompt) +
    textTokens(
      JSON.stringify(
        session.agent.state.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ),
    );
  const measured = session.getContextUsage()?.tokens;
  const liveExtra = Math.max(0, messageTokens(messages) - messageTokens(session.messages));
  const inputTokens =
    Math.max(messageTokens(messages), (measured ?? 0) + liveExtra) +
    staticTokens +
    settings.safetyMarginTokens;
  if (usableInput <= 0) throw new Error("Model output reserve leaves no usable input budget");
  return {
    inputTokens,
    staticTokens,
    outputReserve,
    usableInput,
    ratio: inputTokens / usableInput,
    measuredTokens: measured ?? null,
    source: "conservative estimate",
  };
}

/** Essential instructions/Handoff first, bounded Note Index second, then a shrinking complete Tail. */
export function boundedCheckpoint(
  session: AgentSession,
  settings: ContextSettings,
  handoff: string,
  reason: string,
  liveTokens = 0,
) {
  const budget = contextBudget(session, settings);
  budget.staticTokens += liveTokens;
  const ceiling =
    Math.floor(budget.usableInput * settings.emergencyThreshold) -
    budget.staticTokens -
    settings.safetyMarginTokens -
    256;
  const minimum = planCheckpoint(session.sessionManager, handoff, reason, 0, 0);
  const minimumTokens = textTokens(minimum.summary);
  if (minimumTokens >= ceiling)
    throw new Error(
      "Essential fresh context cannot fit: shorten the Handoff or standing instructions/tool declarations, or select a larger model",
    );
  const indexCharacters = Math.min(4000, Math.max(0, (ceiling - minimumTokens) * 2));
  const base = planCheckpoint(session.sessionManager, handoff, reason, 0, indexCharacters);
  const allowance = Math.max(
    0,
    Math.floor(budget.usableInput * settings.warningThreshold) -
      budget.staticTokens -
      settings.safetyMarginTokens -
      textTokens(base.summary) -
      256,
  );
  const plan = planCheckpoint(
    session.sessionManager,
    handoff,
    reason,
    Math.min(settings.tailTokens, allowance),
    indexCharacters,
  );
  if (textTokens(plan.summary) + plan.details.tailTokens >= ceiling)
    throw new Error(
      "Fresh Context Window still exceeds its safe input budget; shorten the Handoff",
    );
  return plan;
}
