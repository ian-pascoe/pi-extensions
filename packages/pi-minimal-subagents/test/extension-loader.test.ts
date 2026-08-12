import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("minimal subagents Pi loader compatibility", () => {
  it("loads the default source factory through Pi without real settings or model credentials", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "minimal-subagents-load-cwd-"));
    const agentDir = await mkdtemp(resolve(tmpdir(), "minimal-subagents-load-agent-"));
    temporaryDirectories.push(cwd, agentDir);
    const entrypoint = resolve(packageDirectory, "src/index.ts");

    const result = await discoverAndLoadExtensions([entrypoint], cwd, agentDir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.resolvedPath).toBe(entrypoint);
  });
});
