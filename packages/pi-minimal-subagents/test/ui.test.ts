import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildMinimalSubagentsWidgetView,
  MinimalSubagentsUiController,
  renderMinimalSubagentsWidgetLines,
  type MinimalSubagentsWidgetTheme,
} from "../src/minimal-subagents-ui.js";
import type { AgentSummary } from "../src/minimal-subagents-types.js";

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
    ...overrides,
  };
}

const passthroughTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
} satisfies MinimalSubagentsWidgetTheme;

function createUiContext(mode: "tui" | "rpc") {
  const context = Object.create(null);
  context.mode = mode;
  context.ui = {
    setWidget: vi.fn(),
    theme: passthroughTheme,
  };
  return context;
}

function createHierarchyStatus(agents: AgentSummary[]) {
  return { root_id: "root" as const, agents };
}

afterEach(() => vi.useRealTimers());

describe("minimal subagents UI", () => {
  it("retains active descendants with structural ancestors and bounds recent rows", () => {
    const runningChild = summary("parent.running", {
      parent_id: "parent",
      state: "running",
      active_turn_id: "turn",
      task: "active work",
    });
    const parent = summary("parent", { children: [runningChild], child_count: 1 });
    const failed = summary("failed", {
      availability: "unavailable",
      latest_activity_at: "2026-01-03T00:00:00.000Z",
    });
    const completed = [1, 2, 3, 4].map((index) =>
      summary(`done-${index}`, {
        latest_turn: { turn_id: `turn-${index}`, status: "completed" },
        latest_activity_at: `2026-01-0${index}T00:00:00.000Z`,
      }),
    );
    const view = buildMinimalSubagentsWidgetView({
      root_id: "root",
      agents: [parent, failed, ...completed],
    });
    expect(view.runningCount).toBe(1);
    expect(view.recentCount).toBe(3);
    expect(view.rows.find(({ agentId }) => agentId === "parent")).toMatchObject({
      structural: true,
      runtimeProfile: { model: "provider/model", thinking_level: "medium" },
    });
    expect(view.rows.find(({ agentId }) => agentId === "parent.running")).toMatchObject({
      structural: false,
      status: "running",
    });
    expect(view.rows.some(({ agentId }) => agentId === "failed")).toBe(true);
  });

  it("degrades task, model detail, and duration before truncating the row", () => {
    const baseView = (width: number) =>
      renderMinimalSubagentsWidgetLines(
        {
          runningCount: 1,
          recentCount: 0,
          overflowCount: 0,
          rows: [
            {
              agentId: "worker",
              depth: 1,
              status: "running",
              elapsedMs: 12_000,
              runtimeProfile: {
                model: "provider/model:variant",
                thinking_level: "high",
              },
              task: "inspect the runtime",
              structural: false,
            },
          ],
        },
        width,
        passthroughTheme,
      )[1]!;

    expect(baseView(80)).toBe("  ╰─ ◉ worker  ·  running 12s  ·  provider/model:variant:high");
    expect(baseView(55)).toBe("  ╰─ ◉ worker  ·  running 12s  ·  provider/model:…:high");
    expect(baseView(39)).toBe("  ╰─ ◉ worker  ·  running  ·  pro…:high");
    const lastResort = baseView(20);
    expect(visibleWidth(lastResort)).toBeLessThanOrEqual(20);
    expect(lastResort).not.toContain("inspect");
  });

  it("mounts during activity, cools down after completion, and disposes timers and UI", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let status = createHierarchyStatus([summary("worker", { state: "running" })]);
    const context = createUiContext("tui");
    const coordinator = Object.create(null);
    coordinator.inspectStatus = () => status;
    const controller = new MinimalSubagentsUiController(coordinator, context);
    controller.refresh();
    controller.refresh();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(context.ui.setWidget).toHaveBeenCalledWith("minimal-subagents", expect.any(Function), {
      placement: "aboveEditor",
    });
    status = createHierarchyStatus([
      summary("worker", {
        latest_turn: { turn_id: "turn", status: "completed" },
        latest_activity_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    controller.refresh();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    controller.dispose();
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(context.ui.setWidget).toHaveBeenLastCalledWith("minimal-subagents", undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(context.ui.setWidget).toHaveBeenCalledTimes(2);
  });

  it("keeps the completed view visible only for the cooldown window", async () => {
    vi.useFakeTimers();
    let status = createHierarchyStatus([summary("worker", { state: "running" })]);
    const context = createUiContext("tui");
    const coordinator = Object.create(null);
    coordinator.inspectStatus = () => status;
    const controller = new MinimalSubagentsUiController(coordinator, context);
    controller.refresh();
    status = createHierarchyStatus([
      summary("worker", {
        latest_turn: { turn_id: "turn", status: "completed" },
        latest_activity_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    controller.refresh();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(context.ui.setWidget).not.toHaveBeenLastCalledWith("minimal-subagents", undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(context.ui.setWidget).toHaveBeenLastCalledWith("minimal-subagents", undefined);
  });

  it("is inert outside TUI mode", () => {
    const inspectStatus = vi.fn();
    const coordinator = Object.create(null);
    coordinator.inspectStatus = inspectStatus;
    const controller = new MinimalSubagentsUiController(coordinator, createUiContext("rpc"));
    controller.refresh();
    controller.dispose();
    expect(inspectStatus).not.toHaveBeenCalled();
  });
});
