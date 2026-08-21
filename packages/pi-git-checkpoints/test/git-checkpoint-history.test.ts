import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  GIT_CHECKPOINT_MODEL_STEP_END_ENTRY_TYPE,
  GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE,
  createGitCheckpointPreview,
  planGitCheckpointNavigation,
  replayGitCheckpointHistory,
  type GitCheckpointHistoryIdentity,
  type ModelStepEndEntryPayload,
  type ModelStepStartEntryPayload,
} from "../src/git-checkpoint-history.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function checkpointTreeId(label: string): string {
  return createHash("sha1").update(label).digest("hex");
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResultMessage(toolCallId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test-tool",
    content: [{ type: "text", text: toolCallId }],
    isError: false,
    timestamp: Date.now(),
  };
}

function createHistorySession() {
  const sessionManager = SessionManager.inMemory("/checkpoint-workspace");
  const identity: GitCheckpointHistoryIdentity = {
    sessionId: sessionManager.getSessionId(),
    checkpointScope: "scope-1",
    mode: "standalone",
  };
  return { sessionManager, identity };
}

function startPayload(
  identity: GitCheckpointHistoryIdentity,
  stepId: string,
  treeId: string,
): ModelStepStartEntryPayload {
  return {
    version: 1,
    session_id: identity.sessionId,
    checkpoint_scope: identity.checkpointScope,
    mode: identity.mode,
    step_id: stepId,
    tree_id: checkpointTreeId(treeId),
    source_state: { kind: "standalone" },
  };
}

function appendModelStep(
  sessionManager: SessionManager,
  identity: GitCheckpointHistoryIdentity,
  options: {
    stepId: string;
    startTree: string;
    endTree: string;
    changedPaths: string[];
    skippedPaths?: string[];
    toolCallIds?: string[];
  },
) {
  const startEntryId = sessionManager.appendCustomEntry(
    GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE,
    startPayload(identity, options.stepId, options.startTree),
  );
  const assistantId = sessionManager.appendMessage(assistantMessage(options.stepId));
  const toolResultIds = (options.toolCallIds ?? []).map((toolCallId) =>
    sessionManager.appendMessage(toolResultMessage(toolCallId)),
  );
  const resultLeafId = sessionManager.getLeafId();
  if (resultLeafId === null) throw new Error("History test expected a Model Step result leaf");
  const endPayload: ModelStepEndEntryPayload = {
    version: 1,
    session_id: identity.sessionId,
    checkpoint_scope: identity.checkpointScope,
    mode: identity.mode,
    step_id: options.stepId,
    start_entry_id: startEntryId,
    result_leaf_id: resultLeafId,
    tree_id: checkpointTreeId(options.endTree),
    source_state: { kind: "standalone" },
    changed_paths: options.changedPaths,
    skipped_paths: options.skippedPaths ?? [],
    tool_call_ids: options.toolCallIds ?? [],
  };
  const endEntryId = sessionManager.appendCustomEntry(
    GIT_CHECKPOINT_MODEL_STEP_END_ENTRY_TYPE,
    endPayload,
  );
  return { startEntryId, assistantId, toolResultIds, resultLeafId, endEntryId };
}

function replay(sessionManager: SessionManager, identity: GitCheckpointHistoryIdentity) {
  return replayGitCheckpointHistory(sessionManager.getEntries(), identity);
}

