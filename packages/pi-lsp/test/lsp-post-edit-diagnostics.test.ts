import { expect, test } from "vitest";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  appendPostEditDiagnostics,
  extractPostEditDiagnosticPaths,
  type PostEditDiagnosticOutcome,
} from "../src/lsp-post-edit-diagnostics.js";

function mutationEvent(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  const event = {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "edit",
    input: { path: "src/example.ts" },
    details: { preserved: true },
    content: [{ type: "text", text: "Edited src/example.ts" }],
    isError: false,
    ...overrides,
  };
  // SAFETY: the fixture is a structurally valid CustomToolResultEvent; the union's literal branches need stricter details types.
  return event as ToolResultEvent;
}

test("extracts successful native edit and write paths from the central input contract", () => {
  expect(extractPostEditDiagnosticPaths(mutationEvent())).toEqual({
    paths: [{ path: "src/example.ts" }],
    warnings: [],
  });
  expect(
    extractPostEditDiagnosticPaths(mutationEvent({ toolName: "write", input: { path: "new.ts" } })),
  ).toEqual({ paths: [{ path: "new.ts" }], warnings: [] });
  expect(extractPostEditDiagnosticPaths(mutationEvent({ isError: true }))).toBeUndefined();
});

test("extracts changed destinations after successful and partial Codex apply_patch results", () => {
  const details = {
    status: "partial_failure",
    result: {
      changedFiles: ["a.ts"],
      createdFiles: ["b.ts"],
      deletedFiles: ["removed.ts"],
      movedFiles: [{ from: "before.ts", to: "after.ts" }],
      fuzz: 0,
    },
  };
  expect(
    extractPostEditDiagnosticPaths(mutationEvent({ toolName: "apply_patch", details })),
  ).toEqual({
    paths: [{ path: "a.ts" }, { path: "after.ts" }, { path: "b.ts" }],
    warnings: [],
  });
});

test("preserves an unknown Codex result and reports its adapter boundary", () => {
  expect(
    extractPostEditDiagnosticPaths(
      mutationEvent({ toolName: "apply_patch", details: { status: "done" } }),
    ),
  ).toEqual({
    paths: [],
    warnings: ["Pi LSP: apply_patch diagnostics adapter skipped an unknown Codex result shape."],
  });
});

const verifiedManifest = [
  { operation: "modify", path: "/work/a.ts" },
  { operation: "rename", path: "/work/before.ts", destination_path: "/work/after.ts" },
  { operation: "delete", path: "/work/removed.ts" },
];
const partialApplyDetails = {
  kind: "workspace_edit_apply",
  preview_id: "preview-1",
  mutation_manifest: [],
  changed_paths: ["/work/a.ts", "/work/after.ts"],
  state: "partial_failure",
};

test.each([
  ["lsp_apply", { preview_id: "preview-1", mutation_manifest: verifiedManifest }],
  ["lsp", { operation: "apply", preview_id: "preview-1", mutation_manifest: verifiedManifest }],
])("uses verified %s manifests and actual changed result paths", (toolName, input) => {
  expect(
    extractPostEditDiagnosticPaths(
      mutationEvent({ toolName, input, isError: true, details: partialApplyDetails }),
    ),
  ).toEqual({
    paths: [{ path: "/work/a.ts" }, { path: "/work/after.ts" }],
    warnings: [],
  });
});

test.each(["lsp_rename", "lsp_code_actions", "not_lsp"])(
  "ignores %s results even with a valid manifest and apply details",
  (toolName) => {
    // Only the tool name distinguishes this from a real lsp_apply result.
    expect(
      extractPostEditDiagnosticPaths(
        mutationEvent({
          toolName,
          input: { preview_id: "preview-1", mutation_manifest: verifiedManifest },
          details: { ...partialApplyDetails, state: "applied" },
        }),
      ),
    ).toBeUndefined();
  },
);

test("ignores an lsp_apply result without Workspace Edit application details", () => {
  expect(
    extractPostEditDiagnosticPaths(
      mutationEvent({
        toolName: "lsp_apply",
        input: { preview_id: "preview-1", mutation_manifest: verifiedManifest },
        details: undefined,
      }),
    ),
  ).toBeUndefined();
  expect(
    extractPostEditDiagnosticPaths(
      mutationEvent({
        toolName: "lsp_apply",
        input: { preview_id: "preview-1", mutation_manifest: verifiedManifest },
        details: { kind: "workspace_edit_preview", preview_id: "preview-1" },
      }),
    ),
  ).toBeUndefined();
});

