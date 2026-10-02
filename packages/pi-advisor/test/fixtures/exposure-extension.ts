import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Registers one tool per exposure, so tests can grant each to an Advisor Session. */
export default function exposureFixture(pi: ExtensionAPI): void {
  for (const exposure of ["direct", "codemode", "deferred", "model-only"] as const) {
    pi.registerTool({
      name: `${exposure.replace("-", "_")}_tool`,
      label: exposure,
      description: `${exposure} exposure fixture`,
      exposure,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: exposure }], details: {} };
      },
    });
  }
}