describe("persisted Worktree Checkpoint history", () => {
  test("replays strict paired Model Step entries including identical trees and a parallel tool batch", () => {
    const { sessionManager, identity } = createHistorySession();
    sessionManager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
    const step = appendModelStep(sessionManager, identity, {
      stepId: "step-1",
      startTree: "same-tree",
      endTree: "same-tree",
      changedPaths: [],
      toolCallIds: ["call-a", "call-b"],
    });

    const history = replay(sessionManager, identity);

    expect(history.checkpoints).toHaveLength(1);
    expect(history.checkpoints[0]).toMatchObject({
      stepId: "step-1",
      startEntryId: step.startEntryId,
      endEntryId: step.endEntryId,
      resultLeafId: step.resultLeafId,
      targetTreeId: checkpointTreeId("same-tree"),
      toolCallIds: ["call-a", "call-b"],
    });
    for (const toolResultId of step.toolResultIds) {
      const plan = planGitCheckpointNavigation(history, {
        oldLeafId: step.endEntryId,
        selectedTargetId: toolResultId,
      });
      expect(plan.kind === "ready" && plan.targetCheckpoint.stepId).toBe("step-1");
    }
  });

  test("ignores malformed, unsupported, foreign, inherited, scope-mismatched, mode-mismatched, and unpaired records", () => {
    const { sessionManager, identity } = createHistorySession();
    sessionManager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
    const valid = appendModelStep(sessionManager, identity, {
      stepId: "valid",
      startTree: "tree-0",
      endTree: "tree-1",
      changedPaths: ["src/valid.ts"],
    });
    sessionManager.appendCustomEntry(GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE, { nope: true });
    sessionManager.appendCustomEntry(GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE, {
      ...startPayload(identity, "unsupported", "tree"),
      version: 2,
    });
    for (const [stepId, override] of [
      ["foreign", { session_id: "another-session" }],
      ["inherited", { session_id: "source-session" }],
      ["scope", { checkpoint_scope: "another-scope" }],
      ["mode", { mode: "repository", source_state: { kind: "unborn" } }],
    ] as const) {
      sessionManager.appendCustomEntry(GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE, {
        ...startPayload(identity, stepId, "tree"),
        ...override,
      });
    }
    sessionManager.appendCustomEntry(
      GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE,
      startPayload(identity, "missing-end", "tree"),
    );
    const badPathStart = sessionManager.appendCustomEntry(
      GIT_CHECKPOINT_MODEL_STEP_START_ENTRY_TYPE,
      startPayload(identity, "bad-path", "tree"),
    );
    const badPathResult = sessionManager.appendMessage(assistantMessage("bad path"));
    sessionManager.appendCustomEntry(GIT_CHECKPOINT_MODEL_STEP_END_ENTRY_TYPE, {
      version: 1,
      session_id: identity.sessionId,
      checkpoint_scope: identity.checkpointScope,
      mode: identity.mode,
      step_id: "bad-path",
      start_entry_id: badPathStart,
      result_leaf_id: badPathResult,
      tree_id: checkpointTreeId("tree"),
      source_state: { kind: "standalone" },
      changed_paths: ["../escape"],
      skipped_paths: [],
      tool_call_ids: [],
    });

    expect(replay(sessionManager, identity).checkpoints).toEqual([
      expect.objectContaining({ stepId: "valid", endEntryId: valid.endEntryId }),
    ]);
  });
});

