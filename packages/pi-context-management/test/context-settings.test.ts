import { readFileSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { hasLegacyContextSettings } from "../src/context-settings.js";

/** Global settings from the README's `contextManagement` example, which shows every current key at its default. */
function documentedSettings() {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const json = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    .find((block) => block.includes('"contextManagement"'));
  if (!json) throw new Error("README has no contextManagement settings example");
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      fn(scope === "global" ? json : "{}");
    },
  });
}

describe("documented contextManagement settings", () => {
  it("are all current keys, so the obsolete-settings allowlist cannot fall behind a reader", () => {
    expect(hasLegacyContextSettings(documentedSettings())).toBe(false);
  });
});
