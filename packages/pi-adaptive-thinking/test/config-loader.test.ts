import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { configDefaults } from "../src/config.js";
import { loadConfig } from "../src/config-loader.js";

const makeDirs = async (root: string) => {
  const cwd = join(root, "project");
  const homeDir = join(root, "home");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
  return { cwd, homeDir };
};

describe("loadConfig", () => {
  test("returns defaults when no config files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-adaptive-thinking-"));
    const { cwd, homeDir } = await makeDirs(root);

    await expect(loadConfig({ cwd, homeDir })).resolves.toEqual({
      success: true,
      config: configDefaults,
    });
  });

  test("loads global config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-adaptive-thinking-"));
    const { cwd, homeDir } = await makeDirs(root);
    const globalPath = join(homeDir, ".pi", "agent", "adaptive-thinking.json");
    await writeFile(globalPath, JSON.stringify({ toolName: "global_tool" }));

    await expect(loadConfig({ cwd, homeDir })).resolves.toEqual({
      success: true,
      source: globalPath,
      config: { ...configDefaults, toolName: "global_tool" },
    });
  });

  test("project config takes precedence over global config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-adaptive-thinking-"));
    const { cwd, homeDir } = await makeDirs(root);
    await writeFile(
      join(homeDir, ".pi", "agent", "adaptive-thinking.json"),
      JSON.stringify({ toolName: "global_tool" }),
    );
    const projectPath = join(cwd, ".pi", "adaptive-thinking.json");
    await writeFile(projectPath, JSON.stringify({ toolName: "project_tool" }));

    await expect(loadConfig({ cwd, homeDir })).resolves.toEqual({
      success: true,
      source: projectPath,
      config: { ...configDefaults, toolName: "project_tool" },
    });
  });

  test("returns structured error for invalid config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-adaptive-thinking-"));
    const { cwd, homeDir } = await makeDirs(root);
    const projectPath = join(cwd, ".pi", "adaptive-thinking.json");
    await writeFile(projectPath, JSON.stringify({ enabled: "yes" }));

    const result = await loadConfig({ cwd, homeDir });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.source).toBe(projectPath);
      expect(result.error.message).toContain("Invalid Adaptive Thinking configuration");
    }
  });
});
