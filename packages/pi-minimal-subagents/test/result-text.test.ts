import { describe, expect, it } from "vitest";
import {
  formatAgentMessageResultText,
  formatCancelResultText,
  formatDeleteResultText,
  formatSpawnResultText,
  formatStatusResultText,
  formatWaitResultText,
} from "../src/minimal-subagents-result-text.js";
import type { AgentDetail, SpawnResult } from "../src/minimal-subagents-types.js";

const READ_TOOLS = ["read", "grep", "find", "ls"];
/** A Root Agent's typical Reachable Tools, the capability ceiling of every child it spawns. */
const ROOT_TOOLS = [
  ...READ_TOOLS,
  "bash",
  "edit",
  "write",
  "codemode",
  "tool_search",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_document_symbols",
  "lsp_workspace_symbols",
  "lsp_rename",
  "lsp_code_actions",
  "lsp_apply",
  "lsp_call_hierarchy",
  "terminal_start",
  "terminal_send",
  "terminal_stop",
  "web_search",
  "web_fetch",
];
const USAGE = {
  input: 41_200,
  output: 3_100,
  cacheRead: 120_000,
  cacheWrite: 9_000,
  cacheWrite1h: 0,
  reasoning: 800,
  totalTokens: 173_300,
  cost: { input: 0.0412, output: 0.0465, cacheRead: 0.012, cacheWrite: 0.01125, total: 0.11095 },
};

function idleReadChild(): AgentDetail {
  const task = `Locate where the coordinator settles a cancelled turn and explain how its Delivery Ledger item is pruned. ${"Cite file paths and line numbers for every claim. ".repeat(8)}`;
  const output = `The coordinator settles cancelled turns in settleTurn. ${"It records the result, prunes the ledger item, and notifies the parent. ".repeat(20)}`;
  return {
    agent_id: "explore",
    parent_id: "root",
    model: "anthropic/claude-haiku-5-5",
    thinking_level: "medium",
    state: "idle",
    availability: "available",
    latest_turn: { turn_id: "explore:turn-1", status: "completed" },
    tools: READ_TOOLS,
    elapsed_ms: 48_200,
    latest_activity_at: "2026-01-01T00:00:48.200Z",
    task,
    child_count: 0,
    session_file: "/home/user/.pi/agent/sessions/project/subagents/explore-0123456789abcdef.jsonl",
    launch_contract: {
      role: "small",
      model: "anthropic/claude-haiku-5-5",
      thinking_level: "medium",
      session_context: "omit",
      project_context: "inherit",
      tools: "read",
      ordinary_tools: READ_TOOLS,
      delegation: "none",
    },
    capability_ceiling: ROOT_TOOLS,
    spawn_entry_id: "a1b2c3d4",
    recent_messages: [{ source_agent_id: "explore", turn_id: "explore:turn-1", content: output }],
    recent_activity: Array.from({ length: 12 }, (_, index) =>
      index % 3 === 2
        ? { label: "assistant message", content: output.slice(0, 600), truncated: false }
        : {
            label: index % 3 === 0 ? "tool call grep" : "tool result grep",
            content: `src/minimal-subagents-coordinator.ts:${100 + index}: ${"settleTurn(agent, turnId, result) ".repeat(6)}`,
            truncated: false,
          },
    ),
    latest_result: {
      agent_id: "explore",
      turn_id: "explore:turn-1",
      status: "completed",
      output,
      usage: USAGE,
      elapsed_ms: 48_200,
    },
    missing_dependencies: [],
    usage: USAGE,
  };
}

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

