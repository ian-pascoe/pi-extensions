import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { beforeAll, describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import {
  createPostEditDiagnosticsEntryData,
  PostEditDiagnosticsEntryDataSchema,
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
  test("is a custom message box with a `[lsp] edit diagnostics \u00b7 counts` label line, and diagnostics", () => {
    const component = renderPostEditDiagnosticsEntry(
      entryData(reportableOutcomes),
      { expanded: false, outputPad: 1 },
      escapeTaggedTheme,
    );
    const lines = renderLines(component);
    const rendered = lines.join("\n");
    expect(rendered).toContain("<bg:customMessageBg>");
    expect(lines[1]).toContain(
      "<customMessageLabel><b>[lsp]</b></customMessageLabel> <customMessageText>edit diagnostics</customMessageText><dim> \u00b7 </dim><error>1 error</error><dim> \u00b7 </dim><warning>2 warnings</warning><dim> \u00b7 </dim><warning>1 timeout</warning><dim> \u00b7 </dim><warning>1 server issue</warning><dim> \u00b7 </dim><muted>3 files</muted>",
    );
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

  test("marks the file of an error an edit caused in a dependent file", () => {
    const dependent: PostEditDiagnosticOutcome = {
      kind: "diagnostic",
      diagnostic: {
        serverId: "typescript",
        path: "/workspace/src/user.ts",
        line: 1,
        character: 10,
        severity: 1,
        message: "No exported member",
        dependent: true,
      },
    };
    const expanded = renderLines(
      renderPostEditDiagnosticsEntry(
        entryData([...reportableOutcomes, dependent]),
        { expanded: true, outputPad: 1 },
        escapeTaggedTheme,
      ),
    ).join("\n");
    expect(expanded).toContain("<accent>src/user.ts</accent>  <muted>dependent file</muted>");
    expect(expanded).not.toContain("<accent>src/a.ts</accent>  <muted>dependent file");
  });

  test("shows the new findings with their range and code, then the file's unchanged counts", () => {
    const outcomes: PostEditDiagnosticOutcome[] = [
      {
        kind: "diagnostic",
        diagnostic: {
          serverId: "oxlint",
          path: "/workspace/src/a.ts",
          line: 5,
          character: 28,
          endLine: 5,
          endCharacter: 42,
          severity: 2,
          message: "Unnecessary cast",
          source: "eslint",
          code: "no-cast",
        },
      },
      { kind: "unchanged", path: "/workspace/src/a.ts", severity: 2, count: 12 },
      { kind: "unchanged", path: "/workspace/src/a.ts", severity: 1, count: 1 },
      { kind: "no_baseline", path: "/workspace/src/a.ts", serverId: "oxlint" },
    ];
    const lines = renderLines(
      renderPostEditDiagnosticsEntry(
        entryData(outcomes),
        { expanded: true, outputPad: 1 },
        escapeTaggedTheme,
      ),
    );
    const rendered = lines.join("\n");
    expect(lines[1]).toContain("<warning>1 warning</warning>");
    expect(lines[1]).toContain("<muted>13 unchanged</muted>");
    expect(rendered).toContain(
      "<warning>5:28-42</warning>  <customMessageText>Unnecessary cast</customMessageText>  <muted>oxlint eslint(no-cast)</muted>",
    );
    expect(rendered).toContain(
      "<warning>No pre-edit baseline; all findings listed</warning>  <muted>oxlint</muted>",
    );
    // The unchanged counts close the file's group.
    const unchangedLine = rendered.indexOf("<muted>unchanged: 1 error, 12 warnings</muted>");
    expect(unchangedLine).toBeGreaterThan(rendered.indexOf("No pre-edit baseline"));
  });

  test("parses and renders an entry saved before baselines, codes, and ranges were recorded", () => {
    const saved = {
      cwd: "/workspace",
      outcomes: [
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
        { kind: "timeout", path: "/workspace/src/b.ts", serverId: "typescript" },
      ],
    };
    expect(Value.Check(PostEditDiagnosticsEntryDataSchema, saved)).toBe(true);
    const rendered = renderLines(
      renderPostEditDiagnosticsEntry(
        Value.Parse(PostEditDiagnosticsEntryDataSchema, saved),
        { expanded: true },
        escapeTaggedTheme,
      ),
    ).join("\n");
    expect(rendered).toContain(
      "<error>4:2</error>  <customMessageText>Type mismatch</customMessageText>  <muted>typescript</muted>",
    );
  });
});
