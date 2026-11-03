import { StringEnum as piAiStringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { StringEnum } from "../src/string-enum.js";

describe("StringEnum", () => {
  it("declares the same JSON Schema as pi-ai's StringEnum", () => {
    const values = ["text", "markdown"] as const;
    const options = { description: "Output format", default: "text" } as const;
    expect(JSON.stringify(StringEnum(values, options))).toBe(
      JSON.stringify(piAiStringEnum(values, options)),
    );
    expect(JSON.stringify(StringEnum(values))).toBe(JSON.stringify(piAiStringEnum(values)));
  });

  it("infers its members inside a TypeBox object", () => {
    const schema = Type.Object({ format: StringEnum(["text", "markdown"] as const) });
    expectTypeOf<Static<typeof schema>>().toEqualTypeOf<{ format: "text" | "markdown" }>();
  });
});
