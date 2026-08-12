import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildMinimalSubagentsWidgetView,
  MinimalSubagentsUiController,
  renderMinimalSubagentsWidgetLines,
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

  it("renders the status, duration, Runtime Profile, and task in the agreed order", () => {
    const lines = renderMinimalSubagentsWidgetLines(
      {
        runningCount: 1,
        retainedCount: 1,
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
      120,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
    );
    expect(lines[1]).toBe(
      "  ╰─ ◉ worker  ·  running 12s  ·  provider/model:variant:high  ·  inspect the runtime",
    );
  });

  it("degrades task, model detail, and duration before truncating the row", () => {
    const baseView = (width: number) =>
      renderMinimalSubagentsWidgetLines(
        {
          runningCount: 1,
          retainedCount: 1,
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
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
      )[1]!;

    expect(baseView(80)).toBe("  ╰─ ◉ worker  ·  running 12s  ·  provider/model:variant:high");
    expect(baseView(55)).toBe("  ╰─ ◉ worker  ·  running 12s  ·  provider/model:…:high");
    expect(baseView(39)).toBe("  ╰─ ◉ worker  ·  running  ·  pro…:high");
    const lastResort = baseView(20);
    expect(visibleWidth(lastResort)).toBeLessThanOrEqual(20);
    expect(lastResort).not.toContain("inspect");
  });

  it("omits stale duration while retaining the Runtime Profile for unavailable rows", () => {
    const lines = renderMinimalSubagentsWidgetLines(
      {
        runningCount: 0,
        retainedCount: 1,
        recentCount: 1,
        overflowCount: 0,
        rows: [
          {
            agentId: "missing",
            depth: 0,
            status: "unavailable",
            elapsedMs: 12_000,
            runtimeProfile: { model: "provider/model", thinking_level: "medium" },
            structural: false,
          },
        ],
      },
      100,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
    );
    expect(lines[1]).toBe("  ! missing  ·  unavailable  ·  provider/model:medium");
  });

  it("renders every line within terminal width", () => {
    const lines = renderMinimalSubagentsWidgetLines(
      {
        runningCount: 1,
        retainedCount: 1,
        recentCount: 0,
        overflowCount: 2,
        rows: [
          {
            agentId: "very-long-agent-identifier",
            depth: 1,
            status: "running",
            runtimeProfile: { model: "provider/model", thinking_level: "medium" },
            task: "a deliberately long task description",
            structural: false,
          },
        ],
      },
      20,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
    );
    expect(lines.length).toBe(3);
    expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
  });

  it("mounts during activity, cools down after completion, and disposes timers and UI", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let status = { root_id: "root" as const, agents: [summary("worker", { state: "running" })] };
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const controller = new MinimalSubagentsUiController(
      { inspectStatus: () => status } as never,
      {
        mode: "tui",
        ui: {
          setWidget,
          setStatus,
          theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        },
      } as never,
    );
    controller.refresh();
    controller.refresh();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(setWidget).toHaveBeenCalledWith("minimal-subagents", expect.any(Function), {
      placement: "aboveEditor",
    });
    status = {
      root_id: "root",
      agents: [
        summary("worker", {
          latest_turn: { turn_id: "turn", status: "completed" },
          latest_activity_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    };
    controller.refresh();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    controller.dispose();
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenLastCalledWith("minimal-subagents", undefined);
    expect(setWidget).toHaveBeenLastCalledWith("minimal-subagents", undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(setWidget).toHaveBeenCalledTimes(2);
  });

  it("keeps the completed view visible only for the cooldown window", async () => {
    vi.useFakeTimers();
    let status = { root_id: "root" as const, agents: [summary("worker", { state: "running" })] };
    const setWidget = vi.fn();
    const controller = new MinimalSubagentsUiController(
      { inspectStatus: () => status } as never,
      {
        mode: "tui",
        ui: {
          setWidget,
          setStatus: vi.fn(),
          theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        },
      } as never,
    );
    controller.refresh();
    status = {
      root_id: "root",
      agents: [
        summary("worker", {
          latest_turn: { turn_id: "turn", status: "completed" },
          latest_activity_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    };
    controller.refresh();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(setWidget).not.toHaveBeenLastCalledWith("minimal-subagents", undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(setWidget).toHaveBeenLastCalledWith("minimal-subagents", undefined);
  });

  it("is inert outside TUI mode", () => {
    const inspectStatus = vi.fn();
    const controller = new MinimalSubagentsUiController(
      { inspectStatus } as never,
      { mode: "rpc", ui: { setWidget: vi.fn(), setStatus: vi.fn() } } as never,
    );
    controller.refresh();
    controller.dispose();
    expect(inspectStatus).not.toHaveBeenCalled();
  });
});
