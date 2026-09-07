import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
  messageTokens,
  boundedCheckpoint,
  contextBudget,
  savedHandoff,
} from "./context-window.js";

import { resolveContextSettings, type ContextSettings } from "./context-settings.js";

const RolloverParameters = Type.Object(
  { handoff: Type.String({ minLength: 1, maxLength: 64_000 }) },
  { additionalProperties: false },
);

/** Session-local Context Windows; no background model, storage service, or consumer-specific integration. */
export default function contextManagement(pi: ExtensionAPI): void {
  let adapter: CheckpointAdapter | undefined;
  let pending: { handoff: string; signal: AbortSignal | undefined } | undefined;
  let failure: Error | undefined;
  let settings: ContextSettings | undefined;
  let nativeLeaf: string | null | undefined;
  let nativeCommittedBefore: string | undefined;
  let warnedWindow: string | undefined;
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
  const requireSettings = () => {
    if (!settings) throw new Error("Context Management settings unavailable");
    return settings;
  };
  pi.on("session_start", (_event, ctx) => {
    adapter?.dispose();
    pending = undefined;
    failure = undefined;
    nativeLeaf = undefined;
    warnedWindow = undefined;
    try {
      adapter = captureCheckpointAdapter(pi, {
        compaction: {
          handler: beforeCompact,
          onConflict: (error) => fail(error, ctx),
        },
        afterTransformContext(messages, signal, mayRebuild) {
          signal?.throwIfAborted();
          try {
            const owner = requireAdapter();
            const configuration = requireSettings();
            const budget = contextBudget(owner.session, configuration, messages);
            if (budget.ratio < configuration.emergencyThreshold) {
              const window =
                ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")
                  ?.id ?? "initial";
              if (budget.ratio >= configuration.warningThreshold && warnedWindow !== window) {
                warnedWindow = window;
                // This fixed-size reminder fits inside the configured >=256-token safety margin.
                const warning: AgentMessage = {
                  role: "custom",
                  customType: "pi-context-budget",
                  display: false,
                  timestamp: 0,
                  content:
                    "Context budget warning (~" +
                    Math.round(budget.ratio * 100) +
                    "% of usable input, output reserved). Update Notes and prepare a Handoff; call context_rollover alone before the emergency threshold.",
                };
                ctx.ui.notify("Context budget warning: prepare a Handoff and Rollover.", "warning");
                return [...messages, warning];
              }
              return;
            }
            const branch = ctx.sessionManager.getBranch();
            const checkpoint = branch.findLastIndex((entry) => entry.type === "compaction");
            if (
              !mayRebuild ||
              (checkpoint >= 0 &&
                !branch
                  .slice(checkpoint + 1)
                  .some((entry) => entry.type === "message" || entry.type === "custom_message"))
            ) {
              throw new Error(
                "Fresh Context Window still exceeds the emergency budget; reduce live context/instructions or choose a larger model",
              );
            }
            const liveTokens = Math.max(
              0,
              messageTokens(messages) - messageTokens(owner.session.messages),
            );
            const plan = boundedCheckpoint(
              owner.session,
              configuration,
              savedHandoff(ctx.sessionManager) ??
                "No saved Handoff. Recover the user's task from recent History and Notes.",
              "emergency",
              liveTokens,
            );
            owner.commit(
              plan.summary,
              plan.firstKeptEntryId,
              budget.inputTokens,
              plan.details,
              signal,
            );
            ctx.ui.notify(
              "Emergency Rollover: saved Handoff may be stale or absent. Recover recent History before continuing.",
              "warning",
            );
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            fail(error, ctx);
            throw error;
          }
        },
      });
      settings = resolveContextSettings(adapter.session.settingsManager);
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
    description:
      "Inspect Context budget, Notes, and recent Context Windows without changing History",
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify("Usage: /context", "info");
        return;
      }
      try {
        const owner = requireAdapter();
        const configuration = requireSettings();
        const budget = contextBudget(owner.session, configuration);
        const checkpoints = ctx.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "compaction");
        const latest = checkpoints.at(-1);
        const effective =
          latest && Value.Check(CheckpointDetails, latest.details)
            ? latest.details.tailTokens
            : "not yet retained";
        ctx.ui.notify(
          [
            "Context Management (" + budget.source + ")",
            "Input ~" +
              budget.inputTokens +
              " / " +
              budget.usableInput +
              " usable tokens; output reserved " +
              budget.outputReserve +
              ".",
            "Latest native measurement: " +
              (budget.measuredTokens ?? "unavailable after transition") +
              ". Safety margin: " +
              configuration.safetyMarginTokens +
              ".",
            "Tail configured ≤" +
              configuration.tailTokens +
              "; last effective Tail: " +
              effective +
              ".",
            "Warn at " +
              Math.round(configuration.warningThreshold * 100) +
              "%; emergency at " +
              Math.round(configuration.emergencyThreshold * 100) +
              "%.",
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
  pi.registerCommand("rollover", {
    description: "Ask the agent to update Notes, write its Handoff, and request Rollover",
    async handler(args, ctx) {
      try {
        requireAdapter();
        if (args.length > 2000)
          throw new Error("Keep /rollover instructions below 2000 characters");
        pi.sendUserMessage(
          "Prepare a Context Rollover for the current task: update useful Notes, then call context_rollover as the only direct tool call with an explicit Handoff containing the objective, decisions, current state, and next actions. Continue the task after the checkpoint." +
            (args.trim() ? "\nAdditional instructions: " + args.trim() : ""),
          { deliverAs: "followUp" },
        );
      } catch (cause) {
        ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
      }
    },
  });
  pi.on("session_tree", () => {
    pending = undefined;
    warnedWindow = undefined;
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
      renderContextToolCall("Rollover", args, theme, context.isPartial, context.executionStarted),
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
      // Validate essentials before acknowledging; the current call/result group is not complete yet.
      boundedCheckpoint(
        requireAdapter().session,
        { ...requireSettings(), tailTokens: 0 },
        params.handoff,
        "normal",
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
      const plan = boundedCheckpoint(owner.session, requireSettings(), request.handoff, "normal");
      owner.commit(
        plan.summary,
        plan.firstKeptEntryId,
        messageTokens(owner.session.messages),
        plan.details,
        request.signal,
      );
      ctx.ui.notify("Context Window rolled over; History and Notes preserved.", "info");
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)), ctx);
    }
  });
  function beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
    try {
      event.signal.throwIfAborted();
      const owner = requireAdapter();
      nativeLeaf = ctx.sessionManager.getLeafId();
      nativeCommittedBefore = owner.lastCommittedCheckpointId;
      const plan = boundedCheckpoint(
        owner.session,
        requireSettings(),
        savedHandoff(ctx.sessionManager) ??
          "No saved Handoff. Recover the user's task from recent History and Notes.",
        event.reason,
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
