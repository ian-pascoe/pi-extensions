import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme as taggedTheme,
  expectLinesFitWidth,
  readableTags,
  type LineFitOptions,
} from "@ian-pascoe/pi-utils/ui-testing";
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

type Renderable = { render(width: number): string[] };

function renderLines(component: Renderable): string {
  return component.render(120).join("\n");
}

beforeAll(() => {
  initTheme("dark");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

/** Pi's Expand Hint as the tagged theme renders it, for any hidden-line count. */
const EXPAND_HINT =
  /<muted>\.\.\. \(\d+ (?:more|earlier) lines,<\/muted> <dim>ctrl\+o<\/dim><muted> to expand<\/muted><muted>\)<\/muted>/;
const SUMMARY_HINT = "<dim> (ctrl+o to expand)</dim>";

/** Rendered lines with the injected theme's tokens decoded to readable tags, right-trimmed. */
function plainLines(component: Renderable, width = 120): string[] {
  return component.render(width).map((line) => readableTags(line).trimEnd());
}

/** Every line fits 40 and 120 columns and carries no hard-coded colour of its own. */
function expectFits(component: Renderable, options?: LineFitOptions): void {
  for (const width of [40, 120]) expectLinesFitWidth(component.render(width), width, options);
}

const text = (component: Renderable, width = 120): string =>
  plainLines(component, width).join("\n");

/** Bodies drawn by Pi's own Markdown or native components follow Pi's global theme. */
const PI_BODY = { piThemedBody: true } as const;

const numberedLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n\n");

const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };

function wait(
  details: Parameters<typeof renderCoordinatorToolResult>[1]["details"],
  options = collapsed,
  args = { agent_id: "worker" },
) {
  return renderCoordinatorToolResult(
    "subagent_wait",
    { content: [], details },
    options,
    taggedTheme,
    args,
  );
}

describe("minimal subagents call rows", () => {
  it("leads every header with the registered tool name, then the target, then muted arguments", () => {
    const header = (
      toolName: Parameters<typeof renderCoordinatorToolCall>[0],
      args: Parameters<typeof renderCoordinatorToolCall>[1],
    ) => plainLines(renderCoordinatorToolCall(toolName, args, taggedTheme))[0];
    expect(
      header("subagent", {
        agent_id: "worker",
        task: "Look",
        model: "provider/model",
        thinking_level: "medium",
        tools: "read",
        session_context: "inherit",
      }),
    ).toBe(
      "<toolTitle><b>subagent</b></toolTitle> <accent>worker</accent> <muted>provider/model:medium · tools read · context inherit</muted>",
    );
    expect(header("subagent", { task: "Look" })).toBe(
      "<toolTitle><b>subagent</b></toolTitle> <accent>generated</accent>",
    );
    expect(header("agent_message", { agent_id: "worker", message: "hi" })).toBe(
      "<toolTitle><b>agent_message</b></toolTitle> <accent>worker</accent>",
    );
    expect(header("subagent_wait", { agent_id: "worker" })).toBe(
      "<toolTitle><b>subagent_wait</b></toolTitle> <accent>worker</accent>",
    );
    expect(header("subagent_status", {})).toBe(
      "<toolTitle><b>subagent_status</b></toolTitle> <muted>children</muted>",
    );
    expect(header("subagent_cancel", { agent_id: "worker" })).toBe(
      "<toolTitle><b>subagent_cancel</b></toolTitle> <accent>worker</accent> <muted>recursive</muted>",
    );
    expect(header("subagent_delete", { agent_id: "worker", recursive: false })).toBe(
      "<toolTitle><b>subagent_delete</b></toolTitle> <accent>worker</accent> <muted>target only</muted>",
    );
  });

  it("previews a long task for 10 lines with Pi's Expand Hint and shows all of it expanded", () => {
    const args = { agent_id: "worker", task: numberedLines(12) };
    const collapsedCall = renderCoordinatorToolCall("subagent", args, taggedTheme);
    const lines = plainLines(collapsedCall);
    expect(lines).toHaveLength(12);
    expect(lines[1]).toBe("<toolOutput>line 1</toolOutput>");
    expect(lines[10]).toBe("<toolOutput></toolOutput>");
    expect(lines[11]).toMatch(EXPAND_HINT);
    expect(lines[11]).toContain("(13 more lines,");
    expectFits(collapsedCall);

    const expandedCall = renderCoordinatorToolCall("subagent", args, taggedTheme, true);
    expect(text(expandedCall)).toContain("line 12");
    expect(text(expandedCall)).not.toContain("to expand");
    expectFits(expandedCall);
  });

  it("shows the role a spawn named in its call header, launch section, and status", () => {
    const call = text(
      renderCoordinatorToolCall(
        "subagent",
        { agent_id: "worker", task: "Look", role: "explore", thinking_level: "high" },
        plainTheme,
      ),
    );
    expect(call).toContain("subagent worker role explore · thinking high");

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
});

describe("minimal subagents result rows", () => {
  it("shows a settled wait's answer for 10 lines without marks, and its error in the error role", () => {
    const completed = wait({
      event: "turn",
      agent_id: "worker",
      turn_id: "worker:turn-1",
      status: "completed",
      output: `**Findings**\n\n${numberedLines(12)}`,
      usage,
    });
    const lines = plainLines(completed);
    expect(lines[0]).toBe(
      "<accent>worker</accent><dim> · </dim><muted>completed</muted><dim> · </dim><muted>120 tokens</muted><dim> · </dim><muted>$0.01</muted>",
    );
    expect(lines.join("\n")).toContain("Findings");
    expect(lines.join("\n")).not.toContain("**");
    expect(lines.join("\n")).toContain("line 4");
    expect(lines.join("\n")).not.toContain("line 12");
    expect(lines.at(-1)).toMatch(EXPAND_HINT);
    expect(lines.join("\n")).not.toMatch(/[●○✓✗■◉×]/);
    expectFits(completed);

    const failed = wait({
      event: "turn",
      agent_id: "worker",
      turn_id: "worker:turn-1",
      status: "failed",
      error: "Provider overloaded",
    });
    expect(text(failed)).toContain("<error>Provider overloaded</error>");
    expect(text(failed)).toContain("<error>failed</error>");
    expectFits(failed);
  });

  it("shows the whole answer and no hint when expanded", () => {
    const rendered = wait(
      {
        event: "turn",
        agent_id: "worker",
        turn_id: "worker:turn-1",
        status: "completed",
        output: `**Findings**\n\n${numberedLines(12)}`,
        usage,
      },
      expanded,
    );
    expect(text(rendered)).toContain("line 12");
    expect(text(rendered)).toContain("Turn:");
    expect(text(rendered)).not.toContain("to expand");
    expectFits(rendered);
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
    for (const options of [collapsed, expanded]) {
      const rendered = wait(details, options);
      expect(text(rendered)).toContain("<muted>completed</muted>");
      expect(text(rendered)).toContain(
        "Already delivered automatically; wait with turn_id to reread it.",
      );
      expect(text(rendered)).not.toContain("(no output)");
      expectFits(rendered);
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
    const progress = (turns: number, isExpanded: boolean) =>
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
        { expanded: isExpanded, isPartial: true },
        taggedTheme,
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
                taggedTheme,
              )
            : undefined,
      );

    const one = progress(1, false);
    const lines = plainLines(one);
    expect(lines[0]).toBe(
      `<accent>worker</accent><dim> · </dim><muted>waiting</muted><dim> · </dim><muted>9s</muted><dim> · </dim><muted>1 tool call</muted>${SUMMARY_HINT}`,
    );
    expect(lines[1]).toMatch(/^<dim>├─ <\/dim>.*Inspecting part 1/);
    expect(lines.find((line) => line.startsWith("<dim>└─ </dim>"))).toContain("mystery_tool");
    expect(lines.join("\n")).toContain("result 1");
    expectFits(one, PI_BODY);

    const many = plainLines(progress(12, false));
    expect(many[1]).toMatch(/^<dim>├─ <\/dim><muted>\.\.\. \(\d+ earlier lines,<\/muted>/);
    expect(many.join("\n")).toContain("result 12");
    expect(many.join("\n")).not.toContain("result 1\n");
    const all = plainLines(progress(12, true));
    expect(all.join("\n")).not.toContain("earlier lines");
    expect(all.join("\n")).toContain("Inspecting part 1");
    expect(all[0]).not.toContain("to expand");
    expectFits(progress(12, false), PI_BODY);
    expectFits(progress(12, true), PI_BODY);
  });

  it("ends a summary-only collapsed row with the summary hint and shows a body instead of it", () => {
    const turn = { event: "turn", agent_id: "worker", turn_id: "worker:turn-1" };
    const activity = [{ label: "tool call read", content: '{"path":"a.ts"}', truncated: false }];
    const summaryOnly = [
      ["subagent", { agent_id: "worker", turn_id: "worker:turn-1", status: "running" }],
      ["agent_message", { agent_id: "worker", message_id: "m", disposition: "queued" }],
      ["subagent_wait", { ...turn, status: "completed", output: "" }],
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
      ["subagent_status", { agent: { agent_id: "worker", state: "idle" } }],
    ] as const;
    for (const [toolName, details] of summaryOnly) {
      const component = renderCoordinatorToolResult(
        toolName,
        { content: [], details },
        collapsed,
        taggedTheme,
        { agent_id: "worker" },
      );
      expect(plainLines(component)[0], toolName).toContain(SUMMARY_HINT);
      expectFits(component);
    }

    const withBody = [
      ["subagent_wait", { ...turn, status: "completed", output: "short output" }],
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
      ["subagent_status", { agent: { agent_id: "worker", recent_activity: activity } }],
    ] as const;
    for (const [toolName, details] of withBody) {
      const component = renderCoordinatorToolResult(
        toolName,
        { content: [], details },
        collapsed,
        taggedTheme,
        { agent_id: "worker" },
      );
      const lines = plainLines(component);
      expect(lines.length, JSON.stringify(details)).toBeGreaterThan(1);
      expect(lines[0], JSON.stringify(details)).not.toContain(SUMMARY_HINT);
      expectFits(component);
    }
  });

  it("shows an agent_message failure in the error role", () => {
    const result = renderCoordinatorToolResult(
      "agent_message",
      {
        content: [],
        details: {
          agent_id: "worker",
          message_id: "m",
          disposition: "failed",
          error: "no such agent",
        },
      },
      collapsed,
      taggedTheme,
      { agent_id: "worker", message: "hi" },
      true,
    );
    expect(text(result)).toContain("<error>failed</error>");
    expect(text(result)).toContain("<error>no such agent</error>");
    expectFits(result);
  });

  it("lists children for 20 rows with Pi's Expand Hint, all rows when expanded", () => {
    const agents = Array.from({ length: 25 }, (_, index) => ({
      agent_id: `worker-${index}`,
      state: index === 0 ? "running" : "idle",
      child_count: 0,
    }));
    const render = (options: { expanded: boolean; isPartial: boolean }) =>
      renderCoordinatorToolResult(
        "subagent_status",
        { content: [], details: { parent_id: "root", agents } },
        options,
        taggedTheme,
        {},
      );
    const lines = plainLines(render(collapsed));
    expect(lines).toHaveLength(22);
    expect(lines[0]).not.toBe("");
    expect(lines[0]).toBe("<muted>25 children</muted><dim> · </dim><accent>1 running</accent>");
    expect(lines[1]).toContain("worker-0");
    expect(lines[20]).toContain("worker-19");
    expect(lines[21]).toMatch(EXPAND_HINT);
    expect(lines[21]).toContain("(5 more lines,");
    expectFits(render(collapsed));

    const all = plainLines(render(expanded));
    expect(all).toHaveLength(26);
    expect(all.join("\n")).toContain("worker-24");
    expect(all.join("\n")).not.toContain("to expand");
    expectFits(render(expanded));
  });

  it("lists a partial deletion's failures in the error role when collapsed", () => {
    const rendered = renderCoordinatorToolResult(
      "subagent_delete",
      {
        content: [],
        details: {
          agent_id: "child",
          recursive: true,
          deleted_agent_ids: ["child.leaf"],
          trashed_session_files: [],
          failures: [{ agent_id: "child", error: "disk full" }],
        },
      },
      collapsed,
      taggedTheme,
      { agent_id: "child" },
      true,
    );
    expect(text(rendered)).toContain("<error>failed</error>");
    expect(text(rendered)).toContain("<error>child: disk full</error>");
    expectFits(rendered);
  });

  it("shows an unrecognised result's text, error-coloured and capped at 10 lines", () => {
    const longText = Array.from({ length: 14 }, (_, index) => `text ${index + 1}`).join("\n");
    const render = (isError: boolean, options = collapsed) =>
      renderCoordinatorToolResult(
        "subagent_status",
        { content: [{ type: "text", text: longText }], details: { malformed: true } },
        options,
        taggedTheme,
        {},
        isError,
      );
    const lines = plainLines(render(true));
    expect(lines[0]).toBe("<error>text 1</error>");
    expect(lines).toHaveLength(11);
    expect(lines[10]).toMatch(EXPAND_HINT);
    expect(plainLines(render(false))[0]).toBe("<toolOutput>text 1</toolOutput>");
    expect(plainLines(render(true, expanded))).toHaveLength(14);
    expectFits(render(true));
  });
});

describe("minimal subagents custom messages", () => {
  const details = {
    source_agent_id: "worker",
    destination_agent_id: "root",
    source_turn_id: "worker:turn-1",
    status: "completed",
    elapsed_ms: 3_000,
    usage,
  };

  it("uses the custom-message box with a `[subagents] result · route · status` label line", () => {
    const rendered = renderMinimalSubagentsResult(
      { content: "**Done**: updated `a.ts`", details },
      { expanded: false, outputPad: 1 },
      taggedTheme,
    );
    const lines = plainLines(rendered);
    expect(lines.every((line) => line.startsWith("<bg:customMessageBg>"))).toBe(true);
    const label = lines[1] ?? "";
    expect(label).toContain(
      "<customMessageLabel><b>[subagents]</b></customMessageLabel> <customMessageText>result</customMessageText><dim> · </dim><customMessageText>worker → root</customMessageText><dim> · </dim>",
    );
    expect(label).toContain("<muted>completed</muted>");
    expect(label).toContain("<muted>3s</muted>");
    const body = lines.join("\n");
    expect(body).toContain("Done");
    expect(body).toContain("updated");
    expect(body).not.toContain("**");
    expect(body).not.toContain("to expand");
    expectFits(rendered, PI_BODY);

    const message = renderMinimalSubagentsMessage(
      { content: "ping", details: { ...details, status: undefined } },
      { expanded: false, outputPad: 0 },
      taggedTheme,
    );
    expect(text(message)).toContain(
      "<customMessageLabel><b>[subagents]</b></customMessageLabel> <customMessageText>message</customMessageText><dim> · </dim><customMessageText>worker → root</customMessageText>",
    );
    expectFits(message, PI_BODY);
  });

  it("previews 10 lines with Pi's Expand Hint and shows everything expanded without one", () => {
    const content = numberedLines(14);
    const preview = renderMinimalSubagentsResult(
      { content, details },
      { expanded: false, outputPad: 1 },
      taggedTheme,
    );
    const previewText = text(preview);
    expect(previewText).toMatch(EXPAND_HINT);
    expect(previewText).toContain("line 4");
    expect(previewText).not.toContain("line 14");
    expectFits(preview, PI_BODY);

    const full = renderMinimalSubagentsResult(
      { content, details },
      { expanded: true, outputPad: 1 },
      taggedTheme,
    );
    expect(text(full)).toContain("line 14");
    expect(text(full)).toContain("Source turn:");
    expect(text(full)).toContain("total 120");
    expect(text(full)).not.toContain("to expand");
    expectFits(full, PI_BODY);
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
        expected: "future-state",
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
      const rendered = renderCoordinatorToolResult(
        result.toolName,
        { content: [{ type: "text", text: "fallback" }], details: result.details },
        expanded,
        plainTheme,
        result.args,
      );
      expect(renderLines(rendered)).toContain(result.expected);
      expect(renderLines(rendered)).not.toMatch(/[●○✓✗■◉×]/);
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
        expanded,
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
      isExpanded: boolean,
    ) =>
      renderLines(
        renderCoordinatorToolResult(
          "subagent_wait",
          { content: [{ type: "text", text: "timeout" }], details },
          { expanded: isExpanded, isPartial: false },
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
    const expandedCompact = render(compact, true);
    expect(expandedCompact).toContain("State: running");
    expect(expandedCompact).toContain("Latest activity: 2026-01-01T00:00:00.000Z");
    expect(expandedCompact).toContain("tool result read");

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
      expanded,
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
      expanded,
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
