import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { DAP_OPERATIONS, DapToolOutputSchemas } from "../src/dap-tool-contract.js";
import { createDapToolDefinitions, DAP_TOOL_NAMESPACE } from "../src/dap-tool.js";

const tools = createDapToolDefinitions(() => undefined);

function tool(name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing ${name}`);
  return found;
}

describe("DAP tool family", () => {
  test("registers one dap_<operation> tool per operation in one namespace", () => {
    expect(tools.map(({ name }) => name)).toEqual(
      DAP_OPERATIONS.map((operation) => `dap_${operation}`),
    );
    for (const [index, definition] of tools.entries()) {
      const operation = DAP_OPERATIONS[index];
      if (operation === undefined) throw new Error("Missing operation");
      expect(definition.namespace).toBe(DAP_TOOL_NAMESPACE);
      expect(definition.outputSchema).toBe(DapToolOutputSchemas[operation]);
      expect(definition.executionMode).toBe("sequential");
      expect(definition.promptGuidelines).toEqual(tools[0]?.promptGuidelines);
    }
    expect(DAP_TOOL_NAMESPACE).toMatchObject({ name: "dap" });
    expect(DAP_TOOL_NAMESPACE.instructions).toContain("same single Debug Session");
    // One snippet keeps the system prompt's tool list to one DAP line.
    expect(tools.filter((definition) => definition.promptSnippet !== undefined)).toEqual([
      tool("dap_launch"),
    ]);
  });

  test("declares the interactive core directly and leaves pause to codemode", () => {
    expect(
      Object.fromEntries(tools.map(({ name, exposure }) => [name, exposure ?? "direct"])),
    ).toEqual({
      dap_launch: "direct",
      dap_set_breakpoints: "direct",
      dap_continue: "direct",
      dap_next: "direct",
      dap_step_in: "direct",
      dap_step_out: "direct",
      dap_pause: "codemode",
      dap_stack: "direct",
      dap_variables: "direct",
      dap_evaluate: "direct",
      dap_status: "direct",
      dap_stop: "direct",
    });
  });

  test("annotates what each operation can do", () => {
    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    const execution = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    };
    const arbitraryCode = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
    expect(Object.fromEntries(tools.map(({ name, annotations }) => [name, annotations]))).toEqual({
      dap_launch: arbitraryCode,
      dap_set_breakpoints: { ...execution, idempotentHint: true },
      dap_continue: execution,
      dap_next: execution,
      dap_step_in: execution,
      dap_step_out: execution,
      dap_pause: { ...execution, idempotentHint: true },
      dap_stack: readOnly,
      dap_variables: readOnly,
      dap_evaluate: arbitraryCode,
      dap_status: readOnly,
      dap_stop: { ...readOnly, readOnlyHint: false, destructiveHint: true },
    });
  });

  test("registers plain object parameters holding only each operation's fields", () => {
    const fields = Object.fromEntries(
      tools.map(({ name, parameters }) => {
        expect(parameters.type).toBe("object");
        expect(Object.hasOwn(parameters, "anyOf")).toBe(false);
        expect(parameters).toMatchObject({ additionalProperties: false });
        return [name, [Object.keys(parameters.properties), parameters.required ?? []]];
      }),
    );
    expect(fields).toEqual({
      dap_launch: [["profile", "program", "args", "cwd"], []],
      dap_set_breakpoints: [
        ["file_path", "breakpoints"],
        ["file_path", "breakpoints"],
      ],
      dap_continue: [[], []],
      dap_next: [[], []],
      dap_step_in: [[], []],
      dap_step_out: [[], []],
      dap_pause: [[], []],
      dap_stack: [["thread_id", "start", "count"], []],
      dap_variables: [["frame_id", "variables_reference", "start", "count"], []],
      dap_evaluate: [["expression", "frame_id"], ["expression"]],
      dap_status: [[], []],
      dap_stop: [[], []],
    });
    expect(tool("dap_variables").description).toContain(
      "Exactly one of frame_id (every scope of a Stack Frame) or variables_reference (children of a value) is required, never both",
    );
  });

  test("keeps variables selector exclusivity inside the tool", () => {
    const variables = tool("dap_variables");
    // The provider-facing object admits both selectors; the strict ingress parser does not.
    expect(Value.Check(variables.parameters, { frame_id: 1, variables_reference: 2 })).toBe(true);
    expect(() => variables.prepareArguments?.({ frame_id: 1, variables_reference: 2 })).toThrow(
      "Pi DAP: invalid tool arguments",
    );
    expect(() => variables.prepareArguments?.({})).toThrow("Pi DAP: invalid tool arguments");
    expect(variables.prepareArguments?.({ frame_id: 0, count: 2 })).toEqual({
      frame_id: 0,
      count: 2,
    });
  });
});
