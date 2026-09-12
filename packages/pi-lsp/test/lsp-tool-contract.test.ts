import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
  LspToolOperationRequirements,
  LspToolParametersSchema,
  LspToolProviderParametersSchema,
} from "../src/lsp-tool-contract.js";
import { describe, expect, test } from "vitest";

/** The operation names one TypeBox schema declares, as a JSON Schema `enum` or a single `const`. */
const JsonSchemaEnumNamesSchema = Type.Object({ enum: Type.Array(Type.String()) });
const JsonSchemaConstNameSchema = Type.Object({ const: Type.String() });

function schemaOperationNames(schema: TSchema | undefined): readonly string[] {
  if (schema === undefined) return [];
  if (Value.Check(JsonSchemaEnumNamesSchema, schema)) return schema.enum;
  if (Value.Check(JsonSchemaConstNameSchema, schema)) return [schema.const];
  return [];
}

/** Deterministic ordering so the coverage comparison is independent of schema order. */
function compareOperationNames(left: string, right: string): number {
  return left.localeCompare(right);
}

describe("Pi LSP tool contract", () => {
  test("registers provider parameters as a JSON Schema object", () => {
    // Function-calling providers require a tool's `parameters` to be `type: "object"`. A
    // top-level union serialises to `anyOf` with no `type`, and strict providers reject every
    // request while such a tool is registered.
    expect(LspToolProviderParametersSchema.type).toBe("object");
    expect("anyOf" in LspToolProviderParametersSchema).toBe(false);
    expect(LspToolProviderParametersSchema.required).toContain("operation");
  });

  test("documents every operation's required fields without making the provider schema a union", () => {
    const documented = LspToolOperationRequirements.split("\n").flatMap((line) => {
      const [operations, fields] = line.split(": ");
      if (operations === undefined || fields === undefined) throw new Error("Missing requirements");
      return operations.split(", ").map((operation) => ({
        operation,
        required: fields === "none" ? [] : fields.split(", ").sort(),
      }));
    });
    const expected = LspToolParametersSchema.anyOf.map((branch) => ({
      operation: branch.properties.operation.const,
      required: branch.required.filter((field) => field !== "operation").sort(),
    }));
    expect(documented).toHaveLength(expected.length);
    expect(documented).toEqual(expect.arrayContaining(expected));
    expect(LspToolProviderParametersSchema.required).toEqual(["operation"]);
    expect(LspToolOperationRequirements.split("\n")).toContain("status: none");
  });

  test("provider parameters accept every operation and every field the branches use", () => {
    const branchFields = new Set<string>();
    const branchOperations = new Set<string>();
    for (const branch of LspToolParametersSchema.anyOf ?? []) {
      for (const field of Object.keys(branch.properties ?? {})) {
        branchFields.add(field);
      }
      for (const name of schemaOperationNames(branch.properties?.operation))
        branchOperations.add(name);
    }

    const providerFields = new Set(Object.keys(LspToolProviderParametersSchema.properties ?? {}));
    for (const field of branchFields) expect(providerFields).toContain(field);
    expect(providerFields).toContain("operation");

    const providerOperations = schemaOperationNames(
      LspToolProviderParametersSchema.properties.operation,
    );
    expect([...providerOperations].sort(compareOperationNames)).toEqual(
      [...branchOperations].sort(compareOperationNames),
    );
  });

  test("provider parameters reuse the branch field schemas", () => {
    // Field names alone are too weak a guard: a branch that narrowed or widened one field would
    // still satisfy name coverage while the registered schema silently rejected arguments the
    // ingress validator accepts, or accepted arguments it rejects.
    const variantsByField = new Map<string, Set<string>>();
    for (const branch of LspToolParametersSchema.anyOf ?? []) {
      for (const [field, schema] of Object.entries(branch.properties ?? {})) {
        if (field === "operation") continue; // compared as an operation set above
        const variants = variantsByField.get(field) ?? new Set<string>();
        variants.add(JSON.stringify(schema));
        variantsByField.set(field, variants);
      }
    }

    const providerByField = new Map(
      Object.entries(LspToolProviderParametersSchema.properties ?? {}),
    );
    const providerOnly = [...providerByField.keys()].filter(
      (field) => field !== "operation" && !variantsByField.has(field),
    );
    expect(providerOnly, "provider parameters declare fields no branch uses").toEqual([]);
    for (const [field, variants] of variantsByField) {
      expect([...variants], `branches disagree about the ${field} schema`).toHaveLength(1);
      expect(JSON.stringify(providerByField.get(field)), `provider ${field} drifted`).toBe(
        [...variants][0],
      );
    }
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
});
