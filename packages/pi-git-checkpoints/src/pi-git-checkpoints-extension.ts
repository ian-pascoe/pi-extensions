import { randomUUID } from "node:crypto";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionBeforeTreeEvent,
  type SessionTreeEvent,
  type TurnEndEvent,
  type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  GIT_CHECKPOINT_MODEL_STEP_END_ENTRY_TYPE,
  GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE,
  GIT_CHECKPOINT_UNDO_ENTRY_TYPE,
  createGitCheckpointPreview,
  planGitCheckpointNavigation,
  replayGitCheckpointHistory,
  replayGitCheckpointUndo,
  ModelStepEndEntryPayloadSchema,
  type GitCheckpointHistoryIdentity,
  type GitCheckpointUndoEntryPayload,
  type ModelStepEndEntryPayload,
  type ModelStepStartEntryPayload,
} from "./git-checkpoint-history.js";
import {
  cleanupGitCheckpointStores,
  initializeGitCheckpointStore,
  GitCheckpointStoreError,
  type GitCheckpointCapture,
  type GitCheckpointSourceHead,
  type GitCheckpointStore,
  type GitCheckpointUndoRecord,
} from "./git-checkpoint-store.js";
import { resolveGitCheckpointsSettings } from "./pi-git-checkpoints-settings.js";
import { Value } from "typebox/value";

const PACKAGE_PREFIX = "Git Checkpoints";
const RESTORE_CHOICE = "Restore code and navigate";
const KEEP_CHOICE = "Keep code and navigate";
const CANCEL_CHOICE = "Cancel navigation";
const COMMAND_USAGE = "Usage: /checkpoint status | /checkpoint undo";

type ModelStepStart = {
  readonly stepId: string;
  readonly startEntryId: string;
  readonly capture: GitCheckpointCapture;
};

type PendingRestore = {
  readonly oldLeafId: string | null;
  readonly selectedTargetId: string;
  readonly paths: readonly string[];
  readonly targetTreeId: string;
  readonly approvalTreeId: string;
};

function sourceState(
  sourceHead: GitCheckpointSourceHead,
): ModelStepStartEntryPayload["source_state"] {
  if (sourceHead.kind === "head") return { kind: "commit", head: sourceHead.commit };
  return { kind: sourceHead.kind };
}

