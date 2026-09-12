import { type TObject, Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
  DapToolParametersSchema,
  DapToolProviderParametersSchema,
} from "../src/dap-tool-contract.js";
import { createDapToolDefinition } from "../src/dap-tool.js";

const branches = DapToolParametersSchema.anyOf.flatMap<TObject>((branch) =>
  "anyOf" in branch ? branch.anyOf : [branch],
);
const OperationSchema = Type.Object({ const: Type.String() });

describe("DAP provider parameters", () => {
  test("registers a plain object and documents operation-specific requirements", () => {
    const tool = createDapToolDefinition(() => undefined);
    expect(tool.parameters).toBe(DapToolProviderParametersSchema);
    expect(tool.parameters.type).toBe("object");
    expect(Object.hasOwn(tool.parameters, "anyOf")).toBe(false);
    expect(tool.parameters).toMatchObject({ additionalProperties: false });
    expect(tool.parameters.required).toEqual(["operation"]);
    expect(tool.description).toContain("set_breakpoints: required file_path and breakpoints");
    expect(tool.description).toContain("evaluate: required expression; optional frame_id");
    expect(tool.description).toContain(
      "variables: exactly one of frame_id or variables_reference is required (never both)",
    );
  });

  test("covers every strict operation and reuses every branch field schema", () => {
    const operations = new Set<string>();
    const fields = new Map<string, string>();
    for (const branch of branches) {
      const operation = branch.properties.operation;
      if (!Value.Check(OperationSchema, operation)) throw new Error("Missing operation literal");
      operations.add(operation.const);
      for (const [name, schema] of Object.entries(branch.properties)) {
        if (name === "operation") continue;
        const serialized = JSON.stringify(schema);
        if (fields.has(name))
          expect(serialized, `branches disagree on ${name}`).toBe(fields.get(name));
        fields.set(name, serialized);
      }
    }
    expect(branches).toHaveLength(13); // Includes both exclusive variables branches.
    expect(DapToolProviderParametersSchema.properties.operation).toMatchObject({
      type: "string",
      enum: [...operations],
    });
    expect(Object.keys(DapToolProviderParametersSchema.properties).sort()).toEqual(
      ["operation", ...fields.keys()].sort(),
    );
    const providerFields = new Map(Object.entries(DapToolProviderParametersSchema.properties));
    for (const [name, schema] of fields) {
      expect(JSON.stringify(providerFields.get(name)), `provider ${name} drifted`).toBe(schema);
    }
  });
});
