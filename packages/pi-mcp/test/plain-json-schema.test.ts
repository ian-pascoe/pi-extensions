import { type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

const plainJsonSchema = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 1 },
  },
  required: ["count"],
  additionalProperties: false,
} as const;

describe("Pi plain JSON Schema registration seam", () => {
  test("accepts a structurally valid schema without TypeBox metadata", () => {
    expect(Object.getOwnPropertySymbols(plainJsonSchema)).toEqual([]);
    expect(Object.hasOwn(plainJsonSchema, Symbol.for("TypeBox.Kind"))).toBe(false);

    let registeredTool: unknown;
    const registerTool: ExtensionAPI["registerTool"] = (definition) => {
      registeredTool = definition;
    };
    const tool: ToolDefinition<typeof plainJsonSchema> = {
      name: "plain_json_schema_tracer",
      label: "Plain JSON Schema tracer",
      description: "Proves public extension registration accepts an exact plain schema.",
      parameters: plainJsonSchema,
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    };

    registerTool(tool);
    expect(registeredTool).toEqual(expect.objectContaining({ parameters: plainJsonSchema }));

    const piTool: Tool = {
      name: tool.name,
      description: tool.description,
      parameters: plainJsonSchema,
    };
    expect(
      validateToolArguments(piTool, {
        type: "toolCall",
        id: "plain-schema-call",
        name: tool.name,
        arguments: { count: "2" },
      }),
    ).toEqual({ count: 2 });
    expect(() =>
      validateToolArguments(piTool, {
        type: "toolCall",
        id: "invalid-plain-schema-call",
        name: tool.name,
        arguments: { count: 0 },
      }),
    ).toThrow('Validation failed for tool "plain_json_schema_tracer"');
  });
});
