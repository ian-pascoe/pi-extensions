import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  callDurationFooter,
  durationFooter,
  type DurationContext,
  expandHint,
  footerStatus,
  noticeText,
  previewBody,
  statusMark,
  summaryExpandHint,
  toolHeader,
  treePrefix,
  widgetLines,
} from "../src/ui.js";
import { expectLinesFitWidth, taggedTheme } from "../src/ui-testing.js";

beforeAll(() => {
  initTheme("dark");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

describe("toolHeader", () => {
  it("leads with the bold toolTitle name, then the accent target, then muted arguments", () => {
    expect(toolHeader(taggedTheme, "lsp_hover", "src/a.ts:3", "server=ts")).toBe(
      "<toolTitle><b>lsp_hover</b></toolTitle> <accent>src/a.ts:3</accent> <muted>server=ts</muted>",
    );
  });

  it("omits absent target and arguments", () => {
    expect(toolHeader(taggedTheme, "todo")).toBe("<toolTitle><b>todo</b></toolTitle>");
  });
});

describe("statusMark", () => {
  it("colours each state from its theme role", () => {
    expect(statusMark(taggedTheme, "active")).toBe("<accent>●</accent>");
    expect(statusMark(taggedTheme, "idle")).toBe("<dim>○</dim>");
    expect(statusMark(taggedTheme, "done")).toBe("<success>✓</success>");
    expect(statusMark(taggedTheme, "failed")).toBe("<error>✗</error>");
    expect(statusMark(taggedTheme, "warning")).toBe("<warning>!</warning>");
    expect(statusMark(taggedTheme, "stopped")).toBe("<muted>■</muted>");
  });
});

describe("previewBody", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);

  it("keeps the head and appends Pi's expand hint when collapsed", () => {
    const rendered = previewBody(taggedTheme, lines, { limit: 10, expanded: false });
    expect(rendered).toHaveLength(11);
    expect(rendered[0]).toBe("<toolOutput>line 1</toolOutput>");
    expect(rendered[10]).toContain("<muted>... (2 more lines,</muted> <dim>ctrl+o</dim>");
  });

  it("keeps the tail and says earlier lines when keep is end", () => {
    const rendered = previewBody(taggedTheme, lines, { limit: 5, expanded: false, keep: "end" });
    expect(rendered[0]).toContain("<muted>... (7 earlier lines,</muted> <dim>ctrl+o</dim>");
    expect(rendered.at(-1)).toBe("<toolOutput>line 12</toolOutput>");
    expect(rendered).toHaveLength(6);
  });

  it("shows every line without a hint when expanded", () => {
    const rendered = previewBody(taggedTheme, lines, { limit: 10, expanded: true });
    expect(rendered).toHaveLength(12);
    expect(rendered.some((line) => line.includes("expand"))).toBe(false);
  });

  it("adds no hint when nothing is hidden", () => {
    expect(
      previewBody(taggedTheme, lines.slice(0, 3), { limit: 10, expanded: false }),
    ).toHaveLength(3);
  });
});

