import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type MinimalSubagentsRenderTheme,
  renderCoordinatorToolCall,
  renderCoordinatorToolResult,
  renderMinimalSubagentsMessage,
  renderMinimalSubagentsResult,
} from "../src/minimal-subagents-rendering.js";
import {
  createTranscriptRenderCache,
  TranscriptRail,
} from "../src/minimal-subagents-transcript.js";

const plainTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
} satisfies MinimalSubagentsRenderTheme;

const usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
};

function renderLines(component: { render(width: number): string[] }): string {
  return component.render(120).join("\n");
}

beforeAll(() => initTheme("dark"));

const numberedLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n\n");

describe("minimal subagents collapsed previews", () => {
  it("shows the spawn's launch settings and task, previewing long tasks until expanded", () => {
    const args = {
      agent_id: "worker",
      task: numberedLines(12),
      model: "provider/model",
      thinking_level: "medium",
      tools: "read",
      session_context: "inherit",
    };
    const collapsed = renderLines(renderCoordinatorToolCall("subagent", args, plainTheme));
    expect(collapsed).toContain(
      "Subagent worker · provider/model:medium · tools read · context inherit",
    );
    expect(collapsed).toContain("line 5");
    expect(collapsed).not.toContain("line 6");
    expect(collapsed).toMatch(/\.\.\. \(\d+ more lines\)$/m);
    expect(renderLines(renderCoordinatorToolCall("subagent", args, plainTheme, true))).toContain(
      "line 12",
    );
  });

  it("shows the role a spawn named in its call header, launch section, and status", () => {
    const call = renderLines(
      renderCoordinatorToolCall(
        "subagent",
        { agent_id: "worker", task: "Look", role: "explore", thinking_level: "high" },
        plainTheme,
      ),
    );
    expect(call).toContain("Subagent worker · role explore · thinking high");

    const agent = {
      agent_id: "worker",
      state: "running",
      availability: "available",
      child_count: 0,
      tools: ["read"],
      launch_contract: {
        role: "explore",
        model: "provider/fast",
        thinking_level: "low",
        ordinary_tools: ["read"],
      },
    };
    const expanded = { expanded: true, isPartial: false };
    const spawned = renderLines(
      renderCoordinatorToolResult(
        "subagent",
        {
          content: [],
          details: { agent_id: "worker", turn_id: "worker:turn-1", status: "running", agent },
        },
        expanded,
        plainTheme,
        { task: "Look", role: "explore" },
      ),
    );
    expect(spawned).toContain("role explore · model provider/fast · thinking low");
    const status = renderLines(
      renderCoordinatorToolResult(
        "subagent_status",
        { content: [], details: { agent } },
        expanded,
        plainTheme,
        { agent_id: "worker" },
      ),
    );
    expect(status).toContain("role explore · model provider/fast · thinking low");
  });

  it("shows a settled wait's output or error without expanding", () => {
    const completed = renderLines(
      renderCoordinatorToolResult(
        "subagent_wait",
        {
          content: [],
          details: {
            event: "turn",
            agent_id: "worker",
            turn_id: "worker:turn-1",
            status: "completed",
            output: `**Findings**\n\n${numberedLines(12)}`,
            usage,
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        { agent_id: "worker" },
      ),
    );
    expect(completed).toContain("120 tokens  ·  $0.01");
    expect(completed).toContain("Findings");
    expect(completed).not.toContain("**");
    expect(completed).toContain("line 4");
    expect(completed).not.toContain("line 12");
    expect(completed).toMatch(/\.\.\. \(\d+ more lines\)$/m);

    const failed = renderLines(
      renderCoordinatorToolResult(
        "subagent_wait",
        {
          content: [],
          details: {
            event: "turn",
            agent_id: "worker",
            turn_id: "worker:turn-1",
            status: "failed",
            error: "Provider overloaded",
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        { agent_id: "worker" },
      ),
    );
    expect(failed).toContain("Provider overloaded");
  });

  it("shows that a wait's result was already delivered instead of an empty output", () => {
    const details = {
      event: "turn",
      agent_id: "worker",
      turn_id: "worker:turn-1",
      status: "completed",
      already_delivered: true,
      source_agent_id: "worker",
      source_turn_id: "worker:turn-1",
    };
    for (const expanded of [false, true]) {
      const rendered = renderLines(
        renderCoordinatorToolResult(
          "subagent_wait",
          { content: [], details },
          { expanded, isPartial: false },
          plainTheme,
          { agent_id: "worker" },
        ),
      );
      expect(rendered).toContain("worker  ·  completed");
      expect(rendered).toContain(
        "Already delivered automatically; wait with turn_id to reread it.",
      );
      expect(rendered).not.toContain("(no output)");
    }
  });

  it("hangs a waiting child's turn off a rail of Pi-rendered items", () => {
    const toolTurn = (index: number): AgentMessage[] => [
      {
        role: "assistant",
        content: [
          { type: "text", text: `Inspecting part ${index}` },
          { type: "toolCall", id: `call-${index}`, name: "mystery_tool", arguments: { index } },
        ],
        api: "openai-completions",
        provider: "test",
        model: "model",
        usage: { ...usage, cost: { ...usage.cost, total: 0 } },
        stopReason: "toolUse",
        timestamp: index,
      },
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "mystery_tool",
        content: [{ type: "text", text: `result ${index}` }],
        isError: false,
        timestamp: index,
      },
    ];
    const stubTui: Pick<TUI, "requestRender"> = { requestRender: () => undefined };
    // SAFETY: Native transcript components only call requestRender on their TUI.
    const tui = stubTui as TUI;
    const progress = (turns: number, expanded: boolean) =>
      renderCoordinatorToolResult(
        "subagent_wait",
        {
          content: [{ type: "text", text: "Waiting for worker" }],
          details: {
            agent_id: "worker",
            status: "waiting",
            elapsed_ms: 9_000,
            turn_id: "worker:turn-1",
            tool_calls: turns,
          },
        },
        { expanded, isPartial: true },
        plainTheme,
        { agent_id: "worker" },
        false,
        (agentId, turnId, liveExpanded) =>
          agentId === "worker" && turnId === "worker:turn-1"
            ? new TranscriptRail(
                {
                  messages: Array.from({ length: turns }, (_, index) => toolTurn(index + 1)).flat(),
                  toolDefinitions: [],
                },
                tui,
                "/project",
                liveExpanded,
                createTranscriptRenderCache(),
                plainTheme,
              )
            : undefined,
      ).render(60);

    const lines = progress(1, false);
    const text = lines.map((line) => stripVTControlCharacters(line));
    expect(text[0]).toContain("worker  ·  waiting  ·  9s  ·  1 tool call");
    expect(text[0]).toContain("to expand");
    expect(text[1]).toMatch(/^├─ .*Inspecting part 1/);
    expect(text.find((line) => line.startsWith("└─ "))).toContain("mystery_tool");
    expect(text.join("\n")).toContain("result 1");
    expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);

    const collapsed = progress(12, false).map((line) => stripVTControlCharacters(line));
    expect(collapsed[1]).toMatch(/^├─ … \d+ earlier steps$/);
    expect(collapsed.join("\n")).toContain("result 12");
    expect(collapsed.join("\n")).not.toContain("result 1\n");
    const expanded = progress(12, true).map((line) => stripVTControlCharacters(line));
    expect(expanded.join("\n")).not.toContain("earlier steps");
    expect(expanded.join("\n")).toContain("Inspecting part 1");
  });

  it("ends every collapsed result's first line with the expansion hint, except live progress", () => {
    const turn = { event: "turn", agent_id: "worker", turn_id: "worker:turn-1" };
    const activity = [{ label: "tool call read", content: '{"path":"a.ts"}', truncated: false }];
    const collapsedResults = [
      ["subagent", { agent_id: "worker", turn_id: "worker:turn-1", status: "running" }],
      ["agent_message", { agent_id: "worker", message_id: "m", disposition: "queued" }],
      ["subagent_wait", { ...turn, status: "completed", output: "short output" }],
      ["subagent_wait", { ...turn, status: "completed", output: "" }],
      ["subagent_wait", { ...turn, status: "failed", error: "boom" }],
      ["subagent_wait", { ...turn, event: "message", message_id: "m", message: "update" }],
      [
        "subagent_wait",
        {
          ...turn,
          event: "timeout",
          timeout_ms: 10,
          state: "running",
          recent_activity_labels: ["tool call read"],
        },
      ],
      ["subagent_status", { parent_id: "root", agents: [{ agent_id: "worker", state: "idle" }] }],
      ["subagent_status", { agent: { agent_id: "worker", recent_activity: activity } }],
      [
        "subagent_cancel",
        { agent_id: "worker", recursive: true, affected_agent_ids: [], cancelled_turn_ids: [] },
      ],
      [
        "subagent_delete",
        {
          agent_id: "worker",
          recursive: true,
          deleted_agent_ids: ["worker"],
          trashed_session_files: [],
          failures: [],
        },
      ],
    ] as const;
    const firstLine = (component: { render(width: number): string[] }) =>
      component.render(120).find((line) => line.trim().length > 0) ?? "";

    for (const [toolName, details] of collapsedResults) {
      const component = renderCoordinatorToolResult(
        toolName,
        { content: [], details },
        { expanded: false, isPartial: false },
        plainTheme,
        { agent_id: "worker" },
      );
      expect(firstLine(component), `${toolName} ${JSON.stringify(details)}`).toContain("to expand");
    }
    const agentResult = renderMinimalSubagentsResult(
      { content: "done", details: { source_agent_id: "worker", destination_agent_id: "root" } },
      { expanded: false, outputPad: 1 },
      plainTheme,
    );
    expect(firstLine(agentResult)).toContain("to expand");
    const progress = renderCoordinatorToolResult(
      "subagent_wait",
      {
        content: [],
        details: { agent_id: "worker", status: "waiting", elapsed_ms: 1_000, activity },
      },
      { expanded: false, isPartial: true },
      plainTheme,
      { agent_id: "worker" },
    );
    expect(renderLines(progress)).not.toContain("to expand");
  });

  it("previews automatic agent results as Markdown", () => {
    const component = renderMinimalSubagentsResult(
      {
        content: "**Done**: updated `a.ts`",
        details: { source_agent_id: "worker", destination_agent_id: "root", status: "completed" },
      },
      { expanded: false, outputPad: 1 },
      plainTheme,
    );
    const lines = renderLines(component);
    expect(lines).toContain("Done");
    expect(lines).toContain("updated");
    expect(lines).not.toContain("**");
  });
});

describe("minimal subagents rendering", () => {
  it("renders every current coordinator result DTO", () => {
    const currentResults = [
      {
        toolName: "subagent",
        args: { task: "inspect registry" },
        details: { agent_id: "child", turn_id: "child:turn-1", status: "running" },
        expected: "child",
      },
      {
        toolName: "agent_message",
        args: { agent_id: "child", message: "send paths" },
        details: { agent_id: "child", message_id: "message-1", disposition: "queued" },
        expected: "queued",
      },
      {
        toolName: "subagent_wait",
        args: { agent_id: "child" },
        details: {
          event: "message",
          agent_id: "child",
          turn_id: "child:turn-1",
          message_id: "message-1",
          message: "working",
          usage,
        },
        expected: "working",
      },
      {
        toolName: "subagent_wait",
        args: { agent_id: "child" },
        details: {
          event: "turn",
          agent_id: "child",
          turn_id: "child:turn-1",
          status: "completed",
          output: "complete",
          messages: [
            {
              event: "message",
              agent_id: "child",
              turn_id: "child:turn-1",
              message_id: "message-2",
              message: "queued update",
            },
          ],
        },
        expected: "queued update",
      },
      {
        toolName: "subagent_wait",
        args: { agent_id: "child" },
        details: {
          event: "turn",
          agent_id: "child",
          turn_id: "child:turn-1",
          status: "failed",
          error: "terminal failure",
          usage,
        },
        expected: "terminal failure",
      },
      {
        toolName: "subagent_wait",
        args: { agent_id: "child" },
        details: {
          event: "timeout",
          agent_id: "child",
          turn_id: "child:turn-1",
          timeout_ms: 1_000,
          state: "running",
          latest_activity_at: "2026-01-01T00:00:00.000Z",
          total_tokens: 1_234,
          recent_activity_labels: ["tool call read", "tool result read"],
        },
        expected: "timed out",
      },
      {
        toolName: "subagent_status",
        args: {},
        details: {
          parent_id: "root",
          agents: [
            {
              agent_id: "child",
              state: "future-state",
              availability: "available",
              latest_turn: { turn_id: "child:turn-future", status: "future-state" },
              child_count: 0,
              tools: ["read"],
            },
          ],
        },
        expected: "○",
      },
      {
        toolName: "subagent_status",
        args: { agent_id: "child" },
        details: {
          agent: {
            agent_id: "child",
            state: "idle",
            availability: "available",
            child_count: 0,
            tools: ["read"],
            launch_contract: { model: "provider/model" },
            recent_activity: [
              {
                label: "tool call read",
                content: '{"path":"src/index.ts"}',
                truncated: false,
              },
            ],
          },
        },
        expected: "src/index.ts",
      },
      {
        toolName: "subagent_cancel",
        args: { agent_id: "child" },
        details: {
          agent_id: "child",
          recursive: true,
          affected_agent_ids: ["child"],
          cancelled_turn_ids: ["child:turn-1"],
        },
        expected: "child:turn-1",
      },
      {
        toolName: "subagent_delete",
        args: { agent_id: "child" },
        details: {
          agent_id: "child",
          recursive: true,
          deleted_agent_ids: ["child"],
          trashed_session_files: ["/sessions/child.jsonl"],
          failures: [],
        },
        expected: "/sessions/child.jsonl",
      },
    ] as const;

    for (const result of currentResults) {
      expect(
        renderLines(renderCoordinatorToolCall(result.toolName, result.args, plainTheme)),
      ).not.toBe("");
      expect(
        renderLines(
          renderCoordinatorToolResult(
            result.toolName,
            { content: [{ type: "text", text: "fallback" }], details: result.details },
            { expanded: true, isPartial: false },
            plainTheme,
            result.args,
          ),
        ),
      ).toContain(result.expected);
    }
  });

  it("renders a partially failed deletion from its structured details", () => {
    const lines = renderLines(
      renderCoordinatorToolResult(
        "subagent_delete",
        {
          content: [{ type: "text", text: "Minimal subagents deletion partially failed" }],
          details: {
            agent_id: "child",
            recursive: true,
            deleted_agent_ids: ["child.leaf"],
            trashed_session_files: [],
            failures: [{ agent_id: "child", error: "disk full" }],
          },
        },
        { expanded: true, isPartial: false },
        plainTheme,
        { agent_id: "child" },
        true,
      ),
    );

    expect(lines).toContain("1 failed");
    expect(lines).toContain("child.leaf");
    expect(lines).toContain("disk full");
  });

  it("renders compact and pre-compact timeout results", () => {
    const base = { event: "timeout", agent_id: "child", turn_id: "child:turn-1", timeout_ms: 10 };
    const render = (
      details: Parameters<typeof renderCoordinatorToolResult>[1]["details"],
      expanded: boolean,
    ) =>
      renderLines(
        renderCoordinatorToolResult(
          "subagent_wait",
          { content: [{ type: "text", text: "timeout" }], details },
          { expanded, isPartial: false },
          plainTheme,
          { agent_id: "child" },
        ),
      );
    const compact = {
      ...base,
      state: "running",
      latest_activity_at: "2026-01-01T00:00:00.000Z",
      total_tokens: 1_234,
      recent_activity_labels: ["tool call read", "tool result read"],
    };
    expect(render(compact, false)).toContain("tool call read \u00b7 tool result read");
    const expanded = render(compact, true);
    expect(expanded).toContain("State: running");
    expect(expanded).toContain("Latest activity: 2026-01-01T00:00:00.000Z");
    expect(expanded).toContain("tool result read");

    const legacy = {
      ...base,
      agent: {
        agent_id: "child",
        state: "running",
        recent_activity: [{ label: "tool call grep", content: "{}", truncated: false }],
      },
    };
    expect(render(legacy, false)).toContain("tool call grep");
    expect(render(legacy, true)).toContain("State: running");
  });

  it("renders legacy details and falls back to historical text for malformed partial errors", () => {
    const legacy = renderCoordinatorToolResult(
      "agent_message",
      {
        content: [{ type: "text", text: "legacy fallback" }],
        details: { agent_id: "child", message_id: "message-1", delivered: true },
      },
      { expanded: true, isPartial: false },
      plainTheme,
      { agent_id: "child", message: "legacy message" },
    );
    expect(renderLines(legacy)).toContain("child");

    const malformed = renderCoordinatorToolResult(
      "subagent_wait",
      {
        content: [
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "text", text: "historical partial error" },
        ],
        details: { malformed: true },
      },
      { expanded: false, isPartial: true },
      plainTheme,
      {},
      true,
    );
    expect(renderLines(malformed)).toContain("historical partial error");

    const validPartialError = renderCoordinatorToolResult(
      "subagent_wait",
      {
        content: [{ type: "text", text: "partial fallback" }],
        details: {
          event: "turn",
          agent_id: "child",
          turn_id: "child:turn-1",
          status: "failed",
          error: "typed partial failure",
        },
      },
      { expanded: true, isPartial: true },
      plainTheme,
      { agent_id: "child" },
      true,
    );
    expect(renderLines(validPartialError)).toContain("waiting");

    const validError = renderCoordinatorToolResult(
      "subagent_wait",
      {
        content: [{ type: "text", text: "error fallback" }],
        details: {
          event: "turn",
          agent_id: "child",
          turn_id: "child:turn-1",
          status: "failed",
          error: "typed rendered error",
        },
      },
      { expanded: true, isPartial: false },
      plainTheme,
      { agent_id: "child" },
      true,
    );
    expect(renderLines(validError)).toContain("typed rendered error");
  });

  it("renders text while safely ignoring image content in coordinator messages", () => {
    const component = renderMinimalSubagentsMessage(
      {
        content: [
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "text", text: "typed text content" },
        ],
        details: {
          source_agent_id: "child",
          destination_agent_id: "root",
          source_turn_id: "child:turn-1",
          usage,
        },
      },
      { expanded: true, outputPad: 0 },
      plainTheme,
    );
    expect(renderLines(component)).toContain("typed text content");
    expect(renderLines(component)).toContain("total 120");

    const legacyComponent = renderMinimalSubagentsMessage(
      {
        content: "legacy coordinator message",
        details: { agent_id: "legacy-child", turn_id: "legacy-turn", status: "queued" },
      },
      { expanded: true, outputPad: 0 },
      plainTheme,
    );
    expect(renderLines(legacyComponent)).toContain("legacy-child");
    expect(renderLines(legacyComponent)).toContain("legacy-turn");
  });
});
