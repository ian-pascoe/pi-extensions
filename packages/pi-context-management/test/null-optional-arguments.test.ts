import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vitest";
import contextManagement from "../src/context-management-extension.js";

test("each Context Management tool treats null for an optional parameter like omitting it", () => {
  const { pi, tools } = recordToolRegistrations();
  contextManagement(pi);

  expect(tools.map(({ name }) => name).toSorted()).toEqual([
    "context_history",
    "context_notes",
    "context_rollover",
  ]);
  const proven = Object.fromEntries(
    tools.map((tool) => [tool.name, expectNullOptionalArgumentsOmitted(tool)]),
  );
  expect(proven.context_history).toEqual(
    expect.arrayContaining(["window", "offset", "type", "role"]),
  );
  expect(proven.context_notes).toEqual(expect.arrayContaining(["name", "content", "offset"]));
  expect(proven.context_rollover).toEqual([]);
});
