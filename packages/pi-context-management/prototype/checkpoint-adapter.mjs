// THROWAWAY: native Context Checkpoint proof, not a production extension.
import { Type } from "typebox";

// Same synchronous receiver-capture technique as pi-codemode's pi-agent-session-capture.ts.
// Kept local because that helper imports the checkout's different Pi version (0.85.0).
function capture(pi, sdk) {
  const prototype = sdk.AgentSession.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "getAllTools");
  let owner;
  Object.defineProperty(prototype, "getAllTools", {
    ...descriptor,
    value(...args) {
      owner = this;
      return descriptor.value.apply(this, args);
    },
  });
  try {
    pi.getAllTools();
  } finally {
    Object.defineProperty(prototype, "getAllTools", descriptor);
  }
  if (
    !(owner instanceof sdk.AgentSession) ||
    !(owner.sessionManager instanceof sdk.SessionManager)
  ) {
    throw new Error("Prototype capability gate: cannot capture owning Pi session");
  }
  return owner;
}

function selectTail(sdk, manager, limit) {
  const groups = [];
  for (const entry of manager.buildContextEntries()) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const group = groups.at(-1);
      const calls = group?.[0].message?.content?.filter((p) => p.type === "toolCall") ?? [];
      if (!calls.some((c) => c.id === entry.message.toolCallId))
        throw new Error("Orphan tool result");
      group.push(entry);
    } else groups.push([entry]);
  }
  let first;
  let tokens = 0;
  for (const group of groups.toReversed()) {
    const calls =
      group[0].message?.role === "assistant"
        ? group[0].message.content.filter((p) => p.type === "toolCall")
        : [];
    const results = group
      .filter((e) => e.message?.role === "toolResult")
      .map((e) => e.message.toolCallId);
    if (
      calls.length !== results.length ||
      new Set(results).size !== results.length ||
      new Set(calls.map((c) => c.id)).size !== calls.length ||
      !calls.every((c) => results.includes(c.id))
    ) {
      throw new Error("Incomplete or duplicate tool batch");
    }
    if (
      group.some(
        (e) =>
          e.message?.role === "assistant" && ["error", "aborted"].includes(e.message.stopReason),
      )
    )
      break;
    const messages = sdk.buildSessionContext(group).messages;
    const size = messages.reduce((sum, m) => sum + sdk.estimateTokens(m), 0);
    if (tokens + size > limit) break; // Contiguous suffix: never split a protocol group.
    tokens += size;
    first = group[0].id;
  }
  return { first, tokens };
}

export function checkpointPrototype(sdk, { tailTokens = 16_000 } = {}) {
  if (sdk.VERSION !== "0.85.1") throw new Error(`Untested Pi version: ${sdk.VERSION}`);
  const state = { commits: [], errors: [], tailTokens };
  const extension = (pi) => {
    let owner;
    let pending;
    let refresh = false;
    pi.on("session_start", () => {
      owner = capture(pi, sdk);
      const previous = owner.agent.prepareNextTurnWithContext;
      if (!previous) throw new Error("Prototype capability gate: missing next-turn refresh");
      // Replace the active loop's snapshot BEFORE Pi preflight and public context transforms.
      // This keeps Todo/MCP/etc. on their normal hook path, not a private shadow projection.
      owner.agent.prepareNextTurnWithContext = async (turn, signal) => {
        if (state.errors.length) throw new Error("Checkpoint adapter faulted: reload required");
        const needsRefresh = refresh;
        if (needsRefresh) {
          turn = {
            ...turn,
            context: { ...turn.context, messages: owner.agent.state.messages.slice() },
          };
        }
        const snapshot = await previous.call(owner.agent, turn, signal);
        if (needsRefresh) refresh = false;
        return snapshot;
      };
    });
    pi.on("session_before_compact", (event, ctx) => {
      try {
        event.signal.throwIfAborted();
        const manager = owner.sessionManager;
        const tail = selectTail(sdk, manager, tailTokens);
        const latest = manager
          .getBranch()
          .findLast((e) => e.type === "compaction" && e.details?.prototype);
        const first = tail.first ?? manager.appendCustomEntry("context-prototype-empty-tail", {});
        return {
          compaction: {
            summary: latest?.summary ?? "Recover task from archived History.",
            firstKeptEntryId: first,
            tokensBefore: event.preparation.tokensBefore,
            details: { prototype: true, reason: event.reason, tailTokens: tail.tokens },
          },
        };
      } catch (error) {
        state.errors.push(String(error));
        ctx.abort();
        return { cancel: true }; // Fail closed: never fall through to Pi's summarizer.
      }
    });
    pi.registerTool({
      name: "context_rollover",
      label: "Prototype Rollover",
      description: "Prototype only: request a native checkpoint. Must be the sole tool call.",
      parameters: Type.Object({ handoff: Type.String({ minLength: 1 }) }),
      async execute(id, { handoff }, signal, _update, ctx) {
        signal?.throwIfAborted();
        if (state.errors.length) throw new Error("Checkpoint adapter faulted: reload required");
        const assistant = ctx.sessionManager
          .getBranch()
          .findLast((e) => e.type === "message" && e.message.role === "assistant");
        const calls = assistant?.message.content.filter((p) => p.type === "toolCall") ?? [];
        if (calls.length !== 1 || calls[0].id !== id || calls[0].name !== "context_rollover") {
          throw new Error("Rollover must be a standalone direct tool call");
        }
        pending = { handoff, signal };
        return { content: [{ type: "text", text: "Rollover requested." }], details: { handoff } };
      },
    });
    pi.on("turn_end", (_event, ctx) => {
      if (!pending) return;
      const request = pending;
      pending = undefined;
      if (request.signal?.aborted) return;
      const manager = owner.sessionManager;
      const before = manager.getLeafId();
      try {
        const tail = selectTail(sdk, manager, tailTokens);
        // A neutral invisible entry is a real, valid cutoff for a zero-message Tail.
        // It is not a committed checkpoint; a failed second append must not activate it.
        const first = tail.first ?? manager.appendCustomEntry("context-prototype-empty-tail", {});
        const id = manager.appendCompaction(
          request.handoff,
          first,
          owner.messages.reduce((sum, m) => sum + sdk.estimateTokens(m), 0),
          { prototype: true, tailTokens: tail.tokens, previousLeaf: before },
          true,
        );
        owner.agent.state.messages = manager.buildSessionContext().messages;
        refresh = true;
        state.commits.push({ id, tailTokens: tail.tokens });
      } catch (error) {
        if (before === null) manager.resetLeaf();
        else manager.branch(before);
        state.errors.push(String(error));
        ctx.abort();
      }
    });
  };
  return { extension, state };
}
