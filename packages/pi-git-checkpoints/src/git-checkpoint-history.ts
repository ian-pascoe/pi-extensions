import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GitCheckpointMode, GitCheckpointUndoRecord } from "./git-checkpoint-store.js";

export type { GitCheckpointMode } from "./git-checkpoint-store.js";

/** Custom session entry type for the Worktree Checkpoint captured before a Model Step. */
export const GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE = "pi-git-checkpoints.model-step-start";
/** Custom session entry type for the Worktree Checkpoint captured after a Model Step. */
export const GIT_CHECKPOINT_MODEL_STEP_END_ENTRY_TYPE = "pi-git-checkpoints.model-step-end";
/** Custom session entry type for active-branch Restore undo state. */
export const GIT_CHECKPOINT_UNDO_ENTRY_TYPE = "pi-git-checkpoints.undo";

const strictObject = { additionalProperties: false } as const;
const CheckpointModeSchema = Type.Union([Type.Literal("repository"), Type.Literal("standalone")]);
const CheckpointTreeIdSchema = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const SourceStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal("commit"), head: CheckpointTreeIdSchema }, strictObject),
  Type.Object({ kind: Type.Literal("unborn") }, strictObject),
  Type.Object({ kind: Type.Literal("standalone") }, strictObject),
]);
const CheckpointPathArraySchema = Type.Array(Type.String({ minLength: 1 }), {
  uniqueItems: true,
});

/** Strict version-one payload schema for a Model Step start checkpoint entry. */
export const ModelStepStartEntryPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    session_id: Type.String({ minLength: 1 }),
    checkpoint_scope: Type.String({ minLength: 1 }),
    mode: CheckpointModeSchema,
    step_id: Type.String({ minLength: 1 }),
    tree_id: CheckpointTreeIdSchema,
    source_state: SourceStateSchema,
  },
  strictObject,
);

/** Strict version-one payload schema for a Model Step end checkpoint entry. */
export const ModelStepEndEntryPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    session_id: Type.String({ minLength: 1 }),
    checkpoint_scope: Type.String({ minLength: 1 }),
    mode: CheckpointModeSchema,
    step_id: Type.String({ minLength: 1 }),
    start_entry_id: Type.String({ minLength: 1 }),
    result_leaf_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    tree_id: CheckpointTreeIdSchema,
    source_state: SourceStateSchema,
    changed_paths: CheckpointPathArraySchema,
    skipped_paths: CheckpointPathArraySchema,
    tool_call_ids: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  },
  strictObject,
);

/** Strict version-one payload schema for recorded or consumed Restore undo state. */
export const GitCheckpointUndoEntryPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    session_id: Type.String({ minLength: 1 }),
    checkpoint_scope: Type.String({ minLength: 1 }),
    mode: CheckpointModeSchema,
    record: Type.Union([
      Type.Object(
        {
          paths: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            uniqueItems: true,
          }),
          restored_tree_id: CheckpointTreeIdSchema,
          safety_tree_id: CheckpointTreeIdSchema,
        },
        strictObject,
      ),
      Type.Null(),
    ]),
  },
  strictObject,
);

/** Persisted payload captured before one complete Model Step. */
export type ModelStepStartEntryPayload = Static<typeof ModelStepStartEntryPayloadSchema>;
/** Persisted payload captured after one complete Model Step and tool batch. */
export type ModelStepEndEntryPayload = Static<typeof ModelStepEndEntryPayloadSchema>;
/** Persisted active-branch Restore undo record or consumed tombstone. */
export type GitCheckpointUndoEntryPayload = Static<typeof GitCheckpointUndoEntryPayloadSchema>;
/** Identity required to exclude foreign and inherited Worktree Checkpoint records. */
export type GitCheckpointHistoryIdentity = {
  readonly sessionId: string;
  readonly checkpointScope: string;
  readonly mode: GitCheckpointMode;
};

/** One validated and paired Model Step reconstructed from custom session entries. */
export type ModelStepCheckpoint = {
  readonly stepId: string;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly resultLeafId: string | null;
  readonly targetTreeId: string;
  readonly changedPaths: readonly string[];
  readonly skippedPaths: readonly string[];
  readonly toolCallIds: readonly string[];
};

