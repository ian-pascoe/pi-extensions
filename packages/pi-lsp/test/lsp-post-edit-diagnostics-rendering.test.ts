import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { beforeAll, describe, expect, test } from "vitest";
import {
  createPostEditDiagnosticsEntryData,
  renderPostEditDiagnosticsEntry,
} from "../src/lsp-post-edit-diagnostics-rendering.js";
import type { PostEditDiagnosticOutcome } from "../src/lsp-post-edit-diagnostics.js";

beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

function renderLines(component: { render(width: number): string[] }, width = 120): string[] {
  const rendered = component.render(width);
  expectLinesFitWidth(rendered, width);
  return rendered.map((line) => readableTags(line).trimEnd());
}

function diagnosticOutcome(index: number): PostEditDiagnosticOutcome {
  return {
    kind: "diagnostic",
    diagnostic: {
      serverId: "typescript",
      path: "/workspace/src/a.ts",
      line: index,
      character: 1,
      severity: 1,
      message: `Problem ${index}`,
    },
  };
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

function entryData(outcomes: readonly PostEditDiagnosticOutcome[]) {
  const data = createPostEditDiagnosticsEntryData("/workspace", outcomes);
  if (data === undefined) throw new Error("Expected reportable diagnostics entry");
  return data;
}

describe("Post-edit Diagnostics Entry rendering", () => {
  test("is a custom message box with a bold label, severity counts, and diagnostics", () => {
    const component = renderPostEditDiagnosticsEntry(
      entryData(reportableOutcomes),
      { expanded: false, outputPad: 1 },
      escapeTaggedTheme,
    );
    const rendered = renderLines(component).join("\n");
    expect(rendered).toContain("<bg:customMessageBg>");
    expect(rendered).toContain(
      "<customMessageLabel><b>Post-edit diagnostics</b></customMessageLabel>",
    );
    expect(rendered).toContain("<error>1 error</error>");
    expect(rendered).toContain("<warning>2 warnings</warning>");
    expect(rendered).toContain("<muted>3 files</muted>");
    expect(rendered).toContain(
      "<error>4:2</error>  <customMessageText>Type mismatch</customMessageText>",
    );
    expect(rendered).toContain("<accent>src/c.ts</accent>");
    expect(rendered).not.toContain("to expand");
    expect(rendered).not.toContain("clean.ts");
    expect(rendered).not.toContain("README.txt");
    renderLines(component, 120);
    renderLines(component, 40);
  });

  test("collapses to 10 body lines with Pi's expand hint, and expands to every line", () => {
    const outcomes = Array.from({ length: 14 }, (_, index) => diagnosticOutcome(index + 1));
    const narrow = renderPostEditDiagnosticsEntry(
      entryData(outcomes),
      { expanded: false },
      escapeTaggedTheme,
    );
    expect(renderLines(narrow, 40).join("\n")).toContain("to expand");
    const collapsed = renderLines(
      renderPostEditDiagnosticsEntry(entryData(outcomes), { expanded: false }, escapeTaggedTheme),
    ).join("\n");
    expect(collapsed).toContain("Problem 9");
    expect(collapsed).not.toContain("Problem 10");
    expect(collapsed).toContain(
      "<muted>... (5 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );

    const expanded = renderLines(
      renderPostEditDiagnosticsEntry(entryData(outcomes), { expanded: true }, escapeTaggedTheme),
    ).join("\n");
    expect(expanded).toContain("Problem 14");
    expect(expanded).not.toContain("to expand");
  });

  test("expands diagnostics by workspace-relative file with source locations and servers", () => {
    const expanded = renderLines(
      renderPostEditDiagnosticsEntry(
        entryData(reportableOutcomes),
        { expanded: true, outputPad: 1 },
        escapeTaggedTheme,
      ),
    ).join("\n");
    expect(expanded).toContain("src/a.ts");
    expect(expanded).toContain("<muted>typescript</muted>");
    expect(expanded).toContain("<muted>oxlint</muted>");
    expect(expanded).toContain(
      "<warning>Diagnostics timed out</warning>  <muted>typescript</muted>",
    );
    expect(expanded).toContain("<warning>Server unavailable</warning>  <muted>oxlint</muted>");
    expect(expanded).toContain("Pi LSP: adapter warning");
  });
});
