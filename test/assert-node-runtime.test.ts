/**
 * Node-runtime guard: Bun installs and starts scripts, but Vitest and the repository scripts must
 * run under Node. The guard takes the version table as a parameter so Bun can be simulated here.
 */
import { describe, expect, it } from "vitest";
import { assertNodeRuntime } from "../scripts/assert-node-runtime.mjs";

describe("assertNodeRuntime", () => {
  it("accepts the runtime that runs this suite", () => {
    expect(process.versions.bun).toBeUndefined();
    expect(() => assertNodeRuntime()).not.toThrow();
  });

  it("accepts a version table without Bun", () => {
    expect(() => assertNodeRuntime({})).not.toThrow();
  });

  it("rejects Bun and says how to run under Node", () => {
    expect(() => assertNodeRuntime({ bun: "1.4.4" })).toThrow(
      /running under Bun 1\.4\.4.*mise install.*without `--bun`/su,
    );
  });
});
