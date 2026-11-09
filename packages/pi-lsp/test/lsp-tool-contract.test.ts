import { Value } from "typebox/value";
import { LSP_OPERATION_NAMES, LspOperationParametersSchemas } from "../src/lsp-tool-contract.js";
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

  test("rejects a Mutation Manifest destination that is not absolute", () => {
    expect(
      Value.Check(LspOperationParametersSchemas.apply, {
        preview_id: "preview-1",
        mutation_manifest: [
          { operation: "rename", path: "/a.ts", destination_path: "relative.ts" },
        ],
      }),
    ).toBe(false);
  });
});
