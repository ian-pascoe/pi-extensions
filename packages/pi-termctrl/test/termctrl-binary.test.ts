import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveTermctrlBinary } from "../src/termctrl-binary.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveTermctrlBinary", () => {
  test("honours TERMCTRL_BINARY when it names an executable", () => {
    vi.stubEnv("TERMCTRL_BINARY", "/bin/sh");
    expect(resolveTermctrlBinary()).toEqual({ kind: "available", path: "/bin/sh" });
  });

  test("reports one diagnostic when TERMCTRL_BINARY does not exist", () => {
    vi.stubEnv("TERMCTRL_BINARY", "/nonexistent/termctrl");
    expect(resolveTermctrlBinary()).toEqual({
      kind: "missing",
      reason: "termctrl binary /nonexistent/termctrl is not executable",
    });
  });

  test("reports the SDK's resolution failure when no platform binary is installed", () => {
    expect(
      resolveTermctrlBinary(() => {
        throw new Error(
          "no packaged termctrl binary is available for win32-x64; provide binaryPath",
        );
      }),
    ).toEqual({
      kind: "missing",
      reason: "no packaged termctrl binary is available for win32-x64; provide binaryPath",
    });
  });

  test("finds the packaged binary on this platform", () => {
    vi.stubEnv("TERMCTRL_BINARY", "");
    const resolution = resolveTermctrlBinary();
    if (
      !["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(
        `${process.platform}-${process.arch}`,
      )
    )
      return;
    expect(resolution.kind).toBe("available");
  });
});