/** Validated checkpoint records plus their owning Pi session tree. */
export type GitCheckpointHistory = {
  readonly checkpoints: readonly ModelStepCheckpoint[];
  readonly entries: readonly SessionEntry[];
};

/** Input needed to resolve a Pi tree selection into a Navigation Transition. */
export type GitCheckpointNavigationInput = {
  readonly oldLeafId: string | null;
  readonly selectedTargetId: string;
};

/** Pure Navigation Transition plan or an explicit reason no Target Checkpoint is usable. */
export type GitCheckpointNavigationPlan =
  | {
      readonly kind: "ready";
      readonly selectedTargetId: string;
      readonly targetPositionId: string | null;
      readonly commonAncestorId: string | null;
      readonly targetCheckpoint: ModelStepCheckpoint;
      readonly changedPaths: readonly string[];
      readonly skippedPaths: readonly string[];
    }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "selected-target-missing"
        | "current-checkpoint-missing"
        | "target-checkpoint-missing";
      readonly targetPositionId?: string | null;
      readonly targetCheckpoint?: ModelStepCheckpoint;
    };

/** One live-versus-target path difference shown before Restore. */
export type GitCheckpointPathDifference = {
  readonly status: "A" | "M" | "D";
  readonly path: string;
};

/** Bounded, deterministic Restore preview for the confirmation UI. */
export type GitCheckpointPreview = {
  readonly total: number;
  readonly items: readonly GitCheckpointPathDifference[];
  readonly hidden: number;
  readonly skipped: number;
};

function sourceStateMatchesMode(
  mode: GitCheckpointMode,
  sourceState: ModelStepStartEntryPayload["source_state"],
): boolean {
  return mode === "standalone"
    ? sourceState.kind === "standalone"
    : sourceState.kind !== "standalone";
}

function isNormalizedCheckpointPath(path: string): boolean {
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function payloadMatchesIdentity(
  payload: ModelStepStartEntryPayload | ModelStepEndEntryPayload,
  identity: GitCheckpointHistoryIdentity,
): boolean {
  return (
    payload.session_id === identity.sessionId &&
    payload.checkpoint_scope === identity.checkpointScope &&
    payload.mode === identity.mode &&
    sourceStateMatchesMode(payload.mode, payload.source_state)
  );
}

function isStartEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" }> & { data: ModelStepStartEntryPayload } {
  return (
    entry.type === "custom" &&
    entry.customType === GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE &&
    Value.Check(ModelStepStartEntryPayloadSchema, entry.data)
  );
}

function isEndEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" }> & { data: ModelStepEndEntryPayload } {
  return (
    entry.type === "custom" &&
    entry.customType === GIT_CHECKPOINT_MODEL_STEP_END_ENTRY_TYPE &&
    Value.Check(ModelStepEndEntryPayloadSchema, entry.data) &&
    entry.data.changed_paths.every(isNormalizedCheckpointPath) &&
    entry.data.skipped_paths.every(isNormalizedCheckpointPath)
  );
}

function isUndoEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> & {
  data: GitCheckpointUndoEntryPayload;
} {
  return (
    entry.type === "custom" &&
    entry.customType === GIT_CHECKPOINT_UNDO_ENTRY_TYPE &&
    Value.Check(GitCheckpointUndoEntryPayloadSchema, entry.data) &&
    (entry.data.record === null || entry.data.record.paths.every(isNormalizedCheckpointPath))
  );
}

/** Replays one ordered Pi session branch; null is a consumed tombstone. */
export function replayGitCheckpointUndo(
  entries: readonly SessionEntry[],
  identity: GitCheckpointHistoryIdentity,
): GitCheckpointUndoRecord | null | undefined {
  let undoRecord: GitCheckpointUndoRecord | null | undefined;
  for (const entry of entries) {
    if (
      !isUndoEntry(entry) ||
      entry.data.session_id !== identity.sessionId ||
      entry.data.checkpoint_scope !== identity.checkpointScope ||
      entry.data.mode !== identity.mode
    ) {
      continue;
    }
    undoRecord = entry.data.record
      ? {
          paths: entry.data.record.paths,
          restoredTreeId: entry.data.record.restored_tree_id,
          safetyTreeId: entry.data.record.safety_tree_id,
        }
      : null;
  }
  return undoRecord;
}

