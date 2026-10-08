import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vitest";
import { createPiWebToolsExtension } from "../src/index.js";

test("web_search and web_fetch treat null for an optional parameter like omitting it", async () => {
  const { pi, tools } = recordToolRegistrations();
  await createPiWebToolsExtension()(pi);

  expect(tools.map(({ name }) => name)).toEqual(["web_search", "web_fetch"]);
  expect(expectNullOptionalArgumentsOmitted(tools[0]!)).toEqual(
    expect.arrayContaining(["numResults", "contextMaxCharacters"]),
  );
  expect(expectNullOptionalArgumentsOmitted(tools[1]!)).toEqual(
    expect.arrayContaining(["format", "timeout", "offset", "limit"]),
  );
});
