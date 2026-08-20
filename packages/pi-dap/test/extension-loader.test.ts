import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

test("loads the source entrypoint without starting a Debug Adapter", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-dap-cwd-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-agent-"));
  try {
    const entrypoint = resolve(import.meta.dirname, "../src/index.ts");
    const result = await discoverAndLoadExtensions([entrypoint], cwd, agentDirectory);
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
  } finally {
    await Promise.all([
      rm(cwd, { force: true, recursive: true }),
      rm(agentDirectory, { force: true, recursive: true }),
    ]);
  }
});
