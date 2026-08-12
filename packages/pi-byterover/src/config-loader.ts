import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as z from "zod/v4";
import { ConfigSchema } from "./config.js";

export type ByteroverConfig = z.infer<typeof ConfigSchema>;

export type LoadConfigOptions = {
  cwd: string;
  homeDir?: string;
};

export type LoadConfigResult =
  | { success: true; config: ByteroverConfig; source?: string }
  | { success: false; source: string; error: Error };

const hasCode = (error: unknown, code: string) => {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
};

const errorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error);
};

const invalidConfig = (source: string, error: unknown): LoadConfigResult => ({
  success: false,
  source,
  error: new Error(`Invalid Byterover configuration in ${source}: ${errorMessage(error)}`),
});

export const loadConfig = async ({
  cwd,
  homeDir = homedir(),
}: LoadConfigOptions): Promise<LoadConfigResult> => {
  const candidates = [
    join(cwd, ".pi", "byterover.json"),
    join(homeDir, ".pi", "agent", "byterover.json"),
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
      return { success: true, source, config: ConfigSchema.parse(JSON.parse(raw)) };
    } catch (error) {
      return invalidConfig(source, error);
    }
  }

  return { success: true, config: ConfigSchema.parse(undefined) };
};
