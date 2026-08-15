import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { configDefaults } from "../src/config.js";
import { loadConfig } from "../src/config-loader.js";

const withTempDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-byterover-config-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const withTempProjectAndHome = async (run: (cwd: string, homeDir: string) => Promise<void>) => {
  await withTempDirectory(async (root) => {
    const cwd = join(root, "project");
    const homeDir = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await run(cwd, homeDir);
  });
};

const writeJson = async (path: string, value: JsonValue) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
};

describe("loadConfig", () => {
  test("returns defaults when no config files exist", async () => {
    await withTempProjectAndHome(async (cwd, homeDir) => {
      const result = await loadConfig({ cwd, homeDir });

      expect(result).toEqual({ success: true, config: configDefaults });
    });
  });

  test("loads global config when project config is absent", async () => {
    await withTempProjectAndHome(async (cwd, homeDir) => {
      const globalConfigPath = join(homeDir, ".pi", "agent", "byterover.json");
      await writeJson(globalConfigPath, { brvPath: "/usr/local/bin/brv", quiet: true });

      const result = await loadConfig({ cwd, homeDir });

      expect(result).toMatchObject({
        success: true,
        source: globalConfigPath,
        config: { brvPath: "/usr/local/bin/brv", quiet: true },
      });
    });
  });

  test("loads project config instead of global config when both exist", async () => {
    await withTempProjectAndHome(async (cwd, homeDir) => {
      const projectConfigPath = join(cwd, ".pi", "byterover.json");
      const globalConfigPath = join(homeDir, ".pi", "agent", "byterover.json");
      await writeJson(globalConfigPath, { brvPath: "/global/brv", quiet: true });
      await writeJson(projectConfigPath, { brvPath: "/project/brv", quiet: false });

      const result = await loadConfig({ cwd, homeDir });

      expect(result).toMatchObject({
        success: true,
        source: projectConfigPath,
        config: { brvPath: "/project/brv", quiet: false },
      });
    });
  });

  test("returns an error for invalid config", async () => {
    await withTempProjectAndHome(async (cwd, homeDir) => {
      const projectConfigPath = join(cwd, ".pi", "byterover.json");
      await writeJson(projectConfigPath, { brvPath: "" });

      const result = await loadConfig({ cwd, homeDir });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.source).toBe(projectConfigPath);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("Invalid Byterover configuration");
      expect(result.error.message).toContain(projectConfigPath);
    });
  });
});
