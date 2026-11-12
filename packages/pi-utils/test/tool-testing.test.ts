import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vite-plus/test";
import { acceptNullForOptionalArguments } from "../src/null-optional-arguments.js";
import {
  expectNullOptionalArgumentsOmitted,
  sampleRequiredArguments,
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

  test("fails a tool that rejects null for an optional parameter and passes one that accepts it", () => {
    const tool = { name: "t", parameters };
    expect(() => expectNullOptionalArgumentsOmitted(tool)).toThrow(/depth/);
    expect(expectNullOptionalArgumentsOmitted(acceptNullForOptionalArguments(tool))).toEqual([
      "depth",
    ]);
  });
});
