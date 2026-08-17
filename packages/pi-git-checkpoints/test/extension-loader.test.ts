import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

test("loads Git Checkpoints without invoking Git during extension load", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-git-checkpoints-cwd-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-git-checkpoints-agent-"));
  try {
    const entrypoint = resolve(import.meta.dirname, "../src/index.ts");
    const result = await discoverAndLoadExtensions([entrypoint], cwd, agentDirectory);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.resolvedPath).toBe(entrypoint);
  } finally {
    await Promise.all([
      rm(cwd, { force: true, recursive: true }),
      rm(agentDirectory, { force: true, recursive: true }),
    ]);
  }
});
