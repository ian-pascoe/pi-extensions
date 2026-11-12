import { expectNullOptionalArgumentsOmitted } from "@ian-pascoe/pi-utils/tool-testing";
import { expect, it } from "vite-plus/test";
import { fixture } from "./fixtures/advisor-runtime.js";

it("advisor_ask treats null for an optional parameter like omitting it", async () => {
  const { session } = await fixture();
  const ask = session.extensionRunner?.getToolDefinition("advisor_ask");
  if (!ask) throw new Error("Expected the advisor_ask tool");
  // Its only parameter is required, so there is nothing optional to reject null.
  expect(expectNullOptionalArgumentsOmitted(ask)).toEqual([]);
});
