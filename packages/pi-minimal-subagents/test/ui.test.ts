import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MinimalSubagentsCoordinator } from "../src/minimal-subagents-coordinator.js";
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
  const context = {
    mode,
    ui: { setWidget: vi.fn<ExtensionContext["ui"]["setWidget"]>() },
  };
  return {
    ...context,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The controller reads only mode and the typed setWidget mock; recorded widget factories are not mounted.
    frameworkContext: context as unknown as ExtensionContext,
  };
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

  it("orders active subtrees first with stable siblings and parents before descendants", () => {
    const completed = { turn_id: "done", status: "completed" } as const;
    const agents = [
      summary("idle-first", { latest_turn: completed }),
      summary("parent", {
        children: [
          summary("parent.idle", { parent_id: "parent", latest_turn: completed }),
          summary("parent.nested", {
            parent_id: "parent",
            children: [
              summary("parent.nested.running", {
                parent_id: "parent.nested",
                state: "running",
              }),
            ],
          }),
          summary("parent.running", { parent_id: "parent", state: "running" }),
        ],
      }),
      summary("running-root", { state: "running", latest_turn: completed }),
      summary("idle-last", { latest_turn: completed }),
    ];
    const original = structuredClone(agents);

    const view = buildMinimalSubagentsWidgetView(createHierarchyStatus(agents));

    expect(view.rows.map(({ agentId, depth }) => [agentId, depth])).toEqual([
      ["parent", 0],
      ["parent.nested", 1],
      ["parent.nested.running", 2],
      ["parent.running", 1],
      ["parent.idle", 1],
      ["running-root", 0],
      ["idle-first", 0],
      ["idle-last", 0],
    ]);
    expect(agents).toEqual(original);
  });

  it("keeps original recent-candidate ties when presentation moves an active subtree", () => {
    const completed = { turn_id: "done", status: "completed" } as const;
    const view = buildMinimalSubagentsWidgetView(
      createHierarchyStatus([
        summary("done-first", { latest_turn: completed }),
        summary("done-second", { latest_turn: completed }),
        summary("done-third", { latest_turn: completed }),
        summary("parent", {
          latest_turn: completed,
          children: [summary("parent.running", { parent_id: "parent", state: "running" })],
        }),
      ]),
    );

    expect(view.rows.map(({ agentId }) => agentId)).toEqual([
      "parent",
      "parent.running",
      "done-first",
      "done-second",
      "done-third",
    ]);
    expect(view.rows[0]?.structural).toBe(true);
    expect(view.recentCount).toBe(3);
  });

  it("uses complete subtree activity even when the row budget excludes its running descendant", () => {
    const completed = { turn_id: "done", status: "completed" } as const;
    const view = buildMinimalSubagentsWidgetView(
      createHierarchyStatus([
        summary("idle-first", { latest_turn: completed }),
        ...Array.from({ length: 6 }, (_, index) =>
          summary(`running-${index}`, { state: "running" }),
        ),
        summary("parent", {
          latest_turn: completed,
          children: [
            summary("parent.middle", {
              parent_id: "parent",
              children: [
                summary("parent.middle.running", {
                  parent_id: "parent.middle",
                  state: "running",
                }),
              ],
            }),
          ],
        }),
      ]),
    );

    expect(view.rows.map(({ agentId }) => agentId)).toEqual([
      "running-0",
      "running-1",
      "running-2",
      "running-3",
      "running-4",
      "running-5",
      "parent",
      "idle-first",
    ]);
    expect(view.runningCount).toBe(7);
    expect(view.recentCount).toBe(2);
    expect(view.overflowCount).toBe(2);
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
    const coordinator = { inspectStatus: () => status } satisfies Pick<
      MinimalSubagentsCoordinator,
      "inspectStatus"
    >;
    const controller = new MinimalSubagentsUiController(
      // SAFETY: The widget controller reads only inspectStatus from this checked coordinator fixture.
      coordinator as MinimalSubagentsCoordinator,
      context.frameworkContext,
    );
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
    const coordinator = { inspectStatus: () => status } satisfies Pick<
      MinimalSubagentsCoordinator,
      "inspectStatus"
    >;
    const controller = new MinimalSubagentsUiController(
      // SAFETY: The cooldown path reads only inspectStatus from this checked coordinator fixture.
      coordinator as MinimalSubagentsCoordinator,
      context.frameworkContext,
    );
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
    const inspectStatus = vi.fn<MinimalSubagentsCoordinator["inspectStatus"]>();
    const coordinator = { inspectStatus } satisfies Pick<
      MinimalSubagentsCoordinator,
      "inspectStatus"
    >;
    const controller = new MinimalSubagentsUiController(
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: RPC must not inspect the coordinator; its only widget dependency is the typed inspectStatus mock.
      coordinator as unknown as MinimalSubagentsCoordinator,
      createUiContext("rpc").frameworkContext,
    );
    controller.refresh();
    controller.dispose();
    expect(inspectStatus).not.toHaveBeenCalled();
  });
});
