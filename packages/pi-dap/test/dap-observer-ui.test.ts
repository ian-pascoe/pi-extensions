import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DapObserverUiController,
  renderDapObserverWidgetLines,
  type DapObserverWidgetTheme,
  type DapObserverWidgetView,
} from "../src/dap-observer-ui.js";

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} satisfies DapObserverWidgetTheme;

function createContext(mode: "tui" | "rpc") {
  const requestRender = vi.fn();
  let component: { render(width: number): string[] } | undefined;
  type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
  const ui = {
    notify: vi.fn(),
    theme: plainTheme,
    setWidget: vi.fn((_key: string, content: string[] | WidgetFactory | undefined) => {
      if (content === undefined || Array.isArray(content)) {
        component = undefined;
        return;
      }
      const tui = { requestRender } satisfies Pick<TUI, "requestRender">;
      const theme = { ...plainTheme } satisfies Pick<Theme, "fg" | "bold">;
      component = content(
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The Observer UI widget only calls requestRender; private TUI state prevents direct structural assignment of this checked partial fixture.
        tui as unknown as TUI,
        // SAFETY: This rendering path uses only fg and bold from the framework Theme.
        theme as Theme,
      );
    }),
  };
  return {
    component: () => component,
    context: { mode, cwd: "/workspace", ui },
    requestRender,
    ui,
  };
}

function widgetText(fixture: ReturnType<typeof createContext>, width = 80): string {
  return fixture.component()?.render(width).join("\n") ?? "";
}

afterEach(() => vi.useRealTimers());

