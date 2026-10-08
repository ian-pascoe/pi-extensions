import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vitest";
import { createPiDapExtension } from "../src/pi-dap-extension.js";

test("every dap_* tool treats null for an optional parameter like omitting it", async () => {
  const { pi, tools } = recordToolRegistrations();
  await createPiDapExtension(() => "/nonexistent")(pi);

  expect(tools).toHaveLength(12);
  const proven = new Map(
    tools.map((tool) => [
      tool.name,
      tool.name === "dap_variables"
        ? // Exactly one of frame_id or variables_reference is required, though both are optional alone.
          expectNullOptionalArgumentsOmitted(tool, { variables_reference: 7 }, [
            "variables_reference",
          ])
        : expectNullOptionalArgumentsOmitted(tool),
    ]),
  );
  // Each tool parses its arguments strictly in `prepareArguments`, which rejects null outright.
  expect(proven.get("dap_launch")).toEqual(expect.arrayContaining(["profile", "args", "cwd"]));
  expect(proven.get("dap_stack")).toEqual(expect.arrayContaining(["count", "start"]));
  expect(proven.get("dap_evaluate")).toContain("frame_id");
  expect(proven.get("dap_variables")).toEqual(
    expect.arrayContaining(["frame_id", "start", "count"]),
  );
});

test("dap_set_breakpoints drops a null condition of a breakpoint", async () => {
  const { pi, tools } = recordToolRegistrations();
  await createPiDapExtension(() => "/nonexistent")(pi);
  const tool = tools.find(({ name }) => name === "dap_set_breakpoints");
  const withNull = { file_path: "a.ts", breakpoints: [{ line: 3, condition: null }, { line: 4 }] };
  expect(tool?.prepareArguments?.(withNull)).toEqual({
    file_path: "a.ts",
    breakpoints: [{ line: 3 }, { line: 4 }],
  });
});
