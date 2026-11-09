/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: Tests feed arbitrary JSON arguments to the helpers under test. */
import { Type, type TSchema } from "typebox";
import { describe, expect, test } from "vitest";
import {
  acceptNullForOptionalArguments,
  omitNullOptionalArguments,
} from "../src/null-optional-arguments.js";

const Point = Type.Object({ x: Type.Integer(), label: Type.Optional(Type.String()) });

interface Case {
  readonly name: string;
  readonly schema: TSchema;
  readonly input: unknown;
  readonly expected: unknown;
}

const cases: readonly Case[] = [
  {
    name: "drops a null optional string",
    schema: Type.Object({ path: Type.String(), note: Type.Optional(Type.String()) }),
    input: { path: "a", note: null },
    expected: { path: "a" },
  },
  {
    name: "keeps a null required property so validation reports it",
    schema: Type.Object({ path: Type.String(), note: Type.Optional(Type.String()) }),
    input: { path: null, note: null },
    expected: { path: null },
  },
  {
    name: "keeps a null whose optional schema accepts null (todo description)",
    schema: Type.Object({
      description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      title: Type.Optional(Type.String()),
    }),
    input: { description: null, title: null },
    expected: { description: null },
  },
  {
    name: "keeps a null for an optional property that accepts any value",
    schema: Type.Object({ value: Type.Optional(Type.Unknown()) }),
    input: { value: null },
    expected: { value: null },
  },
  {
    name: "keeps a null whose property schema cannot be resolved",
    // SAFETY: A JSON Schema with a dangling reference, which TypeBox's builders cannot express.
    schema: { type: "object", properties: { link: { $ref: "#/$defs/Missing" } } } as TSchema,
    input: { link: null },
    expected: { link: null },
  },
  {
    name: "drops a null optional property inside array items",
    schema: Type.Object({ points: Type.Array(Point) }),
    input: { points: [{ x: 1, label: null }, { x: 2, label: "b" }, { x: 3 }] },
    expected: { points: [{ x: 1 }, { x: 2, label: "b" }, { x: 3 }] },
  },
  {
    name: "drops a null optional property inside tuple items",
    schema: Type.Object({ pair: Type.Tuple([Point, Point]) }),
    input: { pair: [{ x: 1, label: null }, { x: 2 }] },
    expected: { pair: [{ x: 1 }, { x: 2 }] },
  },
  {
    name: "normalizes the union branch the value needs, which Pi's own null handling skips",
    schema: Type.Object({
      target: Type.Union([
        Type.Object({
          kind: Type.Literal("file"),
          path: Type.String(),
          range: Type.Optional(Type.String()),
        }),
        Type.Object({ kind: Type.Literal("url"), url: Type.String() }),
      ]),
    }),
    input: { target: { kind: "file", path: "a", range: null } },
    expected: { target: { kind: "file", path: "a" } },
  },
  {
    name: "leaves a union member alone when the value already satisfies a branch",
    schema: Type.Object({
      target: Type.Union([
        Type.Object({ note: Type.Union([Type.String(), Type.Null()]) }),
        Type.Object({ note: Type.Optional(Type.String()) }),
      ]),
    }),
    input: { target: { note: null } },
    expected: { target: { note: null } },
  },
  {
    name: "does not rewrite values of a record, whose entries are not optional parameters",
    schema: Type.Object({
      env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
      flags: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    input: { env: { HOME: null }, flags: { a: null } },
    expected: { env: { HOME: null }, flags: { a: null } },
  },
  {
    name: "passes a non-object argument through",
    schema: Type.Object({ a: Type.Optional(Type.String()) }),
    input: null,
    expected: null,
  },
  {
    name: "applies every allOf member",
    schema: Type.Intersect([
      Type.Object({ a: Type.Optional(Type.String()) }),
      Type.Object({ b: Type.Optional(Type.Integer()) }),
    ]),
    input: { a: null, b: null },
    expected: {},
  },
];

describe("omitNullOptionalArguments", () => {
  test.each(cases)("$name", ({ schema, input, expected }) => {
    expect(omitNullOptionalArguments(schema, input)).toEqual(expected);
  });

  test("returns the same value when nothing changes", () => {
    const schema = Type.Object({ path: Type.String(), note: Type.Optional(Type.String()) });
    const input = { path: "a", note: "n", extra: [1] };
    expect(omitNullOptionalArguments(schema, input)).toBe(input);
  });

  test("never mutates the arguments it is given", () => {
    const schema = Type.Object({ points: Type.Array(Point), note: Type.Optional(Type.String()) });
    const input = { points: [{ x: 1, label: null }], note: null };
    const snapshot = structuredClone(input);
    expect(omitNullOptionalArguments(schema, input)).toEqual({ points: [{ x: 1 }] });
    expect(input).toEqual(snapshot);
  });
});

describe("acceptNullForOptionalArguments", () => {
  const parameters = Type.Object({ path: Type.String(), depth: Type.Optional(Type.Integer()) });
  const execute = async () => ({ content: [], details: undefined });

  test("keeps every other field of the tool, including its schema, by identity", () => {
    const original = {
      name: "t",
      label: "T",
      description: "D",
      parameters,
      execute,
      promptGuidelines: ["g"],
    };
    const tool = acceptNullForOptionalArguments(original);
    expect(tool).toEqual({ ...original, prepareArguments: expect.any(Function) });
    expect(tool.parameters).toBe(parameters);
    expect(JSON.stringify(tool.parameters)).toBe(JSON.stringify(original.parameters));
    expect(original).not.toHaveProperty("prepareArguments");
  });

  test("hands the normalized arguments to the tool's own prepareArguments", () => {
    const received: unknown[] = [];
    const tool = acceptNullForOptionalArguments({
      name: "t",
      parameters,
      execute,
      prepareArguments: (arguments_: unknown) => {
        received.push(arguments_);
        // SAFETY: The test passes an object.
        return { ...(arguments_ as object), prepared: true };
      },
    });
    expect(tool.prepareArguments?.({ path: "a", depth: null })).toEqual({
      path: "a",
      prepared: true,
    });
    expect(received).toEqual([{ path: "a" }]);
  });
});
