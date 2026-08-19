import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import type {
  DapToolParameters,
  DapToolRenderDetails,
  DapToolResultDetails,
} from "../src/dap-tool-contract.js";
import {
  renderDapToolCall,
  renderDapToolResult,
  sanitizeDapObserverText,
  type DapRenderTheme,
} from "../src/dap-tool-rendering.js";

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} satisfies DapRenderTheme;

function renderLines(component: { render(width: number): string[] }): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

function finalDetails(overrides: Partial<DapToolResultDetails> = {}): DapToolResultDetails {
  const details: DapToolResultDetails = {
    operation: "status",
    state: "stopped",
    adapter_id: "node",
    profile_id: "node",
    stop_reason: "breakpoint",
    thread_id: 1,
    output_discarded_bytes: 0,
    output_truncated: false,
    ...overrides,
  };
  if (details.state !== "stopped") {
    delete details.stop_reason;
    delete details.thread_id;
  }
  return details;
}

function result(
  details: DapToolRenderDetails | undefined,
  text = "DAP status: {}",
): AgentToolResult<DapToolRenderDetails | undefined> {
  return { content: [{ type: "text", text }], details };
}

describe("Pi DAP transcript rendering", () => {
  test("renders semantic collapsed calls for all twelve operations", () => {
    const calls: readonly [DapToolParameters, string][] = [
      [
        { operation: "launch", profile: "node", program: "/workspace/app.ts" },
        "DAP  Launch  node · app.ts",
      ],
      [
        {
          operation: "set_breakpoints",
          file_path: "/workspace/app.ts",
          breakpoints: [{ line: 1 }, { line: 2 }],
        },
        "DAP  Set breakpoints  app.ts · 2",
      ],
      [{ operation: "continue" }, "DAP  Continue"],
      [{ operation: "next" }, "DAP  Step over"],
      [{ operation: "step_in" }, "DAP  Step in"],
      [{ operation: "step_out" }, "DAP  Step out"],
      [{ operation: "pause" }, "DAP  Pause"],
      [{ operation: "stack", thread_id: 7 }, "DAP  Stack  thread #7"],
      [{ operation: "variables", frame_id: 14 }, "DAP  Variables  frame #14"],
      [{ operation: "variables", variables_reference: 21 }, "DAP  Variables  reference #21"],
      [{ operation: "evaluate", expression: "answer" }, "DAP  Evaluate  answer"],
      [{ operation: "status" }, "DAP  Status"],
      [{ operation: "stop" }, "DAP  Stop"],
    ];
    for (const [parameters, expected] of calls) {
      expect(renderLines(renderDapToolCall(parameters, plainTheme, false, "/workspace"))).toBe(
        expected,
      );
    }
  });

  test("shows only supplied bounded arguments when expanded", () => {
    const call = renderLines(
      renderDapToolCall(
        {
          operation: "launch",
          profile: "node",
          program: "/workspace/src/app.ts",
          args: ["one", "two"],
          cwd: "/outside/runtime",
        },
        plainTheme,
        true,
        "/workspace",
      ),
    );
    expect(call).toContain("Profile: node");
    expect(call).toContain("Program: src/app.ts");
    expect(call).toContain("Arguments: one · two");
    expect(call).toContain("Working directory: /outside/runtime");
    expect(call).not.toContain("environment");

    const expression = renderLines(
      renderDapToolCall(
        { operation: "evaluate", expression: `one\n${"x".repeat(300)}`, frame_id: 14 },
        plainTheme,
        true,
        "/workspace",
      ),
    );
    expect(expression).toContain("Expression: one");
    expect(expression).toContain("Frame: #14");
    expect(expression.length).toBeLessThan(300);
  });

  test("renders state, operation-specific, partial, and cancellation summaries", () => {
    const cases: readonly [DapToolResultDetails, string][] = [
      [finalDetails(), "● stopped · breakpoint"],
      [finalDetails({ state: "running" }), "▶ running"],
      [
        finalDetails({ operation: "stop", state: "terminated", exit_code: 0 }),
        "■ terminated · exit 0",
      ],
      [
        finalDetails({
          operation: "set_breakpoints",
          presentation: {
            kind: "breakpoints",
            rows: [
              { id: 1, verified: true, line: 3 },
              { id: 2, verified: true, line: 8 },
            ],
            omitted_count: 0,
          },
        }),
        "✓ 2 breakpoints verified",
      ],
      [
        finalDetails({
          operation: "stack",
          presentation: {
            kind: "stack_frames",
            rows: [{ id: 10, name: "main", line: 42, column: 1, source_path: "/workspace/app.ts" }],
            total_count: 14,
            omitted_count: 13,
          },
        }),
        "14 stack frames · app.ts:42",
      ],
      [
        finalDetails({
          operation: "evaluate",
          presentation: { kind: "evaluation", value: "42", type: "number", variables_reference: 0 },
        }),
        "result = 42 · number",
      ],
      [
        finalDetails({
          operation: "continue",
          state: "running",
          presentation: { kind: "execution_wait", operation: "continue", cancelled: true },
        }),
        "! continue wait cancelled · Debug Session still running",
      ],
    ];
    for (const [details, expected] of cases) {
      expect(
        renderLines(
          renderDapToolResult(
            result(details),
            { expanded: false, isPartial: false },
            plainTheme,
            false,
            "/workspace",
          ),
        ),
      ).toContain(expected);
    }
    expect(
      renderLines(
        renderDapToolResult(
          result({ kind: "progress", operation: "continue", elapsed_ms: 7_200 }),
          { expanded: false, isPartial: true },
          plainTheme,
          false,
          "/workspace",
        ),
      ),
    ).toBe("Continuing… 7s");
  });

  test("renders bounded structured rows, warnings, spill metadata, and sanitized Debuggee output", () => {
    const rows = [
      { kind: "group" as const, name: "Local", variables_reference: 20, expensive: false },
      {
        kind: "variable" as const,
        name: "answer",
        value: "42",
        type: "number",
        variables_reference: 0,
      },
      ...Array.from({ length: 18 }, (_, index) => ({
        kind: "variable" as const,
        name: `value-${index}`,
        value: String(index),
        variables_reference: 0,
      })),
    ];
    const details = finalDetails({
      operation: "variables",
      presentation: { kind: "variables", rows, omitted_count: 3 },
      output_discarded_bytes: 12,
      output_truncated: true,
      spill_path: "/tmp/result-spill.txt",
    });
    const unsafe = "ok\u001b[31m red\u001b[0m\u001b]0;title\u0007\u0000\u0085\r\nnext\tvalue";
    const toolResult = result(details, `DAP variables: {}\n\nDebuggee output:\n${unsafe}`);
    const before = structuredClone(toolResult);
    const expanded = renderLines(
      renderDapToolResult(
        toolResult,
        { expanded: true, isPartial: false },
        plainTheme,
        false,
        "/workspace",
      ),
    );
    expect(expanded).toContain("State: stopped");
    expect(expanded).toContain("Local  #20");
    expect(expanded).toContain("answer = 42 · number");
    expect(expanded).toContain("3 more rows omitted");
    expect(expanded).toContain("12 older Debuggee output bytes discarded");
    expect(expanded).toContain("Result Spill: /tmp/result-spill.txt");
    expect(expanded).toContain("ok red\nnext   value");
    expect(sanitizeDapObserverText(unsafe)).toContain("next\tvalue");
    expect(expanded).not.toContain("DAP variables: {}");
    expect(toolResult).toEqual(before);
  });

  test("falls back to the actionable original text for malformed and historical details", () => {
    const historical = result(undefined, "first actionable line\nfull second line");
    expect(
      renderLines(
        renderDapToolResult(
          historical,
          { expanded: false, isPartial: false },
          plainTheme,
          false,
          "/workspace",
        ),
      ),
    ).toContain("first actionable line");
    expect(
      renderLines(
        renderDapToolResult(
          historical,
          { expanded: true, isPartial: false },
          plainTheme,
          false,
          "/workspace",
        ),
      ),
    ).toBe("first actionable line\nfull second line");
    expect(
      renderLines(
        renderDapToolResult(
          result(undefined, "Pi DAP: failed\nstack"),
          { expanded: false, isPartial: false },
          plainTheme,
          true,
          "/workspace",
        ),
      ),
    ).toContain("Pi DAP: failed");
  });

  test("removes every remaining C0 and C1 control except line breaks and tabs", () => {
    const controls = Array.from({ length: 160 }, (_, code) => String.fromCharCode(code)).join("");
    const sanitized = sanitizeDapObserverText(controls);
    expect(sanitized).toContain("\t\n");
    expect(
      Array.from(sanitized).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return (
          character === "\t" || character === "\n" || code >= 0xa0 || (code >= 0x20 && code <= 0x7e)
        );
      }),
    ).toBe(true);
  });
});
