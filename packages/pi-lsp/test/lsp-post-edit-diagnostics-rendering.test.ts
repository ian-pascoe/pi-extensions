import { describe, expect, test } from "vitest";
import {
  createPostEditDiagnosticsEntryData,
  renderPostEditDiagnosticsEntry,
  type PostEditDiagnosticsEntryTheme,
} from "../src/lsp-post-edit-diagnostics-rendering.js";
import type { PostEditDiagnosticOutcome } from "../src/lsp-post-edit-diagnostics.js";

const plainTheme = {
  bg: (_color, text) => text,
  bold: (text) => text,
  fg: (_color, text) => text,
} satisfies PostEditDiagnosticsEntryTheme;

function renderLines(component: { render(width: number): string[] }): string {
  return component
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

const reportableOutcomes = [
  {
    kind: "diagnostic",
    diagnostic: {
      serverId: "typescript",
      path: "/workspace/src/a.ts",
      line: 4,
      character: 2,
      severity: 1,
      message: "Type mismatch",
    },
  },
  {
    kind: "diagnostic",
    diagnostic: {
      serverId: "oxlint",
      path: "/workspace/src/a.ts",
      line: 8,
      character: 1,
      severity: 2,
      message: "Unused value",
    },
  },
  { kind: "timeout", path: "/workspace/src/b.ts", serverId: "typescript" },
  { kind: "unavailable_server", path: "/workspace/src/c.ts", serverId: "oxlint" },
  { kind: "warning", message: "Pi LSP: adapter warning" },
  { kind: "no_diagnostics", path: "/workspace/src/clean.ts" },
  { kind: "no_configured_server", path: "/workspace/README.txt" },
] satisfies readonly PostEditDiagnosticOutcome[];

describe("Post-edit Diagnostics Entry rendering", () => {
  test("collapses to severity and file counts without exposing messages", () => {
    const data = createPostEditDiagnosticsEntryData("/workspace", reportableOutcomes);
    expect(data).toBeDefined();
    if (data === undefined) throw new Error("Expected reportable diagnostics entry");

    const collapsed = renderLines(renderPostEditDiagnosticsEntry(data, false, plainTheme));
    expect(collapsed).toContain("Post-edit diagnostics");
    expect(collapsed).toContain("1 error");
    expect(collapsed).toContain("2 warnings");
    expect(collapsed).toContain("1 timeout");
    expect(collapsed).toContain("1 server issue");
    expect(collapsed).toContain("3 files");
    expect(collapsed).not.toContain("Type mismatch");
  });

  test("expands diagnostics by workspace-relative file with source locations and servers", () => {
    const data = createPostEditDiagnosticsEntryData("/workspace", reportableOutcomes);
    if (data === undefined) throw new Error("Expected reportable diagnostics entry");

    const expanded = renderLines(renderPostEditDiagnosticsEntry(data, true, plainTheme));
    expect(expanded).toContain("src/a.ts");
    expect(expanded).toContain("4:2  Type mismatch  typescript");
    expect(expanded).toContain("8:1  Unused value  oxlint");
    expect(expanded).toContain("src/b.ts");
    expect(expanded).toContain("Diagnostics timed out  typescript");
    expect(expanded).toContain("src/c.ts");
    expect(expanded).toContain("Server unavailable  oxlint");
    expect(expanded).toContain("Pi LSP: adapter warning");
    expect(expanded).not.toContain("clean.ts");
    expect(expanded).not.toContain("README.txt");
  });
});
