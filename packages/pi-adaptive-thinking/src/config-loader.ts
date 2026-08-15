import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseAdaptiveThinkingConfig,
  type AdaptiveThinkingConfig,
  type ParsedAdaptiveThinkingConfig,
} from "./config.js";

export type { AdaptiveThinkingConfig } from "./config.js";

export type LoadConfigOptions = {
  cwd: string;
  homeDir?: string;
};

export type LoadConfigResult =
  | {
      success: true;
      config: AdaptiveThinkingConfig;
      source?: string;
      usedDeprecatedSystemPrompt?: true;
    }
  | { success: false; source: string; error: Error };

const hasErrorCode = (cause: NodeJS.ErrnoException, code: string) =>
  Object.hasOwn(cause, "code") && cause.code === code;

const invalidConfig = (source: string, cause: Error): LoadConfigResult => ({
  success: false,
  source,
  error: new Error(`Invalid Adaptive Thinking configuration in ${source}: ${cause.message}`, {
    cause,
  }),
});

const readAdaptiveThinkingConfig = async (
  source: string,
): Promise<ParsedAdaptiveThinkingConfig> => {
  const raw = await readFile(source, "utf8");
  return parseAdaptiveThinkingConfig(JSON.parse(raw));
};

export const loadConfig = async ({
  cwd,
  homeDir = homedir(),
}: LoadConfigOptions): Promise<LoadConfigResult> => {
  const candidates = [
    join(cwd, ".pi", "adaptive-thinking.json"),
    join(homeDir, ".pi", "agent", "adaptive-thinking.json"),
  ];

  for (const source of candidates) {
    let parsedConfig: ParsedAdaptiveThinkingConfig;
    try {
      parsedConfig = await readAdaptiveThinkingConfig(source);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const fileSystemError: NodeJS.ErrnoException = error;
      if (hasErrorCode(fileSystemError, "ENOENT")) continue;
      return invalidConfig(source, error);
    }

    const result: Extract<LoadConfigResult, { success: true }> = {
      success: true,
      source,
      config: parsedConfig.config,
    };
    if (parsedConfig.usedDeprecatedSystemPrompt) {
      result.usedDeprecatedSystemPrompt = true;
    }
    return result;
  }

  return { success: true, config: parseAdaptiveThinkingConfig(undefined).config };
};
