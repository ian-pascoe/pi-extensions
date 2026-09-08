import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  initTheme,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { MinimalSubagentsCoordinator } from "../src/minimal-subagents-coordinator.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MinimalSubagentsStatusPanelComponent,
  MinimalSubagentsStatusPanelController,
  type MinimalSubagentsStatusAccess,
} from "../src/minimal-subagents-status-panel.js";
import type { AgentSummary, ChildAgentTranscriptSnapshot } from "../src/minimal-subagents-types.js";

function summary(agentId: string, overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agent_id: agentId,
    parent_id: "root",
    state: "idle",
    availability: "available",
    model: "provider/model",
    thinking_level: "medium",
    tools: ["read"],
    child_count: 0,
    children: [],
    task: `Task for ${agentId}`,
    ...overrides,
  };
}

const access: MinimalSubagentsStatusAccess = {
  enabled: true,
  source: "branch",
  branchOverride: "enabled",
  globalEnabled: false,
  projectEnabled: true,
  coordinatorTools: {
    activeCount: 3,
    totalCount: 6,
    state: "partial",
  },
  projectTrusted: true,
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 1,
  };
}

function panelFixture(
  options: {
    agents?: AgentSummary[];
    transcript?: ChildAgentTranscriptSnapshot;
    startRefresh?: (refresh: () => void) => () => void;
  } = {},
) {
  const nested = summary("parent.child", { parent_id: "parent", state: "running" });
  const status = {
    root_id: "root" as const,
    agents: options.agents ?? [
      summary("parent", { child_count: 1, children: [nested] }),
      summary("idle"),
    ],
  };
  const transcript: ChildAgentTranscriptSnapshot = options.transcript ?? {
    messages: [],
    toolDefinitions: [],
    fallback: "live recent activity",
  };
  const coordinator = {
    inspectStatus: vi.fn(() => status),
    inspectTranscript: vi.fn(() => transcript),
  } satisfies Pick<MinimalSubagentsCoordinator, "inspectStatus" | "inspectTranscript">;
  const tui = {
    terminal: { rows: 20, columns: 100 } satisfies Pick<TUI["terminal"], "rows" | "columns">,
    requestRender: vi.fn<TUI["requestRender"]>(),
  };
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
    bg: (_color, text) => text,
  } satisfies Pick<Theme, "fg" | "bold" | "bg">;
  const bindings = new Map([
    ["up", "tui.select.up"],
    ["down", "tui.select.down"],
    ["enter", "tui.select.confirm"],
    ["escape", "tui.select.cancel"],
    ["pageUp", "tui.select.pageUp"],
    ["pageDown", "tui.select.pageDown"],
    ["expand", "app.tools.expand"],
  ]);
  const keybindings = {
    matches: (data, binding) => bindings.get(data) === binding,
    getKeys: () => ["ctrl+o"],
  } satisfies Pick<KeybindingsManager, "matches" | "getKeys">;
  const onClose = vi.fn();
  const panel = new MinimalSubagentsStatusPanelComponent(
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel reads only these two checked coordinator methods; both remain observable typed mocks.
    coordinator as unknown as MinimalSubagentsCoordinator,
    () => access,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel uses only checked terminal dimensions and the typed requestRender mock, not a full terminal runtime.
    tui as unknown as TUI,
    // SAFETY: These panel render paths use only the checked fg and bold theme methods.
    theme as Theme,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel reads only the checked input matcher and configured key hints.
    keybindings as unknown as KeybindingsManager,
    "/project",
    onClose,
    options.startRefresh,
  );
  return { coordinator, onClose, panel, tui };
}

afterEach(() => vi.useRealTimers());
beforeAll(() => initTheme("dark"));

