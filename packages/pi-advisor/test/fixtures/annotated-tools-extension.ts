import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Observed tools that differ only in their `readOnlyHint` annotation. */
export default function annotatedTools(pi: ExtensionAPI): void {
  const tool = (name: string, annotations?: { readOnlyHint: boolean }) =>
    pi.registerTool({
      name,
      label: name,
      description: `Fixture tool ${name}.`,
      parameters: Type.Object({}),
      ...(annotations && { annotations }),
      execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
    });
  tool("lookup", { readOnlyHint: true });
  tool("mutate", { readOnlyHint: false });
  tool("unannotated");
}