/** Replays only strict, current-session start/end pairs from the complete Pi session tree. */
export function replayGitCheckpointHistory(
  entries: readonly SessionEntry[],
  identity: GitCheckpointHistoryIdentity,
): GitCheckpointHistory {
  const starts = new Map<string, ModelStepStartEntryPayload>();
  for (const entry of entries) {
    if (isStartEntry(entry) && payloadMatchesIdentity(entry.data, identity))
      starts.set(entry.id, entry.data);
  }

  const pairedStarts = new Set<string>();
  const checkpoints: ModelStepCheckpoint[] = [];
  for (const entry of entries) {
    if (!isEndEntry(entry) || !payloadMatchesIdentity(entry.data, identity)) continue;
    const start = starts.get(entry.data.start_entry_id);
    if (
      start === undefined ||
      pairedStarts.has(entry.data.start_entry_id) ||
      start.step_id !== entry.data.step_id ||
      entry.parentId !== entry.data.result_leaf_id
    ) {
      continue;
    }
    pairedStarts.add(entry.data.start_entry_id);
    checkpoints.push({
      stepId: entry.data.step_id,
      startEntryId: entry.data.start_entry_id,
      endEntryId: entry.id,
      resultLeafId: entry.data.result_leaf_id,
      targetTreeId: entry.data.tree_id,
      changedPaths: entry.data.changed_paths,
      skippedPaths: entry.data.skipped_paths,
      toolCallIds: entry.data.tool_call_ids,
    });
  }
  return { checkpoints, entries: [...entries] };
}

function selectedTargetPosition(entry: SessionEntry): string | null {
  if (entry.type === "custom_message") return entry.parentId;
  if (entry.type === "message" && entry.message.role === "user") return entry.parentId;
  return entry.id;
}

function createEntryIndex(entries: readonly SessionEntry[]): Map<string, SessionEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function findCheckpointAtPosition(
  positionId: string | null,
  checkpoints: readonly ModelStepCheckpoint[],
  entriesById: ReadonlyMap<string, SessionEntry>,
): ModelStepCheckpoint | undefined {
  const byEndEntry = new Map(checkpoints.map((checkpoint) => [checkpoint.endEntryId, checkpoint]));
  const byResultLeaf = new Map(
    checkpoints.flatMap((checkpoint) =>
      checkpoint.resultLeafId === null ? [] : [[checkpoint.resultLeafId, checkpoint] as const],
    ),
  );
  let entryId = positionId;
  const visited = new Set<string>();
  while (entryId !== null && !visited.has(entryId)) {
    visited.add(entryId);
    const checkpoint = byEndEntry.get(entryId) ?? byResultLeaf.get(entryId);
    if (checkpoint !== undefined) return checkpoint;
    const entry = entriesById.get(entryId);
    if (entry === undefined) return undefined;
    entryId = entry.parentId;
  }
  return undefined;
}

function findTargetCheckpoint(
  selectedEntry: SessionEntry,
  targetPositionId: string | null,
  history: GitCheckpointHistory,
  entriesById: ReadonlyMap<string, SessionEntry>,
): ModelStepCheckpoint | undefined {
  if (selectedEntry.type === "message" && selectedEntry.message.role === "toolResult") {
    const toolCallId = selectedEntry.message.toolCallId;
    const toolCheckpoint = history.checkpoints.findLast((checkpoint) =>
      checkpoint.toolCallIds.includes(toolCallId),
    );
    if (toolCheckpoint !== undefined) return toolCheckpoint;
  }
  return findCheckpointAtPosition(targetPositionId, history.checkpoints, entriesById);
}

function ancestryIds(
  leafId: string | null,
  entriesById: ReadonlyMap<string, SessionEntry>,
): readonly string[] {
  const ancestry: string[] = [];
  const visited = new Set<string>();
  let entryId = leafId;
  while (entryId !== null && !visited.has(entryId)) {
    visited.add(entryId);
    ancestry.push(entryId);
    const entry = entriesById.get(entryId);
    if (entry === undefined) break;
    entryId = entry.parentId;
  }
  return ancestry;
}

