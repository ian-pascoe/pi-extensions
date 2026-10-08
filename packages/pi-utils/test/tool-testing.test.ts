import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { acceptNullForOptionalArguments } from "../src/null-optional-arguments.js";
import {
  expectNullOptionalArgumentsOmitted,
  optionalParametersRejectingNull,
  recordToolRegistrations,
  sampleRequiredArguments,
  toolDeclarations,
} from "../src/tool-testing.js";

const parameters = Type.Object({
  path: Type.String({ minLength: 3 }),
  line: Type.Integer({ minimum: 4 }),
  mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
  flag: Type.Boolean(),
  list: Type.Array(Type.String(), { minItems: 2 }),
  nested: Type.Object({ id: Type.Integer() }),
  depth: Type.Optional(Type.Integer()),
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

describe("tool testing helpers", () => {
  test("samples a valid call that sets only required parameters", () => {
    const sampled = sampleRequiredArguments(parameters);
    expect(Value.Check(parameters, sampled)).toBe(true);
    expect(Object.keys(sampled).toSorted()).toEqual(
      ["flag", "line", "list", "mode", "nested", "path"].toSorted(),
    );
  });

  test("lists the optional parameters that reject null, not those that accept it", () => {
    expect(optionalParametersRejectingNull(parameters)).toEqual(["depth"]);
  });

  test("fails a tool that rejects null for an optional parameter and passes one that accepts it", () => {
    const tool = { name: "t", parameters };
    expect(() => expectNullOptionalArgumentsOmitted(tool)).toThrow(/depth/);
    expect(expectNullOptionalArgumentsOmitted(acceptNullForOptionalArguments(tool))).toEqual([
      "depth",
    ]);
  });

  test("records registered tools in order and ignores every other pi call", () => {
    const { pi, tools } = recordToolRegistrations();
    pi.on("session_start", () => undefined);
    for (const name of ["one", "two"]) {
      pi.registerTool(
        defineTool({
          name,
          label: name,
          description: name,
          parameters,
          execute: async () => ({ content: [], details: undefined }),
        }),
      );
    }
    expect(tools.map(({ name }) => name)).toEqual(["one", "two"]);
  });

  test("serializes ordered declarations for byte comparison", () => {
    const declared = [{ name: "t", description: "D", parameters, extra: 1 }];
    expect(toolDeclarations(declared)).toBe(
      JSON.stringify([{ name: "t", description: "D", parameters }], undefined, 2),
    );
  });
});