describe("expand hints", () => {
  it("words a summary-row hint as one dim parenthetical, through the injected theme", () => {
    expect(summaryExpandHint(taggedTheme)).toBe("<dim> (ctrl+o to expand)</dim>");
  });

  it("words a line hint with the count, styled only through the injected theme", () => {
    expect(expandHint(taggedTheme, 3)).toBe(
      "<muted>... (3 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
  });
});

describe("durationFooter", () => {
  // Pi supplies `durationMs` only once `execute()` has returned, so a running call is timed by the
  // renderer's own clock, kept in `context.state` and redrawn once a second.
  function createContext(overrides: Partial<DurationContext> = {}) {
    const invalidate = vi.fn();
    const context: DurationContext = {
      state: {},
      executionStarted: true,
      isPartial: true,
      durationMs: undefined,
      invalidate,
      ...overrides,
    };
    return { context, invalidate };
  }

  afterEach(() => vi.useRealTimers());

  it("counts Elapsed from the renderer's clock while the call runs and redraws each second", () => {
    vi.useFakeTimers({ now: 10_000 });
    const { context, invalidate } = createContext();
    expect(durationFooter(taggedTheme, context, { isPartial: true })).toBe(
      "<muted>Elapsed 0.0s</muted>",
    );
    vi.advanceTimersByTime(2500);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(durationFooter(taggedTheme, context, { isPartial: true })).toBe(
      "<muted>Elapsed 2.5s</muted>",
    );
  });

  it("prefers Pi's recorded duration for the final result and stops redrawing", () => {
    vi.useFakeTimers({ now: 0 });
    const { context, invalidate } = createContext();
    durationFooter(taggedTheme, context, { isPartial: true });
    vi.advanceTimersByTime(1000);
    invalidate.mockClear();
    const finished = { ...context, durationMs: 65_000 };
    expect(durationFooter(taggedTheme, finished, { isPartial: false })).toBe(
      "<muted>Took 1m 5s</muted>",
    );
    vi.advanceTimersByTime(5000);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("falls back to the renderer's clock for a final result stored without a duration", () => {
    vi.useFakeTimers({ now: 0 });
    const { context } = createContext();
    durationFooter(taggedTheme, context, { isPartial: true });
    vi.advanceTimersByTime(3000);
    expect(durationFooter(taggedTheme, context, { isPartial: false })).toBe(
      "<muted>Took 3.0s</muted>",
    );
    vi.advanceTimersByTime(4000);
    expect(durationFooter(taggedTheme, context, { isPartial: false })).toBe(
      "<muted>Took 3.0s</muted>",
    );
  });

  describe("from renderCall, for tools that never send a partial result", () => {
    it("shows Elapsed beneath the call while no result exists, redrawing each second", () => {
      vi.useFakeTimers({ now: 0 });
      const { context, invalidate } = createContext();
      const footer = callDurationFooter(taggedTheme, context);
      expect(footer.render(80)).toEqual(["<muted>Elapsed 0.0s</muted>"]);
      vi.advanceTimersByTime(3000);
      expect(invalidate).toHaveBeenCalledTimes(3);
      expect(footer.render(80)).toEqual(["<muted>Elapsed 3.0s</muted>"]);
    });

    it("shows nothing before execution starts", () => {
      const { context } = createContext({ executionStarted: false });
      expect(callDurationFooter(taggedTheme, context).render(80)).toEqual([]);
    });

    it("yields to the result row once a result renderer has run, even in the same draw", () => {
      vi.useFakeTimers({ now: 0 });
      const { context } = createContext();
      const footer = callDurationFooter(taggedTheme, context);
      durationFooter(taggedTheme, context, { isPartial: true });
      expect(footer.render(80)).toEqual([]);
    });

    it("shows nothing once the call has finished", () => {
      vi.useFakeTimers({ now: 0 });
      const { context } = createContext();
      const footer = callDurationFooter(taggedTheme, context);
      durationFooter(taggedTheme, { ...context, durationMs: 500 }, { isPartial: false });
      expect(footer.render(80)).toEqual([]);
    });
  });

  it("renders nothing when the call never started and no duration was recorded", () => {
    const { context } = createContext({ executionStarted: false });
    expect(durationFooter(taggedTheme, context, { isPartial: false })).toBeUndefined();
  });
});

describe("treePrefix", () => {
  it("draws Pi's branch characters and keeps ancestor guides", () => {
    expect(treePrefix([], false)).toBe("├─ ");
    expect(treePrefix([], true)).toBe("└─ ");
    expect(treePrefix([false], true)).toBe("│  └─ ");
    expect(treePrefix([true, false], false)).toBe("   │  ├─ ");
  });
});

describe("widgetLines", () => {
  it("renders a header then rows and caps at ten lines with a more line", () => {
    const rows = Array.from({ length: 14 }, (_, index) => `row ${index + 1}`);
    const lines = widgetLines(taggedTheme, { title: "todo", counts: "14 tasks", rows });
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("<toolTitle><b>todo</b></toolTitle> <muted>14 tasks</muted>");
    expect(lines.at(-1)).toBe("<muted>... 6 more</muted>");
  });

  it("shows every row when they fit", () => {
    expect(widgetLines(taggedTheme, { title: "dap", rows: ["a", "b"] })).toEqual([
      "<toolTitle><b>dap</b></toolTitle>",
      "a",
      "b",
    ]);
  });
});

describe("footerStatus", () => {
  it("shows an optional mark, a dim name, then the value", () => {
    expect(
      footerStatus(taggedTheme, { mark: "active", name: "termctrl", value: "2 running" }),
    ).toBe("<accent>●</accent> <dim>termctrl</dim> 2 running");
    expect(footerStatus(taggedTheme, { name: "tps", value: "42 t/s" })).toBe(
      "<dim>tps</dim> 42 t/s",
    );
  });
});

describe("expectLinesFitWidth", () => {
  it("measures rendered text, not the theme's tag markers", () => {
    const line = taggedTheme.fg("accent", taggedTheme.bold("abc"));
    expect(() => expectLinesFitWidth([line], 3)).not.toThrow();
    expect(() => expectLinesFitWidth([line], 2)).toThrow(/wider than 2/);
  });

  it("rejects a hard-coded escape sequence", () => {
    expect(() => expectLinesFitWidth(["\u001b[31mred\u001b[39m"], 40)).toThrow(/escape/);
  });
});

describe("noticeText", () => {
  it("prefixes the display name", () => {
    expect(noticeText("LSP", "invalid settings")).toBe("LSP: invalid settings");
  });
});