test.each([false, true])(
  "keeps isError %s on a partial lsp_apply failure it augments",
  async (isError) => {
    const result = await appendPostEditDiagnostics(
      mutationEvent({
        toolName: "lsp_apply",
        input: { preview_id: "preview-1", mutation_manifest: verifiedManifest },
        details: partialApplyDetails,
        isError,
      }),
      async () => [{ kind: "no_diagnostics", path: "/work/a.ts" }],
      "/work",
    );
    // A false input stays false: Post-edit Diagnostics never flips the error state.
    expect(result?.isError).toBe(isError);
  },
);

test("keeps the structured result of an lsp_apply call it augments", async () => {
  const structuredContent = { preview_id: "preview-1", state: "applied", truncated: false };
  const result = await appendPostEditDiagnostics(
    mutationEvent({
      toolName: "lsp_apply",
      input: { preview_id: "preview-1", mutation_manifest: verifiedManifest },
      details: { ...partialApplyDetails, state: "applied" },
      structuredContent,
    }),
    async () => [{ kind: "no_diagnostics", path: "/work/a.ts" }],
    "/work",
  );
  expect(result?.structuredContent).toBe(structuredContent);
});

function diagnosticOutcome(
  path: string,
  severity: number,
  message: string,
  serverId = "typescript",
): PostEditDiagnosticOutcome {
  return {
    kind: "diagnostic",
    diagnostic: { serverId, path, line: 3, character: 7, severity, message },
  };
}

async function appendedText(
  outcomes: readonly PostEditDiagnosticOutcome[],
  cwd = "/work",
): Promise<string | undefined> {
  const result = await appendPostEditDiagnostics(
    mutationEvent({ toolName: "apply_patch", details: applyPatchDetails(["unused"]) }),
    async () => outcomes,
    cwd,
  );
  const appended = result?.content.at(-1);
  return appended?.type === "text" ? appended.text : undefined;
}

function applyPatchDetails(changedFiles: string[]) {
  return {
    status: "success",
    result: { changedFiles, createdFiles: [], deletedFiles: [], movedFiles: [] },
  };
}

test("appends diagnostics after a partial mutation without changing mutation fields", async () => {
  const event = mutationEvent({
    toolName: "apply_patch",
    isError: true,
    details: {
      status: "partial_failure",
      result: {
        changedFiles: ["src/example.ts"],
        createdFiles: [],
        deletedFiles: [],
        movedFiles: [],
      },
    },
  });
  const result = await appendPostEditDiagnostics(
    event,
    async (paths) => {
      expect(paths).toEqual([{ path: "src/example.ts" }]);
      return [
        diagnosticOutcome("/work/z.ts", 2, "warning", "z-server"),
        { kind: "timeout" as const, path: "/work/src/example.ts", serverId: "typescript" },
        { kind: "no_diagnostics" as const, path: "/work/empty.ts" },
        diagnosticOutcome("/work/a.ts", 1, "error", "a-server"),
        diagnosticOutcome("/work/a.ts", 1, "error", "a-server"),
      ];
    },
    "/work",
  );

  expect(result).toMatchObject({ details: event.details, isError: true });
  expect(result?.content).toHaveLength(2);
  expect(result?.content.at(-1)).toEqual({
    type: "text",
    text: "\n\nLSP diagnostics\na.ts:3:7 error [a-server]: error\na.ts:3:7 error [a-server]: error\nz.ts:3:7 warning [z-server]: warning\nsrc/example.ts: diagnostics timeout (typescript)\nno diagnostics: empty.ts",
  });
});

test("names severities and shows workspace-relative paths for findings", async () => {
  await expect(
    appendedText([
      diagnosticOutcome("/work/src/a.ts", 4, "consider this"),
      diagnosticOutcome("/work/src/a.ts", 3, "fyi"),
      diagnosticOutcome("/work/src/a.ts", 2, "careful"),
      diagnosticOutcome("/work/src/a.ts", 1, "broken\n  in two lines"),
      diagnosticOutcome("/elsewhere/b.ts", 9, "unknown severity"),
    ]),
  ).resolves.toBe(
    [
      "",
      "",
      "LSP diagnostics",
      "src/a.ts:3:7 error [typescript]: broken in two lines",
      "src/a.ts:3:7 warning [typescript]: careful",
      "src/a.ts:3:7 info [typescript]: fyi",
      "src/a.ts:3:7 hint [typescript]: consider this",
      "/elsewhere/b.ts:3:7 severity 9 [typescript]: unknown severity",
    ].join("\n"),
  );
});

