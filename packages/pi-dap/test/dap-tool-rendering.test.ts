import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { DapOperation, DapToolRenderDetails } from "../src/dap-tool-contract.js";
import {
  renderDapToolCall,
  renderDapToolResult,
  sanitizeDapObserverText,
  type DapCallRenderContext,
  type DapResultRenderContext,
} from "../src/dap-tool-rendering.js";

beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

afterEach(() => vi.useRealTimers());

function callContext(overrides: Partial<DapCallRenderContext> = {}): DapCallRenderContext {
  return {
    state: {},
    executionStarted: false,
    isPartial: true,
    durationMs: undefined,
    invalidate: () => {},
    expanded: false,
    cwd: "/workspace",
    ...overrides,
  };
}

function resultContext(overrides: Partial<DapResultRenderContext> = {}): DapResultRenderContext {
  return {
    state: {},
    executionStarted: true,
    isPartial: false,
    durationMs: 2500,
    invalidate: () => {},
    isError: false,
    ...overrides,
  };
}

function lines(component: { render(width: number): string[] }, width = 120): string[] {
  const rendered = component.render(width);
  expectLinesFitWidth(rendered, width);
  return rendered.map((line) => readableTags(line).trimEnd());
}

function result(
  text: string,
  details?: DapToolRenderDetails,
): AgentToolResult<DapToolRenderDetails | undefined> {
  return { content: [{ type: "text", text }], details };
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `  row ${index + 1}`).join("\n");
}

function renderResult(
  operation: DapOperation,
  text: string,
  options: { expanded: boolean; isPartial?: boolean },
  context = resultContext(),
  details?: DapToolRenderDetails,
) {
  return renderDapToolResult(
    operation,
    result(text, details),
    { expanded: options.expanded, isPartial: options.isPartial ?? false },
    escapeTaggedTheme,
    context,
  );
}

describe("dap tool call", () => {
  test("leads with the registered tool name, an accent target, and muted arguments", () => {
    expect(
      lines(
        renderDapToolCall(
          { operation: "launch", profile: "node", program: "/workspace/src/app.ts" },
          escapeTaggedTheme,
          callContext(),
        ),
      )[0],
    ).toBe(
      "<toolTitle><b>dap_launch</b></toolTitle> <accent>src/app.ts</accent> <muted>node</muted>",
    );
    expect(
      lines(
        renderDapToolCall(
          {
            operation: "set_breakpoints",
            file_path: "/workspace/app.ts",
            breakpoints: [{ line: 3 }, { line: 8 }],
          },
          escapeTaggedTheme,
          callContext(),
        ),
      )[0],
    ).toBe(
      "<toolTitle><b>dap_set_breakpoints</b></toolTitle> <accent>app.ts</accent> <muted>2 breakpoints</muted>",
    );
    expect(
      lines(
        renderDapToolCall({ operation: "stack", thread_id: 2 }, escapeTaggedTheme, callContext()),
      )[0],
    ).toBe("<toolTitle><b>dap_stack</b></toolTitle> <muted>thread #2</muted>");
    expect(
      lines(
        renderDapToolCall(
          { operation: "evaluate", expression: "a  +\nb" },
          escapeTaggedTheme,
          callContext(),
        ),
      )[0],
    ).toBe("<toolTitle><b>dap_evaluate</b></toolTitle> <accent>a + b</accent>");
  });

  test("renders provider arguments before required operation fields arrive", () => {
    for (const operation of ["set_breakpoints", "variables", "evaluate"] as const) {
      for (const expanded of [false, true]) {
        const rendered = lines(
          renderDapToolCall({ operation }, escapeTaggedTheme, callContext({ expanded })),
        ).join("\n");
        expect(rendered).toContain(`dap_${operation}`);
        expect(rendered).not.toContain("undefined");
      }
    }
  });

  test("lists supplied arguments one per line in muted only when expanded", () => {
    const parameters = {
      operation: "set_breakpoints",
      file_path: "/workspace/app.ts",
      breakpoints: [{ line: 3, condition: "i > 2" }, { line: 8 }],
    } as const;
    expect(lines(renderDapToolCall(parameters, escapeTaggedTheme, callContext()))).toHaveLength(1);
    const expanded = lines(
      renderDapToolCall(parameters, escapeTaggedTheme, callContext({ expanded: true })),
    );
    expect(expanded.slice(1)).toEqual([
      "<muted>file_path: app.ts</muted>",
      "<muted>breakpoints: 3 if i > 2, 8</muted>",
    ]);
    lines(renderDapToolCall(parameters, escapeTaggedTheme, callContext({ expanded: true })), 40);
  });

  test("shows live Elapsed beneath the call until a result row takes over", () => {
    vi.useFakeTimers({ now: 0 });
    const context = callContext({ executionStarted: true });
    const component = renderDapToolCall({ operation: "stack" }, escapeTaggedTheme, context);
    vi.advanceTimersByTime(3000);
    expect(lines(component).at(-1)).toBe("<muted>Elapsed 3.0s</muted>");
  });
});

