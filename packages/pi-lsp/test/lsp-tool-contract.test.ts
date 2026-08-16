import { Value } from "typebox/value";
import {
  LspToolParametersSchema,
  LspToolResultDetailsSchema,
  MutationManifestSchema,
} from "../src/lsp-tool-contract.js";
import { describe, expect, test } from "vitest";

const supportedOperations = [
  "status",
  "capabilities",
  "restart",
  "diagnostics",
  "workspace_diagnostics",
  "completion",
  "hover",
  "signature_help",
  "declaration",
  "goto_definition",
  "goto_type_definition",
  "goto_implementation",
  "find_references",
  "document_highlights",
  "document_symbols",
  "workspace_symbols",
  "document_links",
  "call_hierarchy",
  "incoming_calls",
  "outgoing_calls",
  "type_hierarchy",
  "supertypes",
  "subtypes",
  "selection_ranges",
  "folding_ranges",
  "code_lenses",
  "inlay_hints",
  "document_colors",
  "format_document",
  "format_range",
  "format_on_type",
  "prepare_rename",
  "rename",
  "code_actions",
  "apply",
];

const position = { line: 1, character: 1 };
const range = { start: position, end: { line: 1, character: 2 } };
const formatting = { tab_size: 2, insert_spaces: true };

const validInputs = [
  { operation: "status" },
  { operation: "capabilities", server_id: "typescript", file_path: "src/a.ts" },
  { operation: "restart", server_id: "typescript", file_path: "src/a.ts" },
  { operation: "diagnostics", file_path: "src/a.ts" },
  { operation: "workspace_diagnostics", server_id: "typescript", file_path: "src/a.ts" },
  { operation: "completion", file_path: "src/a.ts", ...position },
  { operation: "hover", file_path: "src/a.ts", ...position },
  { operation: "signature_help", file_path: "src/a.ts", ...position },
  { operation: "declaration", file_path: "src/a.ts", ...position },
  { operation: "goto_definition", file_path: "src/a.ts", ...position },
  { operation: "goto_type_definition", file_path: "src/a.ts", ...position },
  { operation: "goto_implementation", file_path: "src/a.ts", ...position },
  { operation: "find_references", file_path: "src/a.ts", ...position },
  { operation: "document_highlights", file_path: "src/a.ts", ...position },
  { operation: "document_symbols", file_path: "src/a.ts" },
  { operation: "workspace_symbols", query: "Thing", file_path: "src/a.ts" },
  { operation: "document_links", file_path: "src/a.ts" },
  { operation: "call_hierarchy", file_path: "src/a.ts", ...position },
  { operation: "incoming_calls", file_path: "src/a.ts", ...position },
  { operation: "outgoing_calls", file_path: "src/a.ts", ...position },
  { operation: "type_hierarchy", file_path: "src/a.ts", ...position },
  { operation: "supertypes", file_path: "src/a.ts", ...position },
  { operation: "subtypes", file_path: "src/a.ts", ...position },
  { operation: "selection_ranges", file_path: "src/a.ts", positions: [position] },
  { operation: "folding_ranges", file_path: "src/a.ts" },
  { operation: "code_lenses", file_path: "src/a.ts" },
  { operation: "inlay_hints", file_path: "src/a.ts", range },
  { operation: "document_colors", file_path: "src/a.ts" },
  { operation: "format_document", file_path: "src/a.ts", ...formatting },
  { operation: "format_range", file_path: "src/a.ts", range, ...formatting },
  {
    operation: "format_on_type",
    file_path: "src/a.ts",
    ...position,
    trigger_character: ";",
    ...formatting,
  },
  { operation: "prepare_rename", file_path: "src/a.ts", ...position },
  { operation: "rename", file_path: "src/a.ts", ...position, new_name: "renamed" },
  { operation: "code_actions", file_path: "src/a.ts", range },
  { operation: "apply", preview_id: "preview-1" },
];

describe("Pi LSP tool contract", () => {
  test("contains every supported snake_case operation exactly once", () => {
    const branches = LspToolParametersSchema.anyOf;
    expect(branches).toHaveLength(supportedOperations.length);
    expect(branches.map((branch) => branch.properties.operation.const)).toEqual(
      supportedOperations,
    );
    expect(validInputs).toHaveLength(supportedOperations.length);
    for (const input of validInputs) expect(Value.Check(LspToolParametersSchema, input)).toBe(true);
  });

  test("rejects missing branch fields, unknown fields, and zero-based coordinates", () => {
    expect(
      Value.Check(LspToolParametersSchema, { operation: "completion", file_path: "a.ts" }),
    ).toBe(false);
    expect(
      Value.Check(LspToolParametersSchema, {
        operation: "hover",
        file_path: "a.ts",
        line: 0,
        character: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(LspToolParametersSchema, {
        operation: "format_document",
        file_path: "a.ts",
        tab_size: 2,
        insert_spaces: true,
        unknown: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(LspToolParametersSchema, {
        operation: "apply",
        preview_id: "preview-1",
        mutation_manifest: [
          { operation: "rename", path: "/a.ts", destination_path: "relative.ts" },
        ],
      }),
    ).toBe(false);
  });

  test("accepts only normalized operation, preview, and apply result details", () => {
    expect(
      Value.Check(LspToolResultDetailsSchema, {
        kind: "operation",
        operation: "hover",
        server_outcomes: [{ server_id: "typescript", outcome: "success" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(LspToolResultDetailsSchema, {
        kind: "workspace_edit_preview",
        preview_id: "preview-1",
        operation: "rename",
        summary: "Rename symbol",
        mutation_manifest: [{ operation: "modify", path: "/workspace/a.ts" }],
        preview_record: {
          kind: "workspace_edit_preview",
          preview_id: "preview-1",
          server_id: "typescript",
          summary: "Rename symbol",
          state: "available",
          operations: [],
        },
        state: "available",
      }),
    ).toBe(true);
    expect(
      Value.Check(LspToolResultDetailsSchema, {
        kind: "workspace_edit_preview",
        preview_id: "preview-1",
        operation: "hover",
        summary: "unexpected raw response",
        mutation_manifest: [],
        preview_record: {
          kind: "workspace_edit_preview",
          preview_id: "preview-1",
          server_id: "typescript",
          summary: "unexpected raw response",
          state: "available",
          operations: [],
        },
        state: "available",
      }),
    ).toBe(false);
    expect(
      Value.Check(MutationManifestSchema, [{ operation: "delete", path: "/workspace/a.ts" }]),
    ).toBe(true);
  });
});
