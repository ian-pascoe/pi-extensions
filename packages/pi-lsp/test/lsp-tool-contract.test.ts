import { Value } from "typebox/value";
import {
  LSP_APPLY_RESULT_TOOL_NAMES,
  LSP_OPERATION_NAMES,
  LSP_RESULT_TOOL_NAMES,
  LspOperationParametersSchemas,
  lspToolName,
} from "../src/lsp-tool-contract.js";
import { describe, expect, test } from "vitest";

describe("Pi LSP tool contract", () => {
  test("gives every operation an object-shaped strict parameter schema", () => {
    // Function-calling providers require each tool's `parameters` to be `type: "object"`; a
    // top-level union serializes to `anyOf`, which strict providers reject on every request.
    expect(Object.keys(LspOperationParametersSchemas)).toEqual([...LSP_OPERATION_NAMES]);
    for (const operation of LSP_OPERATION_NAMES) {
      const schema = LspOperationParametersSchemas[operation];
      expect(schema.type, operation).toBe("object");
      expect("anyOf" in schema, operation).toBe(false);
      expect(schema, operation).toMatchObject({ additionalProperties: false });
      expect(Object.hasOwn(schema.properties, "operation"), operation).toBe(false);
    }
  });

  test("requires only each operation's own fields", () => {
    expect(LspOperationParametersSchemas.status.required ?? []).toEqual([]);
    expect(LspOperationParametersSchemas.hover.required).toEqual([
      "file_path",
      "line",
      "character",
    ]);
    expect(LspOperationParametersSchemas.workspace_symbols.required).toEqual([
      "query",
      "file_path",
    ]);
    expect(LspOperationParametersSchemas.capabilities.required).toEqual(["server_id", "file_path"]);
    expect(LspOperationParametersSchemas.restart.required).toEqual(["server_id", "file_path"]);
    expect(LspOperationParametersSchemas.workspace_diagnostics.required).toEqual(["file_path"]);
    expect(LspOperationParametersSchemas.format_document.required).toEqual([
      "file_path",
      "tab_size",
      "insert_spaces",
    ]);
    expect(LspOperationParametersSchemas.apply.required).toEqual(["preview_id"]);
  });

  test("rejects missing fields, unknown fields, and zero-based coordinates", () => {
    expect(Value.Check(LspOperationParametersSchemas.completion, { file_path: "a.ts" })).toBe(
      false,
    );
    expect(
      Value.Check(LspOperationParametersSchemas.hover, {
        file_path: "a.ts",
        line: 0,
        character: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(LspOperationParametersSchemas.hover, {
        operation: "hover",
        file_path: "a.ts",
        line: 1,
        character: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(LspOperationParametersSchemas.format_document, {
        file_path: "a.ts",
        tab_size: 2,
        insert_spaces: true,
        unknown: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(LspOperationParametersSchemas.apply, {
        preview_id: "preview-1",
        mutation_manifest: [
          { operation: "rename", path: "/a.ts", destination_path: "relative.ts" },
        ],
      }),
    ).toBe(false);
  });

  test("recognizes the legacy single tool and every per-operation tool in history", () => {
    expect(lspToolName("goto_definition")).toBe("lsp_goto_definition");
    expect([...LSP_RESULT_TOOL_NAMES]).toEqual([
      "lsp",
      ...LSP_OPERATION_NAMES.map((operation) => `lsp_${operation}`),
    ]);
    expect([...LSP_APPLY_RESULT_TOOL_NAMES].sort()).toEqual(["lsp", "lsp_apply"]);
  });
});
