import { describe, expect, test } from "vitest";

function findAddedResources(before: readonly string[], after: readonly string[]): string[] {
  const remaining = [...before];
  return after.filter((resource) => {
    const index = remaining.indexOf(resource);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

describe("Pi MCP package shell", () => {
  test("loads the source entrypoint without starting runtime work", async () => {
    const beforeHandles = process.getActiveResourcesInfo();
    const extensionModule = await import("../src/index.js");
    expect(extensionModule.default).toBeTypeOf("function");
    expect(findAddedResources(beforeHandles, process.getActiveResourcesInfo())).toEqual([]);
  }, 20_000);
});