describe("Pi DAP Observer UI", () => {
  const stopped: DapObserverWidgetView = {
    state: "stopped",
    adapterId: "node",
    profileId: "node",
    stopReason: "breakpoint",
    path: "a.ts:4",
    elapsedMs: 18_000,
  };

  test("lays out a bold title with muted counts, then a Status Mark row", () => {
    const rendered = renderDapObserverWidgetLines(stopped, 120, escapeTaggedTheme);
    expectLinesFitWidth(rendered, 120);
    expect(rendered.map(readableTags)).toEqual([
      "<toolTitle><b>DAP</b></toolTitle> <muted>node/node · 18s</muted>",
      "<muted>■</muted> stopped<dim> · </dim><dim>breakpoint</dim><dim> · </dim><muted>a.ts:4</muted>",
    ]);
  });

  test("marks each state from the shared Status Mark set", () => {
    const mark = (view: DapObserverWidgetView) =>
      readableTags(renderDapObserverWidgetLines(view, 120, escapeTaggedTheme)[1] ?? "");
    expect(mark({ state: "running" })).toContain("<accent>●</accent>");
    expect(mark({ state: "launching" })).toContain("<accent>●</accent>");
    expect(mark({ state: "terminated", exitCode: 0 })).toContain("<success>✓</success>");
    expect(mark({ state: "terminated", exitCode: 2 })).toContain("<error>✗</error>");
    expect(mark(stopped)).toContain("<muted>■</muted>");
  });

  test("degrades right-to-left within terminal width", () => {
    const widths = [40, 30, 18, 12, 6];
    const rendered = widths.map((width) =>
      renderDapObserverWidgetLines(stopped, width, plainTheme),
    );
    const text = rendered.map((lines) => lines.join("\n"));
    expect(text[0]).toContain("18s");
    expect(text[0]).toContain("a.ts:4");
    // The path goes first, while the header still fits.
    expect(text[1]).toContain("18s");
    expect(text[1]).not.toContain("a.ts:4");
    expect(text[1]).toContain("breakpoint");
    // Then the duration and the reason.
    expect(text[2]).not.toContain("18s");
    expect(text[2]).toContain("node/node");
    expect(text[2]).not.toContain("breakpoint");
    expect(text[2]).toContain("stopped");
    // Then the profile.
    expect(text[3]).not.toContain("node/node");
    expect(text[3]).toContain("DAP");
    expect(
      rendered.every((lines, index) =>
        lines.every((line) => visibleWidth(line) <= (widths[index] ?? 0)),
      ),
    ).toBe(true);
    for (const width of [40, 120]) {
      expectLinesFitWidth(renderDapObserverWidgetLines(stopped, width, escapeTaggedTheme), width);
    }
  });

  test("mounts on launch, updates in place, clears stopped location on resume, and refreshes duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fixture = createContext("tui");
    const controller = new DapObserverUiController(fixture.context);

    controller.onToolStart({ operation: "launch", profile: "node", program: "src/app.ts" });
    expect(fixture.ui.setWidget).toHaveBeenCalledOnce();
    expect(fixture.ui.setWidget.mock.calls[0]?.[0]).toBe("pi-dap");
    expect(widgetText(fixture)).toContain("launching");

    controller.onSessionSnapshot({
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "breakpoint",
      threadId: 1,
    });
    controller.onToolSuccess(
      { operation: "stack" },
      {
        snapshot: {
          state: "stopped",
          adapterId: "node",
          profileId: "node",
          stopReason: "breakpoint",
          threadId: 1,
        },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        stackFrames: [
          {
            id: 1,
            name: "main",
            line: 42,
            column: 1,
            source: { path: "/workspace/src/app.ts" },
          },
        ],
      },
    );
    expect(widgetText(fixture)).toContain("src/app.ts:42");
    expect(fixture.ui.setWidget).toHaveBeenCalledOnce();

    controller.onSessionSnapshot({ state: "running", adapterId: "node", profileId: "node" });
    expect(widgetText(fixture)).toContain("src/app.ts");
    expect(widgetText(fixture)).not.toContain(":42");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.requestRender).toHaveBeenCalled();
    controller.dispose();
  });

  test("shows the stopped source location from a stop result's top Stack Frame", () => {
    const fixture = createContext("tui");
    const controller = new DapObserverUiController(fixture.context);
    controller.onToolStart({ operation: "continue" });
    const snapshot = {
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "breakpoint",
      threadId: 1,
    } as const;
    controller.onSessionSnapshot(snapshot);

    controller.onToolSuccess(
      { operation: "continue" },
      {
        snapshot,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        stop: {
          topFrame: {
            id: 1,
            name: "add",
            line: 3,
            column: 5,
            source: { path: "/workspace/src/app.ts" },
          },
        },
      },
    );

    expect(widgetText(fixture)).toContain("src/app.ts:3");
    controller.dispose();
  });

  test("keeps termination for ten seconds and a new launch cancels the old cooldown", async () => {
    vi.useFakeTimers();
    const fixture = createContext("tui");
    const controller = new DapObserverUiController(fixture.context);
    controller.onToolStart({ operation: "launch", program: "app.ts" });
    controller.onSessionSnapshot({
      state: "terminated",
      adapterId: "node",
      profileId: "node",
      exitCode: 0,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fixture.component()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.component()).toBeUndefined();

    controller.onToolStart({ operation: "launch", program: "app.ts" });
    controller.onSessionSnapshot({
      state: "terminated",
      adapterId: "node",
      profileId: "node",
      exitCode: 0,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    controller.onToolStart({ operation: "launch", program: "next.ts" });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetText(fixture)).toContain("next.ts");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.component()).toBeDefined();
    controller.dispose();
    controller.dispose();
    expect(fixture.ui.setWidget).toHaveBeenLastCalledWith("pi-dap", undefined);
  });

  test("is inert outside TUI and notifies only unrepresented asynchronous failures", () => {
    const rpc = createContext("rpc");
    const rpcController = new DapObserverUiController(rpc.context);
    rpcController.onToolStart({ operation: "launch" });
    rpcController.onUnexpectedFailure(new Error("adapter failed"));
    rpcController.dispose();
    expect(rpc.ui.setWidget).not.toHaveBeenCalled();

    const tui = createContext("tui");
    const controller = new DapObserverUiController(tui.context);
    controller.onToolStart({ operation: "continue" });
    controller.onUnexpectedFailure(new Error("represented"));
    expect(tui.ui.notify).not.toHaveBeenCalled();
    controller.onToolFailure({ operation: "continue" }, new Error("represented"));
    controller.onUnexpectedFailure(new Error("asynchronous"));
    expect(tui.ui.notify).toHaveBeenCalledWith("DAP: asynchronous", "error");
    controller.onUnexpectedFailure(new Error("Pi DAP: prefixed"));
    expect(tui.ui.notify).toHaveBeenLastCalledWith("DAP: prefixed", "error");
  });
});
