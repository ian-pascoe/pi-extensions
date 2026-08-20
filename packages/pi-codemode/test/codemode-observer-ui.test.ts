import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildCodeModeObserverView,
  CodeModeObserverUiController,
  renderCodeModeObserverWidgetLines,
  type CodeModeObserverUiContext,
  type CodeModeObserverUiRuntime,
  type CodeModeObserverWidgetTheme,
} from "../src/codemode-observer-ui.js";
import type {
  CodeModeObserverSnapshot,
  CodeModeSessionId,
} from "../src/codemode-session-coordinator.js";

const plainTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
} satisfies CodeModeObserverWidgetTheme;

function sessionId(value: string): CodeModeSessionId {
  // SAFETY: Coordinator-created Session IDs are branded after validation; these fixtures use the same non-empty identifier shape.
  return value as CodeModeSessionId;
}

function emptySnapshot(): CodeModeObserverSnapshot {
  return { sessions: [] };
}

type ObserverWidgetFactory = Exclude<
  Parameters<CodeModeObserverUiContext["ui"]["setWidget"]>[1],
  undefined
>;
function createControllerContext(mode: "tui" | "rpc") {
  let widgetFactory: ObserverWidgetFactory | undefined;
  const setWidget = vi.fn(
    (
      _key: string,
      widget: ObserverWidgetFactory | undefined,
      _options?: { readonly placement: "aboveEditor" },
    ) => {
      widgetFactory = widget;
    },
  );
  const setStatus = vi.fn((_key: string, _status: string | undefined) => {});
  const notify = vi.fn((_message: string, _level: "info" | "warning" | "error") => {});
  const context: CodeModeObserverUiContext = {
    mode,
    ui: { notify, setStatus, setWidget, theme: plainTheme },
  };
  return {
    context,
    notify,
    setStatus,
    setWidget,
    mountedWidgetFactory: (): ObserverWidgetFactory => {
      if (widgetFactory === undefined) throw new Error("Expected CodeMode Observer widget factory");
      return widgetFactory;
    },
  };
}

