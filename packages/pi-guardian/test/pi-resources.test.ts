import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadedResourcePaths, type LoadedResources } from "../src/guardian-pi-resources.js";

/** A resource loader that loaded these extension entry files and nothing else. */
function loaderWithExtensions(paths: readonly string[]): LoadedResources {
  return {
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSkills: () => ({ skills: [] }),
    getPrompts: () => ({ prompts: [] }),
    getExtensions: () => ({ extensions: paths.map((resolvedPath) => ({ resolvedPath })) }),
    getAppendSystemPromptSources: () => [],
    getSystemPromptSource: () => undefined,
  };
}

describe("loaded resources", () => {
  it("treats extensions inside the workspace as project code and others as loaded resources", () => {
    const workspace = "/repo";
    const inside = join(workspace, "packages", "pi-guardian", "src", "index.ts");
    const outside = "/home/user/.npm/pi-extension/index.js";
    expect(loadedResourcePaths(loaderWithExtensions([inside, outside]), workspace)).toEqual([
      outside,
    ]);
  });
});
