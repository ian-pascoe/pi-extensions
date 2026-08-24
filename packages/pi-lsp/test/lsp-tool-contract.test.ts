import { Value } from "typebox/value";
import { LspToolParametersSchema } from "../src/lsp-tool-contract.js";
import { describe, expect, test } from "vitest";

describe("Pi LSP tool contract", () => {
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
});