test("keeps a long finding message whole, collapsed onto one line", async () => {
  const message = `Type 'A' is not assignable to type 'B'.\n  ${"Types of property 'x' are incompatible. ".repeat(12)}`;
  const text = await appendedText([diagnosticOutcome("/work/a.ts", 1, message)]);
  expect(message.length).toBeGreaterThan(400);
  expect(text).toBe(
    `\n\nLSP diagnostics\na.ts:3:7 error [typescript]: ${message.replaceAll(/\s+/gu, " ").trim()}`,
  );
});

test("reports clean results from configured servers on one line", async () => {
  await expect(appendedText([{ kind: "no_diagnostics", path: "/work/a.ts" }])).resolves.toBe(
    "\n\nLSP diagnostics: no diagnostics",
  );
  await expect(
    appendedText([
      { kind: "no_diagnostics", path: "/work/a.ts" },
      { kind: "no_diagnostics", path: "/work/b.ts" },
    ]),
  ).resolves.toBe("\n\nLSP diagnostics: no diagnostics");
});

test("groups clean files into one line after the findings and omits files with no configured server", async () => {
  await expect(
    appendedText([
      { kind: "no_configured_server", path: "/work/package.json" },
      { kind: "no_diagnostics", path: "/work/b.ts" },
      { kind: "no_configured_server", path: "/work/notes.md" },
      diagnosticOutcome("/work/c.ts", 1, "broken"),
      { kind: "no_diagnostics", path: "/work/a.ts" },
      { kind: "no_configured_server", path: "/work/docs/a.md" },
      { kind: "timeout", path: "/work/slow.ts", serverId: "typescript" },
    ]),
  ).resolves.toBe(
    [
      "",
      "",
      "LSP diagnostics",
      "c.ts:3:7 error [typescript]: broken",
      "slow.ts: diagnostics timeout (typescript)",
      "no diagnostics: a.ts, b.ts",
    ].join("\n"),
  );
});

test("leaves a file with a finding out of the clean line when another Server Instance reported it clean", async () => {
  await expect(
    appendedText([
      diagnosticOutcome("/work/src/a.ts", 1, "broken"),
      { kind: "no_diagnostics", path: "/work/src/a.ts" },
      { kind: "no_diagnostics", path: "/work/src/b.ts" },
    ]),
  ).resolves.toBe(
    [
      "",
      "",
      "LSP diagnostics",
      "src/a.ts:3:7 error [typescript]: broken",
      "no diagnostics: src/b.ts",
    ].join("\n"),
  );
  await expect(
    appendedText([
      diagnosticOutcome("/work/src/a.ts", 1, "broken"),
      { kind: "no_diagnostics", path: "/work/src/a.ts" },
    ]),
  ).resolves.toBe("\n\nLSP diagnostics\nsrc/a.ts:3:7 error [typescript]: broken");
});

test("drops a file with no configured server from the one-line clean result", async () => {
  await expect(
    appendedText([
      { kind: "no_diagnostics", path: "/work/a.ts" },
      { kind: "no_configured_server", path: "/work/README.md" },
    ]),
  ).resolves.toBe("\n\nLSP diagnostics: no diagnostics");
});

test("still reports a matched server failure beside a file with no configured server", async () => {
  await expect(
    appendedText([
      { kind: "no_configured_server", path: "/work/README.md" },
      { kind: "unavailable_server", path: "/work/a.ts", serverId: "typescript" },
    ]),
  ).resolves.toBe("\n\nLSP diagnostics\na.ts: unavailable server (typescript)");
});

test("leaves the mutation result unchanged when no edited file has a configured server", async () => {
  const event = mutationEvent({
    toolName: "apply_patch",
    details: applyPatchDetails(["README.md", "package.json"]),
  });
  await expect(
    appendPostEditDiagnostics(
      event,
      async () => [
        { kind: "no_configured_server", path: "/work/README.md" },
        { kind: "no_configured_server", path: "/work/package.json" },
      ],
      "/work",
    ),
  ).resolves.toBeUndefined();
});