function findCommonAncestor(
  leftId: string | null,
  rightId: string | null,
  entriesById: ReadonlyMap<string, SessionEntry>,
): string | null {
  const leftAncestors = new Set(ancestryIds(leftId, entriesById));
  return ancestryIds(rightId, entriesById).find((entryId) => leftAncestors.has(entryId)) ?? null;
}

function transitionCheckpoints(
  current: ModelStepCheckpoint,
  target: ModelStepCheckpoint,
  checkpoints: readonly ModelStepCheckpoint[],
  entriesById: ReadonlyMap<string, SessionEntry>,
): readonly ModelStepCheckpoint[] {
  const commonCheckpointAncestor = findCommonAncestor(
    current.endEntryId,
    target.endEntryId,
    entriesById,
  );
  const transitionEntryIds = new Set<string>();
  for (const leafId of [current.endEntryId, target.endEntryId]) {
    for (const entryId of ancestryIds(leafId, entriesById)) {
      if (entryId === commonCheckpointAncestor) break;
      transitionEntryIds.add(entryId);
    }
  }
  return checkpoints.filter((checkpoint) => transitionEntryIds.has(checkpoint.endEntryId));
}

function sortedUniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function pathIsSkipped(path: string, skippedPaths: readonly string[]): boolean {
  return skippedPaths.some(
    (skippedPath) => path === skippedPath || path.startsWith(`${skippedPath}/`),
  );
}

/** Maps Pi selection semantics and ancestry to one deterministic Target Checkpoint/path plan. */
export function planGitCheckpointNavigation(
  history: GitCheckpointHistory,
  input: GitCheckpointNavigationInput,
): GitCheckpointNavigationPlan {
  const entriesById = createEntryIndex(history.entries);
  const selectedEntry = entriesById.get(input.selectedTargetId);
  if (selectedEntry === undefined)
    return { kind: "unavailable", reason: "selected-target-missing" };

  const targetPositionId = selectedTargetPosition(selectedEntry);
  const targetCheckpoint = findTargetCheckpoint(
    selectedEntry,
    targetPositionId,
    history,
    entriesById,
  );
  if (targetCheckpoint === undefined) {
    return { kind: "unavailable", reason: "target-checkpoint-missing", targetPositionId };
  }
  const currentCheckpoint = findCheckpointAtPosition(
    input.oldLeafId,
    history.checkpoints,
    entriesById,
  );
  if (currentCheckpoint === undefined) {
    return {
      kind: "unavailable",
      reason: "current-checkpoint-missing",
      targetPositionId,
      targetCheckpoint,
    };
  }
  const crossedCheckpoints = transitionCheckpoints(
    currentCheckpoint,
    targetCheckpoint,
    history.checkpoints,
    entriesById,
  );
  const skippedPaths = sortedUniquePaths([
    ...crossedCheckpoints.flatMap(({ skippedPaths }) => skippedPaths),
    ...targetCheckpoint.skippedPaths,
  ]);
  return {
    kind: "ready",
    selectedTargetId: input.selectedTargetId,
    targetPositionId,
    commonAncestorId: findCommonAncestor(input.oldLeafId, targetPositionId, entriesById),
    targetCheckpoint,
    changedPaths: sortedUniquePaths(
      crossedCheckpoints
        .flatMap(({ changedPaths }) => changedPaths)
        .filter((path) => !pathIsSkipped(path, skippedPaths)),
    ),
    skippedPaths,
  };
}

/** Sorts Restore differences by A/M/D then path and retains only the first 20. */
export function createGitCheckpointPreview(
  differences: readonly GitCheckpointPathDifference[],
  skipped: number,
): GitCheckpointPreview {
  const statusOrder = "AMD";
  const sorted = [...differences].sort((left, right) => {
    const statusDifference = statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status);
    if (statusDifference !== 0) return statusDifference;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  return {
    total: sorted.length,
    items: sorted.slice(0, 20),
    hidden: Math.max(0, sorted.length - 20),
    skipped,
  };
}