describe("minimal subagents status panel", () => {
  it("renders access and the complete hierarchy while loading Recent Activity lazily", () => {
    const { coordinator, panel } = panelFixture();
    const collapsed = panel.render(60).join("\n");
    expect(collapsed).toContain("Access: enabled · branch override");
    expect(collapsed).toContain("Coordinator Tools: 3/6 active (inconsistent)");
    expect(collapsed).toContain("parent.child");
    expect(coordinator.inspectTranscript).not.toHaveBeenCalled();

    panel.handleInput("enter");
    expect(coordinator.inspectTranscript).toHaveBeenCalledWith("parent");
    expect(panel.render(60).join("\n")).toContain("live recent activity");
    panel.dispose();
  });

  it("orders active subtrees first and retains the selected Child Agent across reordering", async () => {
    vi.useFakeTimers();
    const parent = summary("parent", {
      children: [summary("parent.idle"), summary("parent.active", { state: "running" })],
    });
    const { panel } = panelFixture({
      agents: [summary("idle"), parent, summary("running", { state: "running" })],
    });
    expect(
      panel
        .render(100)
        .map((line) => line.match(/▸ ([\w.]+)/)?.[1])
        .filter(Boolean),
    ).toEqual(["parent", "parent.active", "parent.idle", "running", "idle"]);
    panel.handleInput("down");
    parent.children[0]!.state = "running";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(panel.render(100).join("\n")).toContain(">   ▸ parent.active");
    panel.dispose();
  });

  it("opens a separate Child Session Transcript and returns to the tree before closing", () => {
    const { panel, onClose } = panelFixture();
    panel.handleInput("down");
    panel.handleInput("enter");
    const transcript = panel.render(80).join("\n");
    expect(transcript).toContain("Transcript · parent.child");
    expect(transcript).not.toContain("Task for idle");
    panel.handleInput("escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.render(80).join("\n")).toContain(">   ▸ parent.child");
    panel.handleInput("escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("refreshes the inspected transcript once per second and preserves bounded rendering", async () => {
    vi.useFakeTimers();
    const { coordinator, panel } = panelFixture();
    panel.handleInput("enter");
    expect(coordinator.inspectTranscript).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(coordinator.inspectStatus).toHaveBeenCalledTimes(2);
    expect(coordinator.inspectTranscript).toHaveBeenCalledTimes(2);
    expect(panel.render(36).every((line) => visibleWidth(line) <= 36)).toBe(true);
    panel.dispose();
  });

  it("keeps page scrolling independent from the selected row", () => {
    const agents = Array.from({ length: 20 }, (_, index) =>
      summary(`worker-${index.toString().padStart(2, "0")}`),
    );
    const { panel } = panelFixture({ agents });
    expect(panel.render(60).join("\n")).toContain("worker-00");

    panel.handleInput("pageDown");
    const paged = panel.render(60).join("\n");
    expect(paged).not.toContain("worker-00");
    expect(paged).toContain("worker-09");
    panel.handleInput("pageDown");
    expect(panel.render(60).join("\n")).toContain("worker-19");
    panel.dispose();
  });

  it("frames and fills the pane within resized terminal bounds", () => {
    const { panel, tui } = panelFixture();
    const rows = panel.render(80);
    expect(rows[0]).toMatch(/^╭─+╮$/);
    expect(rows.at(-1)).toMatch(/^╰─+╯$/);
    expect(rows).toHaveLength(18);
    expect(rows.every((line) => visibleWidth(line) === 80)).toBe(true);
    for (const [width, height] of [
      [36, 10],
      [2, 4],
      [80, 3],
      [20, 40],
    ]) {
      tui.terminal.rows = height!;
      const resized = panel.render(width!);
      expect(resized.length).toBeLessThanOrEqual(Math.max(1, height! - 2));
      expect(resized.every((line) => visibleWidth(line) <= width!)).toBe(true);
    }
    panel.dispose();
  });

  it("follows latest output until scrolling up, then resumes with End", () => {
    const transcript = {
      messages: [],
      toolDefinitions: [],
      fallback: Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n"),
    } satisfies ChildAgentTranscriptSnapshot;
    const { panel } = panelFixture({ transcript });
    panel.handleInput("enter");
    expect(panel.render(80).join("\n")).toContain("line-79");
    expect(panel.render(80).join("\n")).not.toContain("line-0");
    panel.handleInput("pageUp");
    const paused = panel
      .render(80)
      .join("\n")
      .match(/line-\d+/g);
    transcript.fallback += "\nline-80";
    expect(
      panel
        .render(80)
        .join("\n")
        .match(/line-\d+/g),
    ).toEqual(paused);
    panel.handleInput("\x1b[F");
    expect(panel.render(80).join("\n")).toContain("line-80");
    transcript.fallback += "\nline-81";
    expect(panel.render(80).join("\n")).toContain("line-81");
    panel.dispose();
  });

  it("renders live assistant messages with paired tool results", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Inspecting source" },
        { type: "toolCall", id: "call-1", name: "mystery_tool", arguments: { path: "src" } },
      ],
      api: "openai-completions",
      provider: "test",
      model: "model",
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "mystery_tool",
      content: [{ type: "text", text: "visible tool result" }],
      isError: false,
      timestamp: 2,
    };
    const { panel } = panelFixture({
      transcript: { messages: [assistant, result], toolDefinitions: [] },
    });
    panel.handleInput("enter");

    const rendered = panel.render(80).join("\n");
    expect(rendered).toContain("Inspecting source");
    expect(rendered).toContain("mystery_tool");
    expect(rendered).toContain("visible tool result");
    panel.dispose();
  });

  it("renders inherited tool results even when their calls are outside inherited context", () => {
    const { panel } = panelFixture({
      transcript: {
        toolDefinitions: [],
        messages: [
          {
            role: "toolResult",
            toolCallId: "inherited-call",
            toolName: "read",
            content: [{ type: "text", text: "[Image: image/png]" }],
            isError: false,
            timestamp: 1,
          },
        ],
      },
    });
    panel.handleInput("enter");
    expect(panel.render(80).join("\n")).toContain("[Image: image/png]");
    panel.dispose();
  });

  it("reuses historical tool rendering when only the live tail changes", () => {
    const renderCall = vi.fn(() => new Text("historical tool", 0, 0));
    const transcript: ChildAgentTranscriptSnapshot = {
      messages: [
        assistantMessage([{ type: "toolCall", id: "call", name: "history", arguments: {} }]),
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "history",
          content: [{ type: "text", text: "historical result" }],
          timestamp: 2,
          isError: false,
        },
      ],
      toolDefinitions: [
        {
          name: "history",
          label: "History",
          description: "History",
          parameters: Type.Object({}),
          execute: async () => ({ content: [], details: undefined }),
          renderCall,
        },
      ],
    };
    const { panel } = panelFixture({ transcript });
    panel.handleInput("enter");
    panel.render(100);
    const calls = renderCall.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    transcript.messages.push(assistantMessage([{ type: "text", text: "new live tail" }]));
    expect(panel.render(100).join("\n")).toContain("new live tail");
    expect(renderCall).toHaveBeenCalledTimes(calls);
    panel.dispose();
  });

  it("collapses historical tool output without a loaded tool definition", () => {
    const { panel } = panelFixture({
      transcript: {
        toolDefinitions: [],
        messages: [
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "history",
            content: [
              {
                type: "text",
                text: Array.from({ length: 60 }, (_, i) => `tool-line-${i}`).join("\n"),
              },
            ],
            isError: false,
            timestamp: 2,
          },
        ],
      },
    });
    panel.handleInput("enter");
    expect(panel.render(80).join("\n")).not.toContain("tool-line-59");
    panel.handleInput("expand");
    expect(panel.render(80).join("\n")).toContain("tool-line-59");
    panel.dispose();
  });

  it("keeps the reading position when earlier tool output expands", () => {
    const { panel } = panelFixture({
      transcript: {
        toolDefinitions: [],
        messages: [
          assistantMessage([{ type: "toolCall", id: "call", name: "history", arguments: {} }]),
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "history",
            content: [
              {
                type: "text",
                text: Array.from({ length: 60 }, (_, i) => `tool-line-${i}`).join("\n"),
              },
            ],
            isError: false,
            timestamp: 2,
          },
          ...Array.from({ length: 12 }, (_, i) => ({
            role: "user" as const,
            content: `marker-${i}`,
            timestamp: i + 3,
          })),
        ],
      },
    });
    panel.handleInput("enter");
    expect(panel.render(80).join("\n")).not.toContain("tool-line-59");
    panel.handleInput("pageUp");
    const marker = panel
      .render(80)
      .join("\n")
      .match(/marker-\d+/)?.[0];
    expect(marker).toBeTruthy();
    panel.handleInput("expand");
    expect(
      panel
        .render(80)
        .join("\n")
        .match(/marker-\d+/)?.[0],
    ).toBe(marker);
    panel.dispose();
  });

  it("anchors paused reading to message text when the terminal width changes", () => {
    const text = Array.from({ length: 500 }, (_, i) => `word${i.toString().padStart(3, "0")}`).join(
      " ",
    );
    const { panel } = panelFixture({
      transcript: { messages: [assistantMessage([{ type: "text", text }])], toolDefinitions: [] },
    });
    panel.handleInput("enter");
    panel.render(80);
    panel.handleInput("pageUp");
    const word = panel
      .render(80)
      .join("\n")
      .match(/word\d+/)?.[0];
    expect(word).toBeTruthy();
    expect(panel.render(40).find((line) => /word\d+/.test(line))).toContain(word);
    panel.handleInput("\x1b[F");
    expect(panel.render(40).join("\n")).toContain("word499");
    panel.dispose();
  });

  it("does not emit main-terminal prompt markers from the embedded transcript", () => {
    const { panel } = panelFixture({
      transcript: {
        messages: [{ role: "user", content: "Child prompt", timestamp: 1 }],
        toolDefinitions: [],
      },
    });
    panel.handleInput("enter");
    const rendered = panel.render(80).join("\n");
    expect(rendered).toContain("Child prompt");
    expect(rendered).not.toContain("\x1b]133;");
    panel.dispose();
  });

  it("drops cached tool output when the selected branch retreats before its result", async () => {
    vi.useFakeTimers();
    const call = assistantMessage([
      { type: "toolCall", id: "call", name: "history", arguments: {} },
    ]);
    const { panel, coordinator } = panelFixture({
      transcript: {
        toolDefinitions: [],
        messages: [
          call,
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "history",
            content: [{ type: "text", text: "abandoned branch result" }],
            timestamp: 2,
            isError: false,
          },
        ],
      },
    });
    panel.handleInput("enter");
    expect(panel.render(100).join("\n")).toContain("abandoned branch result");
    coordinator.inspectTranscript.mockReturnValue({ toolDefinitions: [], messages: [call] });
    await vi.advanceTimersByTimeAsync(1_000);
    const retreated = panel.render(100).join("\n");
    expect(retreated).toContain("history");
    expect(retreated).not.toContain("abandoned branch result");
    panel.dispose();
  });

  it("scrolls by single lines through blank padding between native messages", () => {
    const { panel } = panelFixture({
      transcript: {
        toolDefinitions: [],
        messages: Array.from({ length: 30 }, (_, i) => ({
          role: "user" as const,
          content: `message-${i}`,
          timestamp: i,
        })),
      },
    });
    panel.handleInput("enter");
    expect(panel.render(80).join("\n")).toContain("message-29");
    for (let i = 0; i < 12; i++) {
      panel.handleInput("up");
      panel.render(80);
    }
    const earlier = panel.render(80).join("\n");
    expect(earlier).toContain("message-22");
    expect(earlier).not.toContain("message-29");
    panel.dispose();
  });

  it("returns to the tree when the inspected Child Agent disappears", async () => {
    vi.useFakeTimers();
    const { panel, coordinator, onClose } = panelFixture();
    panel.handleInput("enter");
    coordinator.inspectStatus.mockReturnValue({ root_id: "root", agents: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    const tree = panel.render(100).join("\n");
    expect(tree).toContain("no longer available");
    expect(tree).toContain("No Child Agents yet");
    expect(tree).not.toContain("live recent activity");
    expect(onClose).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("releases an injected refresh owner exactly once", () => {
    const stopRefresh = vi.fn();
    const startRefresh = vi.fn(() => stopRefresh);
    const { panel } = panelFixture({ startRefresh });
    expect(startRefresh).toHaveBeenCalledOnce();

    panel.dispose();
    panel.dispose();
    expect(stopRefresh).toHaveBeenCalledOnce();
  });

  it("settles on Escape and clears its refresh timer", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { coordinator, onClose, panel } = panelFixture();
    panel.handleInput("escape");
    expect(onClose).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(coordinator.inspectStatus).toHaveBeenCalledOnce();
  });

  it("opens one centered native overlay and refocuses repeated opens", async () => {
    const { coordinator, panel } = panelFixture();
    panel.dispose();
    const pending = Promise.withResolvers<void>();
    const custom = vi.fn<ExtensionContext["ui"]["custom"]>().mockReturnValue(pending.promise);
    const context = { mode: "tui", cwd: "/project", ui: { custom, notify: vi.fn() } };
    const controller = new MinimalSubagentsStatusPanelController(
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: These typed coordinator methods cover the panel's read-only boundary.
      coordinator as unknown as MinimalSubagentsCoordinator,
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Opening the panel uses only mode, cwd, custom, and notify.
      context as unknown as ExtensionContext,
      () => access,
    );
    const opened = controller.open();
    const options = custom.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
    });
    const focus = vi.fn();
    options?.onHandle?.({
      focus,
      hide: vi.fn(),
      unfocus: vi.fn(),
      setHidden: vi.fn(),
      isHidden: () => false,
      isFocused: () => true,
      getBounds: () => undefined,
    });
    expect(controller.open()).toBe(opened);
    expect(custom).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    pending.resolve();
    await opened;
    controller.dispose();
  });

  it("uses one RPC notification and stays silent in JSON mode", async () => {
    const coordinatorFixture = {
      inspectStatus: vi.fn(() => ({ root_id: "root" as const, agents: [summary("worker")] })),
    } satisfies Pick<MinimalSubagentsCoordinator, "inspectStatus">;
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Non-TUI status only reads the checked inspectStatus mock, never transcript or runtime members.
    const coordinator = coordinatorFixture as unknown as MinimalSubagentsCoordinator;
    const notify = vi.fn<ExtensionContext["ui"]["notify"]>();
    const rpcContext = {
      mode: "rpc",
      cwd: "/project",
      ui: { notify },
    } satisfies Pick<ExtensionContext, "mode" | "cwd"> & {
      ui: Pick<ExtensionContext["ui"], "notify">;
    };
    await new MinimalSubagentsStatusPanelController(
      coordinator,
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The RPC path uses only the checked mode and notify members, with no TUI or session access.
      rpcContext as unknown as ExtensionContext,
      () => access,
    ).open();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Coordinator Tools 3/6"), "info");

    const jsonContext = { ...rpcContext, mode: "json" as const };
    await new MinimalSubagentsStatusPanelController(
      coordinator,
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: JSON mode returns before accessing any framework service; the fixture retains the typed notification recorder.
      jsonContext as unknown as ExtensionContext,
      () => access,
    ).open();
    expect(coordinatorFixture.inspectStatus).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });
});