describe("Target Checkpoint mapping", () => {
  test("maps user and custom-message selections to their parent checkpoint", () => {
    const { sessionManager, identity } = createHistorySession();
    sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const first = appendModelStep(sessionManager, identity, {
      stepId: "first",
      startTree: "tree-0",
      endTree: "tree-1",
      changedPaths: ["first.ts"],
    });
    const userId = sessionManager.appendMessage({
      role: "user",
      content: "second",
      timestamp: Date.now(),
    });
    const customMessageId = sessionManager.appendCustomMessageEntry(
      "test-context",
      "context",
      false,
    );
    const history = replay(sessionManager, identity);

    for (const selectedTargetId of [userId, customMessageId]) {
      const plan = planGitCheckpointNavigation(history, {
        oldLeafId: customMessageId,
        selectedTargetId,
      });
      expect(plan.kind === "ready" && plan.targetCheckpoint.endEntryId).toBe(first.endEntryId);
    }
    expect(
      planGitCheckpointNavigation(history, {
        oldLeafId: customMessageId,
        selectedTargetId: userId,
      }),
    ).toMatchObject({ kind: "ready", targetPositionId: first.endEntryId });
  });

  test("maps an assistant result exactly and an assistant inside a tool batch to its preceding checkpoint", () => {
    const { sessionManager, identity } = createHistorySession();
    sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const first = appendModelStep(sessionManager, identity, {
      stepId: "first",
      startTree: "tree-0",
      endTree: "tree-1",
      changedPaths: ["first.ts"],
    });
    sessionManager.appendMessage({ role: "user", content: "tools", timestamp: Date.now() });
    const second = appendModelStep(sessionManager, identity, {
      stepId: "second",
      startTree: "tree-1",
      endTree: "tree-2",
      changedPaths: ["second.ts"],
      toolCallIds: ["parallel-a", "parallel-b"],
    });
    const history = replay(sessionManager, identity);

    const exactAssistant = planGitCheckpointNavigation(history, {
      oldLeafId: second.endEntryId,
      selectedTargetId: first.assistantId,
    });
    expect(exactAssistant.kind === "ready" && exactAssistant.targetCheckpoint.stepId).toBe("first");

    const midBatchAssistant = planGitCheckpointNavigation(history, {
      oldLeafId: second.endEntryId,
      selectedTargetId: second.assistantId,
    });
    expect(midBatchAssistant.kind === "ready" && midBatchAssistant.targetCheckpoint.stepId).toBe(
      "first",
    );
  });

  test("reports unavailable selected and root Target Checkpoints", () => {
    const { sessionManager, identity } = createHistorySession();
    const rootUserId = sessionManager.appendMessage({
      role: "user",
      content: "root",
      timestamp: Date.now(),
    });
    const step = appendModelStep(sessionManager, identity, {
      stepId: "first",
      startTree: "tree-0",
      endTree: "tree-1",
      changedPaths: ["first.ts"],
      skippedPaths: ["large.bin"],
    });
    const history = replay(sessionManager, identity);

    expect(
      planGitCheckpointNavigation(history, {
        oldLeafId: step.endEntryId,
        selectedTargetId: "missing-entry",
      }),
    ).toEqual({ kind: "unavailable", reason: "selected-target-missing" });
    expect(
      planGitCheckpointNavigation(history, {
        oldLeafId: step.endEntryId,
        selectedTargetId: rootUserId,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "target-checkpoint-missing" });
  });
});

describe("Navigation Transition planning", () => {
  test("plans exact backward, forward, and sideways changed-path unions", () => {
    const { sessionManager, identity } = createHistorySession();
    sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const first = appendModelStep(sessionManager, identity, {
      stepId: "first",
      startTree: "tree-0",
      endTree: "tree-1",
      changedPaths: ["shared.ts", "first.ts"],
    });
    sessionManager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
    const second = appendModelStep(sessionManager, identity, {
      stepId: "second",
      startTree: "tree-1",
      endTree: "tree-2",
      changedPaths: ["shared.ts", "second.ts"],
    });
    sessionManager.branch(first.endEntryId);
    sessionManager.appendMessage({ role: "user", content: "sibling", timestamp: Date.now() });
    const sibling = appendModelStep(sessionManager, identity, {
      stepId: "sibling",
      startTree: "tree-1",
      endTree: "tree-sibling",
      changedPaths: ["shared.ts", "sibling.ts"],
      skippedPaths: ["ignored.log", "sibling.ts"],
    });
    const history = replay(sessionManager, identity);

    expect(
      planGitCheckpointNavigation(history, {
        oldLeafId: second.endEntryId,
        selectedTargetId: first.assistantId,
      }),
    ).toMatchObject({
      kind: "ready",
      commonAncestorId: first.assistantId,
      changedPaths: ["second.ts", "shared.ts"],
    });
    expect(
      planGitCheckpointNavigation(history, {
        oldLeafId: first.endEntryId,
        selectedTargetId: second.assistantId,
      }),
    ).toMatchObject({
      kind: "ready",
      changedPaths: ["second.ts", "shared.ts"],
    });
    expect(
      planGitCheckpointNavigation(history, {
        oldLeafId: second.endEntryId,
        selectedTargetId: sibling.assistantId,
      }),
    ).toMatchObject({
      kind: "ready",
      changedPaths: ["second.ts", "shared.ts"],
      skippedPaths: ["ignored.log", "sibling.ts"],
    });
  });

  test("traverses branch summaries, labels, hidden custom entries, and sibling branches", () => {
    const { sessionManager, identity } = createHistorySession();
    sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const first = appendModelStep(sessionManager, identity, {
      stepId: "first",
      startTree: "tree-0",
      endTree: "tree-1",
      changedPaths: ["first.ts"],
    });
    const labelId = sessionManager.appendLabelChange(first.endEntryId, "bookmark");
    const hiddenId = sessionManager.appendCustomEntry("hidden-state", { ok: true });
    sessionManager.branch(first.endEntryId);
    const summaryId = sessionManager.branchWithSummary(
      first.endEntryId,
      "sibling summary",
      undefined,
      true,
    );
    const history = replay(sessionManager, identity);

    for (const selectedTargetId of [labelId, hiddenId, summaryId]) {
      const plan = planGitCheckpointNavigation(history, {
        oldLeafId: summaryId,
        selectedTargetId,
      });
      expect(plan.kind === "ready" && plan.targetCheckpoint.stepId).toBe("first");
    }
  });
});

test("orders A/M/D Restore preview paths deterministically and truncates after 20", () => {
  const differences = Array.from({ length: 23 }, (_, index) => ({
    status: (["D", "M", "A"] as const)[index % 3] ?? "M",
    path: `path-${String(22 - index).padStart(2, "0")}.ts`,
  }));

  const preview = createGitCheckpointPreview(differences, 3);

  expect(preview.total).toBe(23);
  expect(preview.items).toHaveLength(20);
  expect(preview.hidden).toBe(3);
  expect(preview.skipped).toBe(3);
  expect(preview.items).toEqual(
    [...differences]
      .sort((left, right) =>
        left.status === right.status
          ? left.path < right.path
            ? -1
            : left.path > right.path
              ? 1
              : 0
          : "AMD".indexOf(left.status) - "AMD".indexOf(right.status),
      )
      .slice(0, 20),
  );
});
