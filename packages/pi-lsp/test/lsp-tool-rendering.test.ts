import { describe, expect, test } from "vitest";
import {
  renderLspToolCall,
  renderLspToolResult,
  type LspRenderTheme,
} from "../src/lsp-tool-rendering.js";

const plainTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
} satisfies LspRenderTheme;

function renderLines(component: { render(width: number): string[] }): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("Pi LSP tool rendering", () => {
  test.each([
    {
      operation: "code_actions" as const,
      text: '{"actions":[{"server_id":"a"},{"server_id":"b"}],"warnings":[]}',
      metric: "2 actions",
    },
    // Results from before code actions listed several servers.
    { operation: "code_actions" as const, text: '[{"title":"a"}]', metric: "1 action" },
    {
      operation: "workspace_diagnostics" as const,
      text: '{"results":[{"value":{"diagnosticsByUri":[{"uri":"/a.ts","value":[{},{}]},{"uri":"/b.ts","value":[{}]}]}}]}',
      metric: "3 diagnostics",
    },
    {
      operation: "workspace_diagnostics" as const,
      text: '{"results":[{"value":{"status":"unsupported","message":"use lsp_diagnostics"}}]}',
      metric: "0 diagnostics",
    },
  ])("counts $operation output as $metric", ({ operation, text, metric }) => {
    const collapsed = renderLines(
      renderLspToolResult(
        {
          content: [{ type: "text", text }],
          details: {
            kind: "operation",
            operation,
            server_outcomes: [{ server_id: "a", outcome: "success" }],
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(collapsed).toContain(metric);
  });

  test("labels a result whose every server is unsupported as Unsupported, not Failed", () => {
    const colorTheme = {
      bold: (text) => text,
      fg: (color, text) => `[${color}:${text}]`,
    } satisfies LspRenderTheme;
    const collapsed = renderLines(
      renderLspToolResult(
        {
          content: [
            {
              type: "text",
              text: '{"results":[{"server_id":"typescript","value":{"status":"unsupported","message":"use lsp_diagnostics"}}]}',
            },
          ],
          details: {
            kind: "operation",
            operation: "workspace_diagnostics",
            server_outcomes: [
              { server_id: "typescript", outcome: "unsupported", message: "use lsp_diagnostics" },
            ],
          },
        },
        { expanded: false, isPartial: false },
        colorTheme,
        false,
      ),
    );
    expect(collapsed).toContain("[warning:Unsupported]");
    expect(collapsed).toContain("[muted:typescript]");
    expect(collapsed).not.toContain("Failed");
    // No diagnostics were retrieved, so a count of zero would read as a clean workspace.
    expect(collapsed).not.toContain("0 diagnostics");
  });

  test("uses a compact call and reveals complete operation output only when expanded", () => {
    const parameters = {
      file_path: "packages/pi-lsp/src/lsp-tool.ts",
      line: 12,
      character: 4,
    };
    const result = {
      content: [{ type: "text" as const, text: '{"results":[{"value":"hover text"}]}' }],
      details: {
        kind: "operation" as const,
        operation: "hover" as const,
        server_outcomes: [{ server_id: "typescript", outcome: "success" as const }],
      },
    };

    expect(
      renderLines(renderLspToolCall("hover", parameters, plainTheme, false, "/workspace")),
    ).toBe("LSP  Hover  packages/pi-lsp/src/lsp-tool.ts:12:4");
    expect(
      renderLines(
        renderLspToolCall(
          "hover",
          { ...parameters, file_path: "@/workspace/packages/pi-lsp/src/lsp-tool.ts" },
          plainTheme,
          false,
          "/workspace",
        ),
      ),
    ).toBe("LSP  Hover  packages/pi-lsp/src/lsp-tool.ts:12:4");

    const collapsed = renderLines(
      renderLspToolResult(result, { expanded: false, isPartial: false }, plainTheme, false),
    );
    expect(collapsed).toContain("Completed");
    expect(collapsed).toContain("1 result");
    expect(collapsed).toContain("typescript");
    expect(collapsed).not.toContain("hover text");

    const expanded = renderLines(
      renderLspToolResult(result, { expanded: true, isPartial: false }, plainTheme, false),
    );
    expect(expanded).toContain("Server outcomes");
    expect(expanded).toContain('{"results":[{"value":"hover text"}]}');
  });

  test("counts readable location results from their details", () => {
    const result = {
      content: [{ type: "text" as const, text: "src/a.ts:1:7  const a = 1;\nsrc/b.ts:2:3  a;" }],
      details: {
        kind: "operation" as const,
        operation: "find_references" as const,
        server_outcomes: [{ server_id: "typescript", outcome: "success" as const }],
        result_count: 2,
      },
    };
    const collapsed = renderLines(
      renderLspToolResult(result, { expanded: false, isPartial: false }, plainTheme, false),
    );
    expect(collapsed).toContain("2 references");
    const expanded = renderLines(
      renderLspToolResult(result, { expanded: true, isPartial: false }, plainTheme, false),
    );
    expect(expanded).toContain("src/b.ts:2:3  a;");
  });

  test("surfaces preview, apply, partial, and error states without hardcoded styling", () => {
    const preview = renderLines(
      renderLspToolResult(
        {
          content: [{ type: "text", text: "diff --git a/source.ts b/source.ts" }],
          details: {
            kind: "workspace_edit_preview",
            preview_id: "preview-1",
            operation: "rename",
            summary: "Rename symbol in source.ts",
            mutation_manifest: [{ operation: "modify", path: "/workspace/source.ts" }],
            preview_record: {
              kind: "workspace_edit_preview",
              preview_id: "preview-1",
              server_id: "typescript",
              summary: "Rename symbol in source.ts",
              state: "available",
              operations: [],
            },
            state: "available",
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(preview).toContain("Preview ready");
    expect(preview).toContain("1 file");
    expect(preview).not.toContain("diff --git");

    const applied = renderLines(
      renderLspToolResult(
        {
          content: [{ type: "text", text: '{"state":"applied"}' }],
          details: {
            kind: "workspace_edit_apply",
            preview_id: "preview-1",
            mutation_manifest: [{ operation: "modify", path: "/workspace/source.ts" }],
            changed_paths: ["/workspace/source.ts"],
            state: "applied",
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        false,
      ),
    );
    expect(applied).toContain("Applied");
    expect(
      renderLines(renderLspToolCall("apply", { preview_id: "preview-1" }, plainTheme, false, "/")),
    ).toBe("LSP  Apply  preview-1");
    expect(renderLines(renderLspToolCall("status", "not an object", plainTheme, false, "/"))).toBe(
      "LSP  Status",
    );

    // An apply partial failure is an error result that still summarizes the changed files.
    const partial = renderLines(
      renderLspToolResult(
        {
          content: [{ type: "text", text: "Workspace Edit rollback failed for: /workspace/a.ts" }],
          details: {
            kind: "workspace_edit_apply",
            preview_id: "preview-1",
            mutation_manifest: [{ operation: "modify", path: "/workspace/a.ts" }],
            changed_paths: ["/workspace/a.ts"],
            state: "partial_failure",
          },
        },
        { expanded: false, isPartial: false },
        plainTheme,
        true,
      ),
    );
    expect(partial).toContain("Partial failure");
    expect(partial).toContain("1 file");

    expect(
      renderLines(
        renderLspToolResult(
          { content: [{ type: "text", text: "waiting" }], details: undefined },
          { expanded: false, isPartial: true },
          plainTheme,
          false,
        ),
      ),
    ).toBe("Running…");

    expect(
      renderLines(
        renderLspToolResult(
          {
            content: [{ type: "text", text: "LSP request failed\nstack" }],
            details: undefined,
          },
          { expanded: false, isPartial: false },
          plainTheme,
          true,
        ),
      ),
    ).toContain("LSP request failed");
  });
});
