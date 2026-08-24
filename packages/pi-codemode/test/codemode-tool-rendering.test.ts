import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, test } from "vitest";
import {
  renderCodeModeToolCall,
  renderCodeModeToolResult,
  type CodeModeRenderTheme,
} from "../src/codemode-tool-rendering.js";
import type { CodeModeResultDetails } from "../src/codemode-tool-contract.js";

const plainTheme: CodeModeRenderTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

beforeAll(() => initTheme("dark"));

function renderLines(component: { render(width: number): string[] }, width = 120): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

function renderText(component: { render(width: number): string[] }, width = 120): string {
  return renderLines(component, width).join("\n");
}

function result(details: CodeModeResultDetails, text = JSON.stringify(details)) {
  return { content: [{ type: "text" as const, text }], details };
}

describe("CodeMode Transcript rendering", () => {
  test("renders highlighted source previews and complete expanded TypeScript", () => {
    const script = `\n\u001b[31mconst answer: number = 42;\u001b[0m\n${Array.from(
      { length: 205 },
      (_, index) => `const value${index} = ${index};`,
    ).join("\n")}`;
    const execute = { script, wait: false, timeoutMs: 5_000 };

    const collapsed = renderText(
      renderCodeModeToolCall("codemode_execute", execute, plainTheme, false),
    );
    expect(collapsed).toContain("CodeMode  Run Cell  new");
    expect(collapsed).toContain("  const answer: number = 42;");
    expect(collapsed).toContain("  const value5 = 5;");
    expect(collapsed).not.toContain("value6");
    expect(collapsed).toContain("199 lines omitted");
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain("\u001b");

    const expandedComponent = renderCodeModeToolCall("codemode_execute", execute, plainTheme, true);
    const expanded = renderText(expandedComponent);
    expect(expanded).toContain("Wait: false");
    expect(expanded).toContain("Timeout: 5000ms");
    expect(expanded).toContain("TypeScript");
    expect(expanded).toContain("const answer: number = 42;");
    expect(expanded).not.toContain("lines omitted");
    expect(expanded).toContain("value204");
    const highlightedSourceLine = expandedComponent
      .render(120)
      .find((line) => stripTerminalSequences(line).includes("const answer: number = 42;"));
    expect(highlightedSourceLine).toBeDefined();
    expect(highlightedSourceLine).not.toBe(stripTerminalSequences(highlightedSourceLine ?? ""));

    const oneLineComponent = renderCodeModeToolCall(
      "codemode_execute",
      { script: "const answer: number = 42;" },
      plainTheme,
      false,
    );
    const oneLine = renderLines(oneLineComponent);
    expect(oneLine).toHaveLength(1);
    expect(oneLine[0]).toContain("CodeMode  Run Cell  new  const answer: number = 42;");
    expect(oneLine[0]).toContain("to expand");
    const rawOneLineSource = oneLineComponent.render(120)[0]?.split("·", 1)[0] ?? "";
    expect(rawOneLineSource).not.toBe(stripTerminalSequences(rawOneLineSource));

    expect(
      renderText(
        renderCodeModeToolCall(
          "codemode_result",
          { sessionId: "12345678-aaaa-bbbb" },
          plainTheme,
          false,
        ),
      ),
    ).toBe("CodeMode  Poll  12345678");
    expect(
      renderText(
        renderCodeModeToolCall(
          "codemode_cancel",
          { sessionId: "12345678-aaaa-bbbb" },
          plainTheme,
          false,
        ),
      ),
    ).toBe("CodeMode  Cancel  12345678");
    expect(
      renderText(
        renderCodeModeToolCall(
          "codemode_result",
          { sessionId: "aaaaaaaa-1111" },
          plainTheme,
          false,
          () => "aaaaaaaa-1",
        ),
      ),
    ).toBe("CodeMode  Poll  aaaaaaaa-1");
  });

  test("renders lifecycle, value shape, nested tools, spill, and reusable state", () => {
    const details: CodeModeResultDetails = {
      result: "success",
      sessionId: "12345678-aaaa-bbbb-cccc",
      data: { values: [1, 2], answer: 42 },
      presentation: {
        version: 1,
        cell_ordinal: 2,
        cell_state: "completed",
        session_state: "live",
        elapsed_ms: 1_240,
        active_tool_names: [],
        active_tool_count: 0,
        nested_tool_count: 3,
        succeeded_nested_tool_count: 2,
        failed_nested_tool_count: 1,
        nested_tools: [
          { name: "exec_command", outcome: "success", elapsed_ms: 118 },
          { name: "web_run", outcome: "failed", elapsed_ms: 1_002 },
        ],
        omitted_nested_tool_count: 1,
        spill_path: "/tmp/pi-codemode/result-spill-0.txt",
      },
    };

    const collapsed = renderText(
      renderCodeModeToolResult(
        "codemode_execute",
        result(details),
        { expanded: false, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(collapsed).toContain("✓ completed");
    expect(collapsed).toContain("12345678");
    expect(collapsed).toContain("Cell 2");
    expect(collapsed).toContain("object · 2 keys");
    expect(collapsed).toContain("3 tools");
    expect(collapsed).toContain("1.2s");
    expect(collapsed).toContain("to expand");

    const expanded = renderText(
      renderCodeModeToolResult(
        "codemode_execute",
        result(details),
        { expanded: true, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(expanded).toContain("Session: 12345678-aaaa-bbbb-cccc");
    expect(expanded).toContain("Session reusable");
    expect(expanded).toContain("Tool activity");
    expect(expanded).toContain("✓ exec_command  118ms");
    expect(expanded).toContain("× web_run  1.0s");
    expect(expanded).toContain("1 tool omitted");
    expect(expanded).toContain('"answer": 42');
    expect(expanded.indexOf('"answer"')).toBeLessThan(expanded.indexOf('"values"'));
    expect(expanded).toContain("Result Spill: /tmp/pi-codemode/result-spill-0.txt");
  });

  test("distinguishes partial, reusable, fatal, timeout, and cancellation states", () => {
    const pending: CodeModeResultDetails = {
      result: "pending",
      sessionId: "abcdefgh-1234",
      presentation: {
        version: 1,
        cell_ordinal: 4,
        cell_state: "running",
        session_state: "live",
        elapsed_ms: 2_000,
        active_tool_names: ["exec_command"],
        active_tool_count: 1,
        nested_tool_count: 1,
        succeeded_nested_tool_count: 0,
        failed_nested_tool_count: 0,
        nested_tools: [],
        omitted_nested_tool_count: 0,
      },
    };
    expect(
      renderText(
        renderCodeModeToolResult(
          "codemode_execute",
          result(pending),
          { expanded: false, isPartial: true },
          plainTheme,
          false,
        ),
      ),
    ).toContain("◉ running  abcdefgh  Cell 4  exec_command  2.0s");

    const cases = [
      ["script", "× failed", "Session reusable"],
      ["runtime", "× failed", "Session closed"],
      ["timeout", "! timed out", "Session closed"],
      ["cancellation", "■ cancelled", "Session closed"],
      ["unknown", "× failed", "No reusable Session"],
      ["capacity", "× failed", "No reusable Session"],
    ] as const;
    for (const [code, label, lifecycle] of cases) {
      const failed: CodeModeResultDetails = {
        result: "failed",
        sessionId: "abcdefgh-1234",
        error: { code, message: `Pi CodeMode: ${code}` },
      };
      const rendered = renderText(
        renderCodeModeToolResult(
          "codemode_result",
          result(failed),
          { expanded: true, isPartial: false },
          plainTheme,
          false,
        ),
      );
      expect(rendered).toContain(label);
      expect(rendered).toContain(lifecycle);
      expect(rendered).toContain(`Code: ${code}`);
      expect(rendered).toContain(`Pi CodeMode: ${code}`);
    }

    const oversizedError: CodeModeResultDetails = {
      result: "failed",
      sessionId: "abcdefgh-1234",
      error: { code: "script", message: "x".repeat(60 * 1024) },
    };
    expect(
      renderText(
        renderCodeModeToolResult(
          "codemode_execute",
          result(oversizedError),
          { expanded: true, isPartial: false },
          plainTheme,
          false,
        ),
      ),
    ).toContain("line omitted");
  });

  test("renders bounded sanitized Console output before returned data or errors", () => {
    const success: CodeModeResultDetails = {
      result: "success",
      sessionId: "console1-1234",
      data: 42,
      console: [
        { method: "log", text: "first\nsecond" },
        { method: "warn", text: "\u001b[31mwarning\u001b[0m" },
      ],
    };
    const collapsed = renderText(
      renderCodeModeToolResult(
        "codemode_execute",
        result(success),
        { expanded: false, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(collapsed).toContain("✓ completed");
    expect(collapsed).toContain("2 console calls");

    const expanded = renderText(
      renderCodeModeToolResult(
        "codemode_execute",
        result(success),
        { expanded: true, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(expanded).toContain("Console");
    expect(expanded).toContain("log: first\nsecond");
    expect(expanded).toContain("warn: warning");
    expect(expanded).not.toContain("\u001b");
    expect(expanded.indexOf("Console")).toBeLessThan(expanded.indexOf("Result"));

    const failed: CodeModeResultDetails = {
      result: "failed",
      sessionId: "console2-1234",
      error: { code: "script", message: "failed" },
      console: [{ method: "error", text: "diagnostic" }],
    };
    const failedOutput = renderText(
      renderCodeModeToolResult(
        "codemode_result",
        result(failed),
        { expanded: true, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(failedOutput).toContain("× failed");
    expect(failedOutput).toContain("1 console call");
    expect(failedOutput.indexOf("Console")).toBeLessThan(failedOutput.indexOf("Error"));

    const oversized: CodeModeResultDetails = {
      ...success,
      console: [{ method: "debug", text: Array.from({ length: 2_100 }, () => "line").join("\n") }],
    };
    expect(
      renderText(
        renderCodeModeToolResult(
          "codemode_execute",
          result(oversized),
          { expanded: true, isPartial: false },
          plainTheme,
          false,
        ),
      ),
    ).toContain("lines omitted");
  });

  test("infers historical details and falls back safely for malformed details", () => {
    const historical: CodeModeResultDetails = {
      result: "success",
      sessionId: "history1-1234",
      data: [1, 2, 3],
    };
    expect(
      renderText(
        renderCodeModeToolResult(
          "codemode_result",
          result(historical),
          { expanded: false, isPartial: false },
          plainTheme,
          false,
        ),
      ),
    ).toContain("✓ completed  history1  array · 3 items");

    const malformed = {
      content: [{ type: "text" as const, text: "\u001b[31mfirst failure\u001b[0m\nsecond line" }],
      details: { unexpected: true },
    };
    const collapsed = renderText(
      renderCodeModeToolResult(
        "codemode_result",
        malformed,
        { expanded: false, isPartial: false },
        plainTheme,
        true,
      ),
    );
    expect(collapsed).toContain("first failure");
    expect(collapsed).not.toContain("second line");
    expect(collapsed).not.toContain("\u001b");
    expect(
      renderText(
        renderCodeModeToolResult(
          "codemode_result",
          malformed,
          { expanded: true, isPartial: false },
          plainTheme,
          true,
        ),
      ),
    ).toContain("second line");

    const oversizedMalformed = {
      content: [{ type: "text" as const, text: "x".repeat(60 * 1024) }],
      details: { unexpected: true },
    };
    expect(
      renderText(
        renderCodeModeToolResult(
          "codemode_result",
          oversizedMalformed,
          { expanded: false, isPartial: false },
          plainTheme,
          true,
        ),
      ).length,
    ).toBeLessThan(250);
    expect(
      renderText(
        renderCodeModeToolResult(
          "codemode_result",
          oversizedMalformed,
          { expanded: true, isPartial: false },
          plainTheme,
          true,
        ),
      ),
    ).toContain("line omitted");
  });
});
