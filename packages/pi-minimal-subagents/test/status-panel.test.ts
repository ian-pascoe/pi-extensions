import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  initTheme,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
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
  } satisfies Pick<Theme, "fg" | "bold">;
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
  } satisfies Pick<KeybindingsManager, "matches">;
  const onClose = vi.fn();
  const panel = new MinimalSubagentsStatusPanelComponent(
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel reads only these two checked coordinator methods; both remain observable typed mocks.
    coordinator as unknown as MinimalSubagentsCoordinator,
    () => access,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel uses only checked terminal dimensions and the typed requestRender mock, not a full terminal runtime.
    tui as unknown as TUI,
    // SAFETY: These panel render paths use only the checked fg and bold theme methods.
    theme as Theme,
    // SAFETY: Panel input dispatch reads only the checked matches method.
    keybindings as KeybindingsManager,
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

  it("refreshes expanded rows once per second and preserves bounded rendering", async () => {
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
    expect(paged).toContain("worker-19");
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
