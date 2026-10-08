import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  renderLspToolCall,
  renderLspToolResult,
  type LspCallRenderContext,
  type LspResultRenderContext,
} from "../src/lsp-tool-rendering.js";

beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

afterEach(() => vi.useRealTimers());

function callContext(overrides: Partial<LspCallRenderContext> = {}): LspCallRenderContext {
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

function resultContext(overrides: Partial<LspResultRenderContext> = {}): LspResultRenderContext {
  return {
    state: {},
    executionStarted: true,
    isPartial: false,
    durationMs: 1200,
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

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `src/a.ts:${index + 1}:1  line`).join("\n");
}

describe("lsp tool call", () => {
  const parameters = { file_path: "/workspace/src/lsp-tool.ts", line: 12, character: 4 };

  test("leads with the registered tool name, then the accent position", () => {
    const rendered = lines(
      renderLspToolCall("goto_definition", parameters, escapeTaggedTheme, callContext()),
    );
    expect(rendered[0]).toBe(
      "<toolTitle><b>lsp_goto_definition</b></toolTitle> <accent>src/lsp-tool.ts:12:4</accent>",
    );
  });

  test("accepts a leading @ and puts a rename or search argument in muted", () => {
    const rendered = lines(
      renderLspToolCall(
        "rename",
        { ...parameters, file_path: "@/workspace/src/lsp-tool.ts", new_name: "renamed" },
        escapeTaggedTheme,
        callContext(),
      ),
    );
    expect(rendered[0]).toBe(
      "<toolTitle><b>lsp_rename</b></toolTitle> <accent>src/lsp-tool.ts:12:4</accent> <muted>renamed</muted>",
    );
  });

  test("names apply by its preview and tolerates non-object arguments", () => {
    expect(
      lines(
        renderLspToolCall("apply", { preview_id: "preview-1" }, escapeTaggedTheme, callContext()),
      )[0],
    ).toBe("<toolTitle><b>lsp_apply</b></toolTitle> <accent>preview-1</accent>");
    expect(
      lines(renderLspToolCall("status", "not an object", escapeTaggedTheme, callContext()))[0],
    ).toBe("<toolTitle><b>lsp_status</b></toolTitle>");
  });

  test("lists every argument in muted, one per line, only when expanded", () => {
    const collapsed = lines(
      renderLspToolCall("hover", parameters, escapeTaggedTheme, callContext({ expanded: false })),
    );
    expect(collapsed).toHaveLength(1);
    const expanded = lines(
      renderLspToolCall("hover", parameters, escapeTaggedTheme, callContext({ expanded: true })),
    );
    expect(expanded.slice(1)).toEqual([
      "<muted>file_path: /workspace/src/lsp-tool.ts</muted>",
      "<muted>line: 12</muted>",
      "<muted>character: 4</muted>",
    ]);
    expectLinesFitWidth(
      renderLspToolCall(
        "hover",
        parameters,
        escapeTaggedTheme,
        callContext({ expanded: true }),
      ).render(40),
      40,
    );
  });

  test("shows live Elapsed beneath the call while the tool runs, since LSP sends no partial results", () => {
    vi.useFakeTimers({ now: 0 });
    const context = callContext({ executionStarted: true });
    const component = renderLspToolCall("hover", parameters, escapeTaggedTheme, context);
    vi.advanceTimersByTime(2500);
    expect(lines(component).at(-1)).toBe("<muted>Elapsed 2.5s</muted>");
  });
});

describe("lsp tool result", () => {
  test("previews a location list to grep's 15 lines with Pi's expand hint", () => {
    const rendered = lines(
      renderLspToolResult(
        "find_references",
        textResult(numbered(20)),
        { expanded: false, isPartial: false },
        escapeTaggedTheme,
        resultContext(),
      ),
    );
    expect(rendered).toContain("<toolOutput>src/a.ts:15:1  line</toolOutput>");
    expect(rendered).not.toContain("<toolOutput>src/a.ts:16:1  line</toolOutput>");
    expect(rendered).toContain(
      "<muted>... (5 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
    expect(rendered.at(-1)).toBe("<muted>Took 1.2s</muted>");
  });

  test("previews other output to the 10-line fallback", () => {
    const rendered = lines(
      renderLspToolResult(
        "hover",
        textResult(numbered(12)),
        { expanded: false, isPartial: false },
        escapeTaggedTheme,
        resultContext(),
      ),
    );
    expect(rendered).toContain("<toolOutput>src/a.ts:10:1  line</toolOutput>");
    expect(rendered).not.toContain("<toolOutput>src/a.ts:11:1  line</toolOutput>");
    expect(rendered.some((line) => line.includes("2 more lines"))).toBe(true);
  });

  test("shows every line and no hint when expanded", () => {
    const rendered = lines(
      renderLspToolResult(
        "find_references",
        textResult(numbered(20)),
        { expanded: true, isPartial: false },
        escapeTaggedTheme,
        resultContext(),
      ),
    );
    expect(rendered).toContain("<toolOutput>src/a.ts:20:1  line</toolOutput>");
    expect(rendered.some((line) => line.includes("to expand"))).toBe(false);
  });

  test("fits narrow terminals", () => {
    const component = renderLspToolResult(
      "find_references",
      textResult(numbered(20)),
      { expanded: false, isPartial: false },
      escapeTaggedTheme,
      resultContext(),
    );
    lines(component, 40);
  });

  test("streams Elapsed while partial, with no placeholder text", () => {
    vi.useFakeTimers({ now: 0 });
    const context = resultContext({ isPartial: true, durationMs: undefined });
    // The first render starts the row's clock, as Pi's first partial draw does.
    renderLspToolResult(
      "hover",
      textResult(""),
      { expanded: false, isPartial: true },
      escapeTaggedTheme,
      context,
    );
    vi.advanceTimersByTime(1500);
    const rendered = lines(
      renderLspToolResult(
        "hover",
        textResult(""),
        { expanded: false, isPartial: true },
        escapeTaggedTheme,
        context,
      ),
    );
    expect(rendered.join("\n")).not.toContain("Running");
    expect(rendered.at(-1)).toBe("<muted>Elapsed 1.5s</muted>");
  });

  test("shows an error's text in the error role", () => {
    const rendered = lines(
      renderLspToolResult(
        "hover",
        textResult("Pi LSP: server typescript request failed"),
        { expanded: false, isPartial: false },
        escapeTaggedTheme,
        resultContext({ isError: true }),
      ),
    );
    expect(rendered).toContain("<error>Pi LSP: server typescript request failed</error>");
  });

  test("renders an apply partial failure as its error text", () => {
    const rendered = lines(
      renderLspToolResult(
        "apply",
        textResult("Workspace Edit rollback failed for: /workspace/a.ts"),
        { expanded: false, isPartial: false },
        escapeTaggedTheme,
        resultContext({ isError: true }),
      ),
    );
    expect(rendered).toContain(
      "<error>Workspace Edit rollback failed for: /workspace/a.ts</error>",
    );
  });
});
