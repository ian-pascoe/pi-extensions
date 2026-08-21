import { describe, expect, it } from "vitest";
import {
  formatSubagentDuration,
  formatSubagentPreview,
  formatSubagentTokenCount,
  formatSubagentUsage,
  type MinimalSubagentsRenderTheme,
  renderCoordinatorToolCall,
  renderCoordinatorToolResult,
  renderMinimalSubagentsMessage,
} from "../src/minimal-subagents-rendering.js";

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

describe("minimal subagents rendering", () => {
  it("formats bounded previews, durations, token counts, and usage summaries", () => {
    expect(formatSubagentDuration(undefined)).toBeUndefined();
    expect(formatSubagentDuration(1_500)).toBe("1s");
    expect(formatSubagentDuration(61_000)).toBe("1m 01s");
    expect(formatSubagentTokenCount(1_200)).toBe("1.2k");
    expect(formatSubagentPreview("  one\n two   three ", 10)).toBe("one two t…");
    expect(formatSubagentUsage(usage)).toContain("total 120");
  });

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
          },
        },
        expected: "provider/model",
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
