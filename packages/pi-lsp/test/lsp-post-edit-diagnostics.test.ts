import { expect, test } from "vitest";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  appendPostEditDiagnostics,
  extractPostEditDiagnosticPaths,
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
  );
  expect(result?.structuredContent).toBe(structuredContent);
});

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
  const result = await appendPostEditDiagnostics(event, async (paths) => {
    expect(paths).toEqual([{ path: "src/example.ts" }]);
    return [
      {
        kind: "diagnostic" as const,
        diagnostic: {
          serverId: "z-server",
          path: "z.ts",
          line: 2,
          character: 2,
          severity: 2,
          message: "warning",
        },
      },
      { kind: "timeout" as const, path: "src/example.ts", serverId: "typescript" },
      { kind: "no_diagnostics" as const, path: "empty.ts" },
      {
        kind: "diagnostic" as const,
        diagnostic: {
          serverId: "a-server",
          path: "a.ts",
          line: 1,
          character: 1,
          severity: 1,
          message: "error",
        },
      },
      {
        kind: "diagnostic" as const,
        diagnostic: {
          serverId: "a-server",
          path: "a.ts",
          line: 1,
          character: 1,
          severity: 1,
          message: "error",
        },
      },
    ];
  });

  expect(result).toMatchObject({ details: event.details, isError: true });
  expect(result?.content).toHaveLength(2);
  expect(result?.content.at(-1)).toEqual({
    type: "text",
    text: "\n\nLSP diagnostics\na.ts:1:1 [a-server] severity 1: error\na.ts:1:1 [a-server] severity 1: error\nz.ts:2:2 [z-server] severity 2: warning\nempty.ts: no diagnostics\nsrc/example.ts: diagnostics timeout (typescript)",
  });
});
