import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

const expectedExtensionPaths = [
  "./packages/pi-adaptive-thinking/src/index.ts",
  "./packages/pi-byterover/src/index.ts",
  "./packages/pi-minimal-subagents/src/index.ts",
  "./packages/pi-bible-verses/src/index.ts",
  "./packages/pi-tps-tracker/src/index.ts",
  "./packages/pi-git-status-widget/src/index.ts",
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("root Pi extension entrypoints", () => {
  test("loads the authoritative ordered source entrypoints through Pi", async () => {
    const packageManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    expect(packageManifest.pi?.extensions).toEqual(expectedExtensionPaths);

    const cwd = await mkdtemp(resolve(tmpdir(), "pi-extensions-load-cwd-"));
    const agentDir = await mkdtemp(resolve(tmpdir(), "pi-extensions-load-agent-"));
    temporaryDirectories.push(cwd, agentDir);
    const expectedResolvedPaths = expectedExtensionPaths.map((entrypoint) =>
      resolve(repositoryRoot, entrypoint),
    );

    const result = await discoverAndLoadExtensions(expectedResolvedPaths, cwd, agentDir);

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(6);
    expect(result.extensions.map((extension) => extension.resolvedPath)).toEqual(
      expectedResolvedPaths,
    );
  });
});