function createTimerRuntime(): CodeModeObserverUiRuntime {
  return {
    now: () => Date.now(),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
}

function createTui() {
  const requestRender = vi.fn();
  return { tui: { requestRender }, requestRender };
}

function plain(text: string | undefined): string | undefined {
  return text === undefined ? undefined : stripTerminalSequences(text);
}

afterEach(() => vi.useRealTimers());

describe("CodeMode Observer UI", () => {
  test("projects unique prefixes, active details, recency ordering, terminal states, and overflow", () => {
    const sessions: CodeModeObserverSnapshot["sessions"] = [
      {
        sessionId: sessionId("aaaaaaaa-1111-running"),
        lifecycle: "running",
        cell_count: 2,
        last_activity_at_ms: 9_000,
        current_cell: {
          ordinal: 2,
          started_at_ms: 8_500,
          active_tool_names: ["read", "\u001b[31mgrep\u001b[0m", "exec_command", "fourth"],
          active_tool_count: 5,
          nested_tool_count: 7,
        },
      },
      {
        sessionId: sessionId("aaaaaaaa-2222-idle"),
        lifecycle: "idle",
        cell_count: 3,
        last_activity_at_ms: 8_000,
      },
      {
        sessionId: sessionId("bbbbbbbb-terminal-cancelled"),
        lifecycle: "terminal",
        cell_count: 1,
        last_activity_at_ms: 7_000,
        terminal_error_code: "cancellation",
        last_cell: {
          ordinal: 1,
          started_at_ms: 6_000,
          settled_at_ms: 7_000,
          state: "cancelled",
          error_code: "cancellation",
          nested_tool_count: 0,
        },
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        sessionId: sessionId(`session-${index}-terminal`),
        lifecycle: "terminal" as const,
        cell_count: index + 1,
        last_activity_at_ms: 6_000 - index,
        terminal_error_code: index === 0 ? ("timeout" as const) : ("runtime" as const),
      })),
    ];

    const view = buildCodeModeObserverView({ sessions }, 10_000);

    expect(view.runningCount).toBe(1);
    expect(view.liveCount).toBe(2);
    expect(view.rows).toHaveLength(8);
    expect(view.overflowCount).toBe(2);
    expect(view.rows.slice(0, 3)).toMatchObject([
      {
        sessionPrefix: "aaaaaaaa-1",
        state: "running",
        cellOrdinal: 2,
        elapsedMs: 1_500,
        activeToolNames: ["read", "grep", "exec_command"],
        activeToolCount: 5,
      },
      { sessionPrefix: "aaaaaaaa-2", state: "idle", cellCount: 3 },
      { sessionPrefix: "bbbbbbbb", state: "cancelled", cellOrdinal: 1 },
    ]);
    expect(view.rows.find((row) => row.sessionPrefix === "session-0")?.state).toBe("timed_out");
  });

  test("renders semantic status rows and degrades rightmost detail within every terminal width", () => {
    const view = buildCodeModeObserverView(
      {
        sessions: [
          {
            sessionId: sessionId("12345678-running"),
            lifecycle: "running",
            cell_count: 4,
            last_activity_at_ms: 1_000,
            current_cell: {
              ordinal: 4,
              started_at_ms: 0,
              active_tool_names: ["read", "grep"],
              active_tool_count: 3,
              nested_tool_count: 3,
            },
          },
          {
            sessionId: sessionId("abcdefgh-idle"),
            lifecycle: "idle",
            cell_count: 2,
            last_activity_at_ms: 900,
          },
          {
            sessionId: sessionId("terminal-failed"),
            lifecycle: "terminal",
            cell_count: 1,
            last_activity_at_ms: 800,
            terminal_error_code: "runtime",
          },
        ],
      },
      1_250,
    );

    const wide = renderCodeModeObserverWidgetLines(view, 120, plainTheme);
    expect(wide).toEqual([
      "CodeMode  ·  2 live  ·  1 running",
      "  ◉ 12345678  ·  running  ·  Cell 4  ·  1.3s  ·  read, grep +1",
      "  ○ abcdefgh  ·  idle  ·  2 Cells",
      "  × terminal  ·  failed  ·  Cell 1",
    ]);

    const medium = renderCodeModeObserverWidgetLines(view, 45, plainTheme);
    expect(medium[1]).not.toContain("read");
    expect(medium[1]).toContain("1.3s");
    const narrow = renderCodeModeObserverWidgetLines(view, 20, plainTheme);
    expect(narrow[1]).not.toContain("1.3s");
    for (const width of [1, 8, 20, 45, 120]) {
      const lines = renderCodeModeObserverWidgetLines(view, width, plainTheme);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  test("omits terminal Sessions after the ten-second Observer cooldown", () => {
    const view = buildCodeModeObserverView(
      {
        sessions: [
          {
            sessionId: sessionId("expired-terminal"),
            lifecycle: "terminal",
            cell_count: 1,
            last_activity_at_ms: 1_000,
            terminal_error_code: "runtime",
          },
        ],
      },
      11_000,
    );

    expect(view.rows).toEqual([]);
  });

  test("mounts immediately, refreshes elapsed time recursively, then cools down and hides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { context, mountedWidgetFactory, setStatus, setWidget } = createControllerContext("tui");
    const controller = new CodeModeObserverUiController(context, createTimerRuntime());
    const running: CodeModeObserverSnapshot = {
      sessions: [
        {
          sessionId: sessionId("12345678-running"),
          lifecycle: "running",
          cell_count: 1,
          last_activity_at_ms: 1_000,
          current_cell: {
            ordinal: 1,
            started_at_ms: 1_000,
            active_tool_names: [],
            active_tool_count: 0,
            nested_tool_count: 0,
          },
        },
      ],
    };

    controller.onSnapshotChange(running);
    expect(setWidget).toHaveBeenCalledWith("codemode-observer", expect.any(Function), {
      placement: "aboveEditor",
    });
    expect(plain(setStatus.mock.calls.at(-1)?.[1])).toBe("◉ 1 running · 1 live");

    const { requestRender, tui } = createTui();
    const component = mountedWidgetFactory()(tui, plainTheme);
    expect(component.render(80)[1]).toContain("0ms");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(component.render(80)[1]).toContain("1.0s");
    expect(requestRender).toHaveBeenCalledOnce();

    controller.onSnapshotChange({
      sessions: [
        {
          sessionId: sessionId("12345678-running"),
          lifecycle: "idle",
          cell_count: 1,
          last_activity_at_ms: 2_000,
        },
      ],
    });
    expect(setStatus).toHaveBeenLastCalledWith("codemode-observer", undefined);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(setWidget).not.toHaveBeenLastCalledWith("codemode-observer", undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(setWidget).toHaveBeenLastCalledWith("codemode-observer", undefined);
  });

  test("deduplicates unexpected failure notifications and disposes UI and timers once", async () => {
    vi.useFakeTimers();
    const { context, notify, setStatus, setWidget } = createControllerContext("tui");
    const controller = new CodeModeObserverUiController(context, createTimerRuntime());
    controller.onSnapshotChange({
      sessions: [
        {
          sessionId: sessionId("12345678-running"),
          lifecycle: "running",
          cell_count: 1,
          last_activity_at_ms: 0,
          current_cell: {
            ordinal: 1,
            started_at_ms: 0,
            active_tool_names: [],
            active_tool_count: 0,
            nested_tool_count: 0,
          },
        },
      ],
    });
    controller.onUnexpectedFailure({
      sessionId: sessionId("12345678-running"),
      message: "\u001b[31mworker died\u001b[0m\u0007",
    });
    controller.onUnexpectedFailure({
      sessionId: sessionId("12345678-running"),
      message: "worker died again",
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      "CodeMode Session 12345678-running stopped unexpectedly: worker died",
      "error",
    );

    controller.dispose();
    controller.dispose();
    expect(setStatus).toHaveBeenLastCalledWith("codemode-observer", undefined);
    expect(setWidget).toHaveBeenLastCalledWith("codemode-observer", undefined);
    const widgetCalls = setWidget.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(setWidget).toHaveBeenCalledTimes(widgetCalls);
  });

  test("isolates throwing TUI methods and redraws from CodeMode lifecycle", async () => {
    vi.useFakeTimers();
    const running: CodeModeObserverSnapshot = {
      sessions: [
        {
          sessionId: sessionId("12345678-running"),
          lifecycle: "running",
          cell_count: 1,
          last_activity_at_ms: 0,
          current_cell: {
            ordinal: 1,
            started_at_ms: 0,
            active_tool_names: [],
            active_tool_count: 0,
            nested_tool_count: 0,
          },
        },
      ],
    };
    const throwingContext: CodeModeObserverUiContext = {
      mode: "tui",
      ui: {
        theme: plainTheme,
        notify: () => {
          throw new Error("notify failed");
        },
        setStatus: () => {
          throw new Error("status failed");
        },
        setWidget: () => {
          throw new Error("widget failed");
        },
      },
    };
    const throwingController = new CodeModeObserverUiController(
      throwingContext,
      createTimerRuntime(),
    );
    expect(() => throwingController.onSnapshotChange(running)).not.toThrow();
    expect(() =>
      throwingController.onUnexpectedFailure({
        sessionId: sessionId("12345678-running"),
        message: "worker failed",
      }),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(() => throwingController.dispose()).not.toThrow();

    const { context, mountedWidgetFactory } = createControllerContext("tui");
    const redrawController = new CodeModeObserverUiController(context, createTimerRuntime());
    redrawController.onSnapshotChange(running);
    mountedWidgetFactory()(
      {
        requestRender: () => {
          throw new Error("redraw failed");
        },
      },
      plainTheme,
    );
    expect(() => redrawController.onSnapshotChange(running)).not.toThrow();
    redrawController.dispose();
  });

  test("is completely inert outside TUI mode", () => {
    vi.useFakeTimers();
    const { context, notify, setStatus, setWidget } = createControllerContext("rpc");
    const controller = new CodeModeObserverUiController(context, createTimerRuntime());
    controller.onSnapshotChange(emptySnapshot());
    controller.onUnexpectedFailure({
      sessionId: sessionId("12345678-rpc"),
      message: "worker died",
    });
    controller.dispose();
    expect(setWidget).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
