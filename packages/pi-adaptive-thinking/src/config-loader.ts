import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfig, type AdaptiveThinkingConfig } from "./config.js";

export type { AdaptiveThinkingConfig } from "./config.js";

export type LoadConfigOptions = {
  cwd: string;
  homeDir?: string;
};

export type LoadConfigResult =
  | { success: true; config: AdaptiveThinkingConfig; source?: string }
  | { success: false; source: string; error: Error };

const hasCode = (error: unknown, code: string) => {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const invalidConfig = (source: string, error: unknown): LoadConfigResult => ({
  success: false,
  source,
  error: new Error(`Invalid Adaptive Thinking configuration in ${source}: ${errorMessage(error)}`),
});

export const loadConfig = async ({
  cwd,
  homeDir = homedir(),
}: LoadConfigOptions): Promise<LoadConfigResult> => {
  const candidates = [
    join(cwd, ".pi", "adaptive-thinking.json"),
    join(homeDir, ".pi", "agent", "adaptive-thinking.json"),
  ];

  for (const source of candidates) {
    let raw: string;
    try {
      raw = await readFile(source, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      return invalidConfig(source, error);
    }

    try {
      return { success: true, source, config: parseConfig(JSON.parse(raw)) };
    } catch (error) {
      return invalidConfig(source, error);
    }
  }

  return { success: true, config: parseConfig(undefined) };
};
