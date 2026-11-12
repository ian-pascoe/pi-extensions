import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

/** A Pi API that records the name of every method the extension calls. */
function recordingPi() {
  const calls: string[] = [];
  // SAFETY: every property read returns a recorder, so any ExtensionAPI method the extension calls exists.
  const pi = new Proxy({} as ExtensionAPI, {
    get:
      (_target, name) =>
      (..._args: unknown[]) =>
        void calls.push(String(name)),
  });
  return { pi, calls };
}

describe("PI_DISABLED_EXTENSIONS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["unset", undefined, true],
    ["names another package", "pi-other", true],
    ["names this package", "pi-other, pi-tps-tracker", false],
    ["names this scoped package", "@ian-pascoe/pi-tps-tracker", false],
  ])("loads the extension when the variable %s", (_label, value, loads) => {
    if (value !== undefined) vi.stubEnv("PI_DISABLED_EXTENSIONS", value);
    const { pi, calls } = recordingPi();
    extension(pi);
    expect(calls.length > 0).toBe(loads);
  });
});