describe("Coordinator Tool result text", () => {
  it("renders an idle read-preset child's status in under a quarter of its pretty JSON", () => {
    const status = { agent: idleReadChild() };
    const text = formatStatusResultText(status);
    const previousText = JSON.stringify(status, null, 2);

    expect(text.length).toBeLessThan(previousText.length / 4);
    // Active tools, grant, and ceiling share one listed copy.
    expect(occurrences(text, READ_TOOLS.join(", "))).toBe(1);
    expect(text).toContain("granted tools: same as active");
    expect(text).toContain("capability ceiling: 24 tools, 20 beyond the grant");
    expect(text).not.toContain("lsp_call_hierarchy");
    // One token/cost total instead of usage breakdowns.
    expect(occurrences(text, "173.3k tokens · $0.11")).toBe(1);
    expect(text).not.toContain("cacheRead");
    expect(text).not.toContain(status.agent.session_file ?? "");
    expect(text).toContain("recent activity (last 3 of 12):");
    expect(text).toContain("Pass verbose: true");
  });

  it("explains how the grant differs from active tools", () => {
    const agent = idleReadChild();
    agent.launch_contract.ordinary_tools = [...READ_TOOLS, "lsp_call_hierarchy"];
    agent.capability_ceiling = agent.launch_contract.ordinary_tools;
    agent.tools = [...READ_TOOLS, "exec_command"];

    const text = formatStatusResultText({ agent });

    expect(text).toContain(
      "granted tools (5): active plus lsp_call_hierarchy (granted but not active: codemode-only or undeclared); minus exec_command (active from a runtime adapter, not granted)",
    );
    expect(text).toContain("capability ceiling: same as granted");
  });

  it("includes the full detail with verbose", () => {
    const agent = idleReadChild();
    const text = formatStatusResultText({ agent }, true);

    expect(text).toContain(agent.task);
    expect(text).toContain(agent.latest_result?.output.trim());
    expect(text).toContain("lsp_call_hierarchy");
    expect(text).toContain(`session file: ${agent.session_file}`);
    expect(text).toContain("recent activity (12):");
    expect(text).toContain("recent messages (1):");
    expect(text).toContain("cache read 120.0k");
    expect(text).not.toContain("Pass verbose: true");
  });

  it("lists direct children one line each", () => {
    const agent = idleReadChild();
    expect(formatStatusResultText({ parent_id: "root", agents: [] })).toBe("root has no children.");
    expect(formatStatusResultText({ parent_id: "root", agents: [agent] })).toBe(
      `1 child of root:\n- explore idle · latest turn explore:turn-1 completed · anthropic/claude-haiku-5-5 (medium) · 48s · task: ${agent.task?.slice(0, 117).trimEnd()}...`,
    );
  });

  it("says when a cancel found no active turn", () => {
    const idle = { agent_id: "child", affected_agent_ids: [], cancelled_turn_ids: [] };
    expect(formatCancelResultText({ ...idle, recursive: false })).toBe(
      "Nothing cancelled: child had no active turn.",
    );
    expect(formatCancelResultText({ ...idle, recursive: true })).toBe(
      "Nothing cancelled: child had no active turn, nor did any descendant.",
    );
    expect(
      formatCancelResultText({
        agent_id: "child",
        recursive: true,
        affected_agent_ids: ["child", "child.leaf"],
        cancelled_turn_ids: ["child:turn-2", "child.leaf:turn-1"],
      }),
    ).toBe("Cancelled 2 active turns: child:turn-2, child.leaf:turn-1; sessions are kept.");
  });

  it("reports deletion in one line plus one line per failure", () => {
    expect(
      formatDeleteResultText({
        agent_id: "child",
        recursive: true,
        deleted_agent_ids: ["child.leaf"],
        trashed_session_files: ["/trash/leaf.jsonl"],
        failures: [{ agent_id: "child", error: "disk full" }],
      }),
    ).toBe("Deleted child.leaf; 1 session file moved to trash.\nfailed: child: disk full");
  });

  it("names the spawn's tool grant without repeating a preset's list", () => {
    const spawned: SpawnResult = {
      agent_id: "explore",
      turn_id: "explore:turn-1",
      status: "running",
      model: "provider/model",
      thinking_level: "low",
      tools: READ_TOOLS,
      delegation: "none",
      warnings: ["Skipped configured tool missing_tool"],
    };
    expect(formatSpawnResultText(spawned, "read")).toBe(
      "Spawned explore (turn explore:turn-1, running) · provider/model (low) · tools: read preset, 4 tools · delegation none\nwarning: Skipped configured tool missing_tool",
    );
    expect(formatSpawnResultText({ ...spawned, warnings: [] }, ["read", "grep", "bash"])).toBe(
      "Spawned explore (turn explore:turn-1, running) · provider/model (low) · tools: your list, 4 tools (+find, +ls; -bash) · delegation none",
    );
  });

  it("reports each agent_message disposition in one line", () => {
    const base = { agent_id: "child", message_id: "m-1" };
    expect(formatAgentMessageResultText({ ...base, disposition: "delivered-via-wait" })).toBe(
      "Message delivered to child through its active wait.",
    );
    expect(formatAgentMessageResultText({ ...base, disposition: "queued" })).toBe(
      "Message queued into child's active turn.",
    );
    expect(
      formatAgentMessageResultText({ ...base, disposition: "started-turn", turn_id: "child:2" }),
    ).toBe("child was idle; the message started turn child:2. Wait on it with subagent_wait.");
    expect(
      formatAgentMessageResultText({ ...base, disposition: "failed", error: "no such agent" }),
    ).toBe("Message to child failed: no such agent");
  });

  it("reports a settled turn's status, elapsed time, usage total, messages, and output", () => {
    expect(
      formatWaitResultText({
        event: "turn",
        agent_id: "child",
        turn_id: "child:1",
        status: "failed",
        output: "",
        error: "provider error",
        usage: USAGE,
        elapsed_ms: 3_500,
        messages: [
          {
            event: "message",
            agent_id: "child",
            turn_id: "child:1",
            message_id: "m-1",
            message: "halfway",
          },
        ],
      }),
    ).toBe(
      "child turn child:1 failed · 3s\nusage: 173.3k tokens · $0.11\nerror: provider error\nMessage from child: halfway\n\n(no output)",
    );
  });

  it("reports a timeout without cancelling", () => {
    expect(
      formatWaitResultText({
        event: "timeout",
        agent_id: "child",
        turn_id: "child:1",
        timeout_ms: 30_000,
        state: "running",
        elapsed_ms: 95_000,
        latest_activity_at: "2026-01-01T00:01:35.000Z",
        total_tokens: 15_200,
        recent_activity_labels: ["tool call read", "reasoning"],
      }),
    ).toBe(
      "Wait timed out after 30s; child is running on turn child:1 and was not cancelled.\nelapsed 1m 35s · last activity 2026-01-01T00:01:35.000Z · 15.2k tokens\nrecent activity: tool call read, reasoning",
    );
  });
});