function undoEntryPayload(
  identity: GitCheckpointHistoryIdentity,
  record: GitCheckpointUndoRecord | null,
): GitCheckpointUndoEntryPayload {
  return {
    version: 1,
    session_id: identity.sessionId,
    checkpoint_scope: identity.checkpointScope,
    mode: identity.mode,
    record: record
      ? {
          paths: [...record.paths],
          restored_tree_id: record.restoredTreeId,
          safety_tree_id: record.safetyTreeId,
        }
      : null,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function notify(
  context: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (context.hasUI) context.ui.notify(`${PACKAGE_PREFIX}: ${message}`, level);
}

function previewText(
  differences: readonly { readonly path: string; readonly status: "A" | "D" | "M" }[],
  skipped: number,
  headWarning?: string,
): string {
  const preview = createGitCheckpointPreview(differences, skipped);
  const lines = preview.items.map(({ path, status }) => `${status} ${path}`);
  if (preview.hidden > 0) lines.push(`… ${preview.hidden} more`);
  if (preview.skipped > 0) lines.push(`${preview.skipped} skipped path(s) remain untouched`);
  if (headWarning) lines.push(headWarning);
  return `${preview.total} path(s) differ\n${lines.join("\n")}`;
}

function persistedTargetHead(context: ExtensionContext, endEntryId: string): string | undefined {
  const entry = context.sessionManager.getEntries().find(({ id }) => id === endEntryId);
  if (entry?.type !== "custom" || !Value.Check(ModelStepEndEntryPayloadSchema, entry.data))
    return undefined;
  return entry.data.source_state.kind === "commit" ? entry.data.source_state.head : undefined;
}

class PiGitCheckpointsLifecycle {
  private store: GitCheckpointStore | undefined;
  private identity: GitCheckpointHistoryIdentity | undefined;
  private currentStep: ModelStepStart | undefined;
  private pendingRestore: PendingRestore | undefined;
  private retentionDays = 7;
  private disabledReason: string | undefined;
  private failureNotified = false;
  private readonly expiredWarnings = new Set<string>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly getAgentDirectory: () => string = getAgentDir,
  ) {}

  private appendUndoEntry(
    context: ExtensionContext,
    identity: GitCheckpointHistoryIdentity,
    record: GitCheckpointUndoRecord | null,
  ): void {
    const previousLeafId = context.sessionManager.getLeafId();
    try {
      this.pi.appendEntry(GIT_CHECKPOINT_UNDO_ENTRY_TYPE, undoEntryPayload(identity, record));
    } catch (cause) {
      if (context.sessionManager.getLeafId() === previousLeafId) throw cause;
      const message = `undo state remains active in memory but the session write failed: ${errorMessage(cause)}`;
      if (context.hasUI) notify(context, message, "warning");
      else console.warn(`${PACKAGE_PREFIX}: ${message}`);
    }
  }

  register(): void {
    this.pi.on("session_start", async (_event, context) => this.startSession(context));
    this.pi.on("turn_start", async (event, context) => this.startModelStep(event, context));
    this.pi.on("turn_end", async (event, context) => this.endModelStep(event, context));
    this.pi.on("session_before_tree", async (event, context) => this.beforeTree(event, context));
    this.pi.on("session_tree", async (event, context) => this.afterTree(event, context));
    this.pi.on("session_shutdown", async () => this.shutdownSession());
    this.pi.registerCommand("checkpoint", {
      description: "Inspect or undo Git-backed Worktree Checkpoints",
      getArgumentCompletions: (prefix) =>
        ["status", "undo"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: async (arguments_, context) => this.command(arguments_, context),
    });
  }

  private async startSession(context: ExtensionContext): Promise<void> {
    await this.shutdownSession();
    this.disabledReason = undefined;
    this.failureNotified = false;
    this.expiredWarnings.clear();
    const agentDirectory = this.getAgentDirectory();
    const settingsManager = SettingsManager.create(context.cwd, agentDirectory, {
      projectTrusted: context.isProjectTrusted(),
    });
    const settings = resolveGitCheckpointsSettings(settingsManager);
    this.retentionDays = settings.retentionDays;
    if (settings.warnings.length > 0)
      notify(context, `settings: ${settings.warnings.join("; ")}`, "warning");

    try {
      const store = await initializeGitCheckpointStore({
        agentDirectory,
        sessionId: context.sessionManager.getSessionId(),
        startingDirectory: context.cwd,
      });
      this.store = store;
      const identity = {
        checkpointScope: store.checkpointScopeId,
        mode: store.mode,
        sessionId: context.sessionManager.getSessionId(),
      } satisfies GitCheckpointHistoryIdentity;
      this.identity = identity;
      try {
        const undoState = replayGitCheckpointUndo(context.sessionManager.getBranch(), identity);
        if (undoState === undefined) {
          await store.migrateLegacyUndo((record) =>
            this.pi.appendEntry(GIT_CHECKPOINT_UNDO_ENTRY_TYPE, undoEntryPayload(identity, record)),
          );
        } else {
          await store.migrateLegacyUndo();
        }
      } catch (cause) {
        notify(context, `legacy undo migration failed: ${errorMessage(cause)}`, "warning");
      }
      void cleanupGitCheckpointStores({
        agentDirectory,
        currentStoreDirectory: store.storeDirectory,
        retentionDays: settings.retentionDays,
      })
        .then((failures) => {
          if (failures.length > 0)
            console.warn(`${PACKAGE_PREFIX} cleanup: ${failures.join("; ")}`);
        })
        .catch((cause: unknown) =>
          console.warn(`${PACKAGE_PREFIX} cleanup: ${errorMessage(cause)}`),
        );
    } catch (cause) {
      this.disabledReason = errorMessage(cause);
      this.warnFailure(context, this.disabledReason);
    }
  }

  private warnFailure(context: ExtensionContext, reason: string): void {
    if (this.failureNotified) return;
    this.failureNotified = true;
    notify(context, `checkpointing disabled: ${reason}`, "error");
  }

  private disable(context: ExtensionContext, cause: unknown): void {
    this.disabledReason = errorMessage(cause);
    this.currentStep = undefined;
    this.pendingRestore = undefined;
    this.warnFailure(context, this.disabledReason);
  }

  private async startModelStep(event: TurnStartEvent, context: ExtensionContext): Promise<void> {
    const store = this.store;
    const identity = this.identity;
    if (!store || !identity || this.disabledReason) return;
    try {
      const capture = await store.capture(context.signal);
      const stepId = `${event.turnIndex}-${randomUUID()}`;
      this.pi.appendEntry(GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE, {
        version: 1,
        session_id: identity.sessionId,
        checkpoint_scope: identity.checkpointScope,
        mode: identity.mode,
        step_id: stepId,
        tree_id: capture.treeId,
        source_state: sourceState(capture.sourceHead),
      } satisfies ModelStepStartEntryPayload);
      const startEntryId = context.sessionManager.getLeafId();
      if (startEntryId === null) throw new Error("Model Step start entry was not persisted");
      this.currentStep = { capture, startEntryId, stepId };
    } catch (cause) {
      this.disable(context, cause);
    }
  }

  private async endModelStep(event: TurnEndEvent, context: ExtensionContext): Promise<void> {
    const store = this.store;
    const identity = this.identity;
    const step = this.currentStep;
    this.currentStep = undefined;
    if (!store || !identity || !step || this.disabledReason) return;
    try {
      const capture = await store.capture(context.signal);
      const changes = await store.compareTrees(
        step.capture.treeId,
        capture.treeId,
        undefined,
        context.signal,
      );
      const resultLeafId = context.sessionManager.getLeafId();
      this.pi.appendEntry(GIT_CHECKPOINT_MODEL_STEP_END_ENTRY_TYPE, {
        version: 1,
        session_id: identity.sessionId,
        checkpoint_scope: identity.checkpointScope,
        mode: identity.mode,
        step_id: step.stepId,
        start_entry_id: step.startEntryId,
        result_leaf_id: resultLeafId,
        tree_id: capture.treeId,
        source_state: sourceState(capture.sourceHead),
        changed_paths: [...new Set(changes.map(({ path }) => path))].toSorted(),
        skipped_paths: [...capture.skippedPaths],
        tool_call_ids: [...new Set(event.toolResults.map(({ toolCallId }) => toolCallId))],
      } satisfies ModelStepEndEntryPayload);
    } catch (cause) {
      this.disable(context, cause);
    }
  }

  private async beforeTree(event: SessionBeforeTreeEvent, context: ExtensionContext) {
    this.pendingRestore = undefined;
    const store = this.store;
    const identity = this.identity;
    if (!store || !identity || this.disabledReason) return;
    try {
      const history = replayGitCheckpointHistory(context.sessionManager.getEntries(), identity);
      const plan = planGitCheckpointNavigation(history, {
        oldLeafId: event.preparation.oldLeafId,
        selectedTargetId: event.preparation.targetId,
      });
      if (plan.kind !== "ready" || plan.changedPaths.length === 0) return;
      const approvalCapture = await store.capture(event.signal);
      let differences;
      try {
        differences = await store.compareTrees(
          plan.targetCheckpoint.targetTreeId,
          approvalCapture.treeId,
          plan.changedPaths,
          event.signal,
        );
      } catch (cause) {
        if (!this.expiredWarnings.has(plan.targetCheckpoint.targetTreeId)) {
          this.expiredWarnings.add(plan.targetCheckpoint.targetTreeId);
          notify(context, `Target Checkpoint is unavailable: ${errorMessage(cause)}`, "warning");
        }
        return;
      }
      if (differences.length === 0 || !context.hasUI) return;
      const targetHead = persistedTargetHead(context, plan.targetCheckpoint.endEntryId);
      const liveHead =
        approvalCapture.sourceHead.kind === "head" ? approvalCapture.sourceHead.commit : undefined;
      const headWarning =
        targetHead && liveHead && targetHead !== liveHead
          ? `Repository HEAD differs from the Target Checkpoint (${liveHead.slice(0, 12)} vs ${targetHead.slice(0, 12)}); the branch will not change.`
          : undefined;
      const choice = await context.ui.select(
        `${PACKAGE_PREFIX}: Restore Worktree Checkpoint?\n${previewText(differences, plan.skippedPaths.length, headWarning)}`,
        [RESTORE_CHOICE, KEEP_CHOICE, CANCEL_CHOICE],
        { signal: event.signal },
      );
      if (choice === CANCEL_CHOICE) return { cancel: true as const };
      if (choice !== RESTORE_CHOICE) return;
      this.pendingRestore = {
        oldLeafId: event.preparation.oldLeafId,
        selectedTargetId: event.preparation.targetId,
        paths: differences.map(({ path }) => path),
        targetTreeId: plan.targetCheckpoint.targetTreeId,
        approvalTreeId: approvalCapture.treeId,
      };
    } catch (cause) {
      if (store.lastCaptureFailure) this.disable(context, cause);
      else notify(context, `navigation preview failed: ${errorMessage(cause)}`, "warning");
    }
  }

  private async afterTree(event: SessionTreeEvent, context: ExtensionContext): Promise<void> {
    const intent = this.pendingRestore;
    this.pendingRestore = undefined;
    const store = this.store;
    const identity = this.identity;
    if (
      !intent ||
      !store ||
      !identity ||
      event.oldLeafId !== intent.oldLeafId ||
      this.disabledReason
    )
      return;
    try {
      const safetyCapture = await store.capture(context.signal);
      const stale = await store.compareTrees(
        intent.approvalTreeId,
        safetyCapture.treeId,
        intent.paths,
        context.signal,
      );
      if (stale.length > 0) {
        notify(
          context,
          `Restore skipped because approved paths changed: ${stale.map(({ path }) => path).join(", ")}`,
          "warning",
        );
        return;
      }
      const restoreInput = {
        paths: intent.paths,
        safetyTreeId: safetyCapture.treeId,
        saveUndoRecord: (record: GitCheckpointUndoRecord) =>
          this.appendUndoEntry(context, identity, record),
        targetTreeId: intent.targetTreeId,
      };
      const result = context.signal
        ? await store.restore({ ...restoreInput, signal: context.signal })
        : await store.restore(restoreInput);
      notify(context, `restored ${result.restoredPaths.length} path(s) after navigation`, "info");
    } catch (cause) {
      if (store.lastCaptureFailure) {
        this.disable(context, cause);
        return;
      }
      const unrecovered =
        cause instanceof GitCheckpointStoreError && cause.unrecoveredPaths.length > 0
          ? `; unrecovered paths: ${cause.unrecoveredPaths.join(", ")}`
          : "";
      notify(context, `Restore failed: ${errorMessage(cause)}${unrecovered}`, "error");
    }
  }

  private statusText(context: ExtensionContext): string {
    const store = this.store;
    const identity = this.identity;
    const failure = this.disabledReason ?? store?.lastCaptureFailure;
    const count = identity
      ? replayGitCheckpointHistory(context.sessionManager.getEntries(), identity).checkpoints.length
      : 0;
    if (!store || !identity || failure) {
      return `${PACKAGE_PREFIX}: disabled\nModel Steps: ${count}\nRetention: ${this.retentionDays} day(s)\nLast capture failure: ${failure ?? "not initialized"}\nUndo: unavailable`;
    }
    return `${PACKAGE_PREFIX}: active ${store.mode}\nModel Steps: ${count}\nStore: ${store.storeDirectory}\nRetention: ${this.retentionDays} day(s)\nLast capture failure: ${store.lastCaptureFailure ?? "none"}`;
  }

  private async command(arguments_: string, context: ExtensionCommandContext): Promise<void> {
    const action = arguments_.trim();
    if (action === "" || action === "status") {
      let text = this.statusText(context);
      const store = this.store;
      const identity = this.identity;
      if (store && identity && !this.disabledReason && !store.lastCaptureFailure) {
        const undo = await store
          .inspectUndo(
            () =>
              replayGitCheckpointUndo(context.sessionManager.getBranch(), identity) ?? undefined,
            context.signal,
          )
          .catch(() => ({ kind: "unavailable" as const }));
        text += `\nUndo: ${undo.kind === "ready" ? "available" : "unavailable"}`;
      }
      if (action === "") text += `\n${COMMAND_USAGE}`;
      notify(context, text.replace(`${PACKAGE_PREFIX}: `, ""), "info");
      return;
    }
    if (action !== "undo") {
      notify(context, COMMAND_USAGE, "warning");
      return;
    }
    const store = this.store;
    const identity = this.identity;
    if (!store || !identity || this.disabledReason || store.lastCaptureFailure) {
      notify(context, "undo unavailable while checkpointing is disabled", "warning");
      return;
    }
    try {
      const readUndoRecord = () =>
        replayGitCheckpointUndo(context.sessionManager.getBranch(), identity) ?? undefined;
      const inspection = await store.inspectUndo(readUndoRecord, context.signal);
      if (inspection.kind === "unavailable") {
        notify(context, "undo unavailable", "warning");
        return;
      }
      let allowDiverged = inspection.divergedPaths.length === 0;
      if (!allowDiverged) {
        if (!context.hasUI) {
          notify(
            context,
            `undo refused because paths diverged: ${inspection.divergedPaths.join(", ")}`,
            "warning",
          );
          return;
        }
        allowDiverged = await context.ui.confirm(
          `${PACKAGE_PREFIX}: Undo diverged Restore?`,
          inspection.divergedPaths.join("\n"),
        );
        if (!allowDiverged) return;
      }
      const undoInput = {
        allowDiverged,
        consumeUndoRecord: () => this.appendUndoEntry(context, identity, null),
        readUndoRecord,
      };
      const result = context.signal
        ? await store.undo({ ...undoInput, signal: context.signal })
        : await store.undo(undoInput);
      if (result.kind === "undone")
        notify(context, `undo restored ${result.restoredPaths.length} path(s)`, "info");
      else if (result.kind === "diverged")
        notify(
          context,
          `undo refused because paths diverged: ${result.paths.join(", ")}`,
          "warning",
        );
      else notify(context, "undo unavailable", "warning");
    } catch (cause) {
      if (store.lastCaptureFailure) this.disable(context, cause);
      else notify(context, `undo failed: ${errorMessage(cause)}`, "error");
    }
  }

  private async shutdownSession(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    this.identity = undefined;
    this.currentStep = undefined;
    this.pendingRestore = undefined;
    if (store) await store.shutdown().catch(() => undefined);
  }
}

/** Creates the Git Checkpoints extension with a narrow agent-directory seam for tests. */
export function createPiGitCheckpointsExtension(
  getAgentDirectory: () => string = getAgentDir,
): (pi: ExtensionAPI) => void {
  return (pi) => new PiGitCheckpointsLifecycle(pi, getAgentDirectory).register();
}

/** Registers Git-backed Worktree Checkpoints at Pi lifecycle boundaries. */
export default createPiGitCheckpointsExtension();