describe("dap tool result", () => {
  test("previews stack and variables to ls's 20 lines with Pi's expand hint", () => {
    for (const operation of ["stack", "variables"] as const) {
      const rendered = lines(renderResult(operation, numbered(25), { expanded: false }));
      expect(rendered).toContain("<toolOutput>  row 20</toolOutput>".trimEnd());
      expect(rendered).not.toContain("<toolOutput>  row 21</toolOutput>");
      expect(rendered).toContain(
        "<muted>... (5 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
      );
      expect(rendered.at(-1)).toBe("<muted>Took 2.5s</muted>");
    }
  });

  test("previews evaluate and execution results to the 10-line fallback", () => {
    for (const operation of ["evaluate", "continue"] as const) {
      const rendered = lines(renderResult(operation, numbered(12), { expanded: false }));
      expect(rendered).toContain("<toolOutput>  row 10</toolOutput>");
      expect(rendered).not.toContain("<toolOutput>  row 11</toolOutput>");
      expect(rendered.some((line) => line.includes("(2 more lines,"))).toBe(true);
    }
  });

  test("shows every line without a hint when expanded, and fits narrow terminals", () => {
    const expanded = lines(renderResult("stack", numbered(25), { expanded: true }));
    expect(expanded).toContain("<toolOutput>  row 25</toolOutput>");
    expect(expanded.some((line) => line.includes("to expand"))).toBe(false);
    lines(renderResult("stack", numbered(25), { expanded: false }), 40);
  });

  test("sanitizes terminal sequences and controls out of Debuggee output", () => {
    const unsafe = "ok\u001b[31m red\u001b[0m\u001b]0;title\u0007\u0000\u0085\r\nnext";
    const rendered = lines(
      renderResult("status", `idle\n\nDebuggee output:\n${unsafe}`, { expanded: true }),
    ).join("\n");
    expect(rendered).toContain("ok red");
    expect(rendered).toContain("next");
    expect(sanitizeDapObserverText(unsafe)).not.toContain("\u001b");
  });

  test("shows only the Elapsed footer while an execution wait reports progress", () => {
    vi.useFakeTimers({ now: 0 });
    const context = resultContext({ isPartial: true, durationMs: undefined });
    const progress = { kind: "progress", operation: "continue", elapsed_ms: 0 } as const;
    renderResult(
      "continue",
      "continue waiting",
      { expanded: false, isPartial: true },
      context,
      progress,
    );
    vi.advanceTimersByTime(7000);
    const rendered = lines(
      renderResult(
        "continue",
        "continue waiting",
        { expanded: false, isPartial: true },
        context,
        progress,
      ),
    );
    expect(rendered.join("\n")).not.toContain("waiting");
    expect(rendered.join("\n")).not.toContain("Continuing");
    expect(rendered.at(-1)).toBe("<muted>Elapsed 7.0s</muted>");
  });

  test("shows an error's text in the error role", () => {
    const rendered = lines(
      renderResult(
        "stack",
        "Pi DAP: DAP Session: stack requires a stopped Debuggee",
        { expanded: false },
        resultContext({ isError: true }),
      ),
    );
    expect(rendered).toContain(
      "<error>Pi DAP: DAP Session: stack requires a stopped Debuggee</error>",
    );
  });
});
