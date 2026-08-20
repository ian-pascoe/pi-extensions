import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DapObserverUiController,
  renderDapObserverWidgetLine,
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
      const tui: TUI = Object.create(null);
      tui.requestRender = requestRender;
      const theme: Theme = Object.create(null);
      theme.fg = plainTheme.fg;
      theme.bold = plainTheme.bold;
      component = content(tui, theme);
    }),
  };
  return {
    component: () => component,
    context: { mode, cwd: "/workspace", ui },
    requestRender,
    ui,
  };
}

afterEach(() => vi.useRealTimers());

describe("Pi DAP Observer UI", () => {
  test("renders the wide hierarchy and degrades right-to-left within terminal width", () => {
    const view: DapObserverWidgetView = {
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "breakpoint",
      path: "a.ts:4",
      elapsedMs: 18_000,
    };
    expect(renderDapObserverWidgetLine(view, 80, plainTheme)).toBe(
      "DAP  ● stopped · breakpoint  node/node  a.ts:4  18s",
    );
    const widths = [55, 39, 20];
    const lines = widths.map((width) => renderDapObserverWidgetLine(view, width, plainTheme));
    expect(lines[0]).toContain("18s");
    expect(lines[1]).not.toContain("a.ts:4");
    expect(lines[1]).toContain("node/node");
    expect(lines[2]).toContain("DAP");
    expect(lines[2]).toContain("stopped");
    expect(
      lines.every((line, index) => {
        const width = widths[index];
        return width !== undefined && visibleWidth(line) <= width;
      }),
    ).toBe(true);

    const withoutDuration = renderDapObserverWidgetLine(view, 48, plainTheme);
    expect(withoutDuration).not.toContain("18s");
    expect(withoutDuration).toContain("a.ts:4");
    const withoutPath = renderDapObserverWidgetLine(view, 39, plainTheme);
    expect(withoutPath).toContain("node/node");
    const withoutProfile = renderDapObserverWidgetLine(view, 32, plainTheme);
    expect(withoutProfile).toContain("breakpoint");
    expect(withoutProfile).not.toContain("node/node");
  });

  test("keeps ANSI-styled Unicode views within every practical terminal width", () => {
    const ansiTheme = {
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
      fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m`,
    } satisfies DapObserverWidgetTheme;
    const view: DapObserverWidgetView = {
      state: "stopped",
      adapterId: "node界",
      profileId: "node🙂",
      stopReason: "breakpoint",
      path: "src/ネットワーク/🙂.ts:42",
      elapsedMs: 65_000,
    };
    for (let width = 1; width <= 120; width++) {
      expect(visibleWidth(renderDapObserverWidgetLine(view, width, ansiTheme))).toBeLessThanOrEqual(
        width,
      );
    }
  });

  test("mounts on launch, updates in place, clears stopped location on resume, and refreshes duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fixture = createContext("tui");
    const controller = new DapObserverUiController(fixture.context);

    controller.onToolStart({ operation: "launch", profile: "node", program: "src/app.ts" });
    expect(fixture.ui.setWidget).toHaveBeenCalledOnce();
    expect(fixture.component()?.render(80)[0]).toContain("launching");

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
    expect(fixture.component()?.render(80)[0]).toContain("src/app.ts:42");
    expect(fixture.ui.setWidget).toHaveBeenCalledOnce();

    controller.onSessionSnapshot({ state: "running", adapterId: "node", profileId: "node" });
    expect(fixture.component()?.render(80)[0]).toContain("src/app.ts");
    expect(fixture.component()?.render(80)[0]).not.toContain(":42");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.requestRender).toHaveBeenCalled();
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
    expect(fixture.component()?.render(80)[0]).toContain("next.ts");
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
    expect(tui.ui.notify).toHaveBeenCalledWith("Pi DAP: asynchronous", "error");
  });
});
