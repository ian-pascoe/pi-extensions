import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

/** Adds the nested-tool surface `ExtensionToolContext` requires; tests never call nested tools. */
export function toToolContext(context: ExtensionContext): ExtensionToolContext {
  return Object.assign(context, {
    tools: [],
    executeTool: () => Promise.reject(new Error("executeTool is unavailable in this test")),
  });
}
