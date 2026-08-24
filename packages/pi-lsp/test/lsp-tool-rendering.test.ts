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
  test("uses a compact call and reveals complete operation output only when expanded", () => {
    const parameters = {
      operation: "hover" as const,
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

    expect(renderLines(renderLspToolCall(parameters, plainTheme, false, "/workspace"))).toBe(
      "LSP  Hover  packages/pi-lsp/src/lsp-tool.ts:12:4",
    );
    expect(
      renderLines(
        renderLspToolCall(
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
