import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { captureCheckpointAdapter, type CheckpointAdapter } from "./checkpoint-adapter.js";
import { registerContextTools } from "./context-tools.js";
import {
  renderContextToolCall,
  renderContextToolResult,
  type ContextToolDetails,
} from "./context-tool-rendering.js";
import {
  contextReference,
  assertContextJournalReadable,
  ensureReferenceOrigin,
  noteIndex,
  quarantineContextJournal,
} from "./context-store.js";
import {
  CheckpointDetails,
  HANDOFF_ENTRY,
  HandoffRecord,
  planCheckpoint,
  savedHandoff,
} from "./context-window.js";

import { hasLegacyContextSettings } from "./context-settings.js";

const RolloverParameters = Type.Object(
  { handoff: Type.String({ minLength: 1, maxLength: 64_000 }) },
  { additionalProperties: false },
);

/** Session-local Context Windows; no background model, storage service, or consumer-specific integration. */
export default function contextManagement(pi: ExtensionAPI): void {
  let adapter: CheckpointAdapter | undefined;
  let pending: { handoff: string; signal: AbortSignal | undefined } | undefined;
  let manualRollover: { instructions: string; signal: AbortSignal } | undefined;
  let failure: Error | undefined;
  let preparation: "ready" | "pending" | "unfinished" = "ready";
  let queuedPreparationSignal: AbortSignal | undefined;
  let nativeLeaf: string | null | undefined;
  let nativeCommittedBefore: string | undefined;

  const fail = (error: Error, ctx: ExtensionContext) => {
    failure = error;
    adapter?.fault(error);
    adapter?.session.abortCompaction();
    ctx.abort();
    ctx.ui.notify(
      "Context Management stopped: " +
        error.message +
        ". Fix the cause and reopen the persisted session before continuing (not just /reload).",
      "error",
    );
  };
  const requireAdapter = () => {
    if (failure) throw failure;
    if (!adapter) throw new Error("Context Management has no compatible Pi session");
    assertContextJournalReadable(adapter.session.sessionManager);
    return adapter;
  };
  pi.on("session_start", (_event, ctx) => {
    adapter?.dispose();
    pending = undefined;
    manualRollover = undefined;
    failure = undefined;
    nativeLeaf = undefined;
    preparation = "ready";
    try {
      adapter = captureCheckpointAdapter(pi, {
        compaction: {
          handler: beforeCompact,
          onConflict: (error) => fail(error, ctx),
        },
      });
      if (hasLegacyContextSettings(adapter.session.settingsManager))
        ctx.ui.notify(
          "contextManagement settings are obsolete and ignored. Use Pi compaction.enabled, reserveTokens, and keepRecentTokens instead.",
          "warning",
        );
      requireAdapter();
      ensureReferenceOrigin(pi, ctx.sessionManager);
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)), ctx);
    }
  });
  pi.on("session_shutdown", () => {
    adapter?.dispose();
    adapter = undefined;
    pending = undefined;
    manualRollover = undefined;
    preparation = "ready";
  });
  pi.on("input", (_event, ctx) => {
    try {
      requireAdapter();
    } catch (cause) {
      // Do not append new prompts beneath speculative journal entries after a write failure.
      ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
      return { action: "handled" };
    }
  });
  registerContextTools(pi, fail);
  pi.registerCommand("context", {
    description: "Inspect native Context usage, Notes, and recent Context Windows",
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify("Usage: /context", "info");
        return;
      }
      try {
        const owner = requireAdapter();
        const usage = owner.session.getContextUsage();
        const configuration = owner.session.settingsManager.getCompactionSettings();
        const checkpoints = ctx.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "compaction");
        ctx.ui.notify(
          [
            "Context Management (native Pi accounting)",
            "Native usage: " +
              (usage?.tokens ?? "unavailable after transition") +
              " / " +
              (usage?.contextWindow ?? owner.session.model?.contextWindow ?? "unknown") +
              " tokens.",
            "Native recent-history retention: " + configuration.keepRecentTokens + " tokens.",
            noteIndex(ctx.sessionManager, 2000),
            "Recent Context Windows (" + (checkpoints.length + 1) + " total):",
            ...checkpoints
              .slice(-5)
              .map(
                (entry) => contextReference(ctx.sessionManager, entry.id) + " " + entry.timestamp,
              ),
          ].join("\n"),
          "info",
        );
      } catch (cause) {
        ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
      }
    },
  });
  function requestRollover(args: string, ctx: ExtensionContext): void {
    try {
      const owner = requireAdapter();
      if (preparation === "pending") return;
      queuedPreparationSignal = undefined;
      preparation = "pending";
      ctx.ui.notify("Preparing Notes and a fresh Handoff before Rollover.", "info");
      void owner.session.sendUserMessage(preparationPrompt(args), { deliverAs: "steer" }).then(
        () => {
          // A handled input can finish without ever starting an agent run.
          if (adapter === owner && owner.session.isIdle) finishPreparation(ctx);
        },
        (cause) => {
          if (adapter !== owner) return;
          finishPreparation(ctx);
          ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
        },
      );
    } catch (cause) {
      ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
    }
  }
  function preparationPrompt(args = ""): string {
    return (
      "Prepare a Context Rollover for the current task: update useful Notes, then call context_rollover as the only direct tool call with an explicit Handoff containing the objective, decisions, current state, and next actions. Continue the task after the checkpoint." +
      (args.trim() ? "\nAdditional instructions: " + args.trim() : "")
    );
  }
  function finishPreparation(ctx: ExtensionContext): void {
    if (preparation !== "pending") return;
    preparation = "unfinished";
    ctx.ui.notify(
      "Rollover was not completed; the current Context Window was retained. Request /rollover to try again.",
      "warning",
    );
  }
  pi.on("context", (_event, ctx) => {
    // Pi can restart queued steering with a new controller after post-run compaction aborts.
    if (preparation === "pending" && queuedPreparationSignal?.aborted) ctx.abort();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const cancelled = preparation === "pending" && queuedPreparationSignal?.aborted;
    queuedPreparationSignal = undefined;
    finishPreparation(ctx);
    if (!cancelled) return;
    try {
      // Keep queued input in History, then supersede the cancelled preparation durably.
      await requireAdapter().session.sendCustomMessage(
        {
          customType: "pi-context-prepare-cancelled",
          content:
            "The preceding Context Rollover preparation was cancelled. Do not resume it unless explicitly requested; continue the user's task without Rollover.",
          display: false,
        },
        { triggerTurn: false },
      );
    } catch (cause) {
      quarantineContextJournal(ctx.sessionManager);
      fail(cause instanceof Error ? cause : new Error(String(cause)), ctx);
    }
  });
  pi.registerCommand("rollover", {
    description: "Ask the agent to update Notes, write its Handoff, and request Rollover",
    async handler(args, ctx) {
      if (args.length > 2000) {
        ctx.ui.notify("Keep Rollover instructions below 2000 characters", "error");
        return;
      }
      requestRollover(args, ctx);
    },
  });
  pi.on("session_tree", () => {
    pending = undefined;
    manualRollover = undefined;
    preparation = "ready";
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\nContext Management: keep named Notes with context_notes. Original selected-branch History is available through context_history. Before Rollover, update Notes then call context_rollover alone with an explicit continuation Handoff. Read full Notes only when needed; inherited references may be unavailable locally.",
  }));
  pi.registerTool<typeof RolloverParameters, ContextToolDetails>({
    name: "context_rollover",
    label: "Context Rollover",
    description:
      "Save an agent-written Handoff and request an immediate native Context Checkpoint after this tool batch. Must be a standalone direct tool call; never nest in CodeMode.",
    parameters: RolloverParameters,
    executionMode: "sequential",
    renderCall: (args, theme, context) =>
      renderContextToolCall(
        "Rollover",
        args,
        theme,
        context.isPartial,
        context.executionStarted,
        context.expanded,
      ),
    renderResult: (result, options, theme, context) =>
      renderContextToolResult(result, options, theme, "Rollover", context.args, context.isError),
    async execute(id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      requireAdapter();
      if (!Value.Check(RolloverParameters, params) || !params.handoff.trim())
        throw new Error("Supply a non-empty Handoff of at most 64000 characters");
      const assistant = ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      const calls =
        assistant?.type === "message" && assistant.message.role === "assistant"
          ? assistant.message.content.filter((part) => part.type === "toolCall")
          : [];
      if (
        pending ||
        calls.length !== 1 ||
        calls[0]?.id !== id ||
        calls[0].name !== "context_rollover"
      )
        throw new Error(
          "Rollover must be the sole direct tool call; nested/non-isolated placement is unsafe",
        );
      const record = { version: 1, handoff: params.handoff };
      if (!Value.Check(HandoffRecord, record)) throw new Error("Invalid Handoff");
      try {
        pi.appendEntry(HANDOFF_ENTRY, record);
      } catch (cause) {
        quarantineContextJournal(ctx.sessionManager);
        const error = cause instanceof Error ? cause : new Error(String(cause));
        fail(error, ctx);
        throw error;
      }
      pending = { handoff: params.handoff, signal };
      return {
        content: [
          {
            type: "text",
            text: "Handoff saved. Rollover requested; commit follows the complete tool batch.",
          },
        ],
        details: { requested: true },
      };
    },
  });
  pi.on("turn_end", (_event, ctx) => {
    const request = pending;
    pending = undefined;
    if (!request || request.signal?.aborted) return;
    try {
      const owner = requireAdapter();
      const plan = planCheckpoint(
        owner.session.sessionManager,
        request.handoff,
        "normal",
        owner.session.settingsManager.getCompactionSettings().keepRecentTokens,
      );
      owner.commit(
        plan.summary,
        plan.firstKeptEntryId,
        owner.session.getContextUsage()?.tokens ?? 0,
        plan.details,
        request.signal,
      );
      preparation = "ready";
      ctx.ui.notify("Context Window rolled over; History and Notes preserved.", "info");
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)), ctx);
    }
  });
  function beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
    if (event.signal.aborted) return { cancel: true };
    try {
      const owner = requireAdapter();
      if (event.reason === "manual") {
        manualRollover = { instructions: event.customInstructions ?? "", signal: event.signal };
        return { cancel: true };
      }
      if (event.reason !== "overflow") {
        if (preparation === "ready") {
          queuedPreparationSignal = event.signal;
          preparation = "pending";
          ctx.ui.notify("Preparing Notes and a fresh Handoff before Rollover.", "info");
          pi.sendMessage(
            { customType: "pi-context-prepare", content: preparationPrompt(), display: true },
            { deliverAs: owner.session.isStreaming ? "steer" : "nextTurn" },
          );
        }
        return { cancel: true };
      }
      nativeLeaf = ctx.sessionManager.getLeafId();
      nativeCommittedBefore = owner.lastCommittedCheckpointId;
      const plan = planCheckpoint(
        ctx.sessionManager,
        savedHandoff(ctx.sessionManager) ??
          "No saved Handoff. Recover the user's task from recent History and Notes.",
        event.reason,
        event.preparation.settings.keepRecentTokens,
        event.preparation.firstKeptEntryId,
      );
      return {
        compaction: {
          summary: plan.summary,
          firstKeptEntryId: owner.cutoff(plan.firstKeptEntryId),
          tokensBefore: event.preparation.tokensBefore,
          details: plan.details,
        },
      };
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)), ctx);
      return { cancel: true };
    }
  }
  pi.on("session_before_compact", beforeCompact);
  pi.on("session_compact", (event, ctx) => {
    nativeLeaf = undefined;
    preparation = "ready";
    if (!Value.Check(CheckpointDetails, event.compactionEntry.details)) {
      fail(new Error("Another extension replaced the Context Checkpoint"), ctx);
      return;
    }
    ctx.ui.notify(
      "Context Window rolled over (" +
        event.reason +
        "); saved Handoff may be stale. History preserved.",
      "warning",
    );
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const request = manualRollover;
    manualRollover = undefined;
    if (request && event.reason === "manual" && event.aborted) {
      // Pi releases its compaction lock before this event; the preparation prompt can now run.
      if (!request.signal.aborted) requestRollover(request.instructions, ctx);
      return;
    }
    if (nativeLeaf === undefined) return;
    const manager = adapter?.session.sessionManager;
    const committed = adapter?.lastCommittedCheckpointId !== nativeCommittedBefore;
    // A failure while projecting an acknowledged checkpoint is not a failed journal append.
    if (!committed) {
      if (nativeLeaf === null) manager?.resetLeaf();
      else manager?.branch(nativeLeaf);
    }
    nativeLeaf = undefined;
    if (!event.aborted || committed) {
      quarantineContextJournal(ctx.sessionManager);
      fail(new Error(event.errorMessage ?? "Native checkpoint append failed"), ctx);
    }
  });
}
