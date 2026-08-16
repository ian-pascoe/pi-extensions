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

const invalidConfig = (source: string, error: Error): LoadConfigResult => ({
  success: false,
  source,
  error: new Error(`Invalid Byterover configuration in ${source}: ${error.message}`),
});

/** Loads the highest-precedence ByteRover JSON configuration through its Zod boundary. */
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
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      return invalidConfig(source, cause instanceof Error ? cause : new Error(String(cause)));
    }

    try {
      return { success: true, source, config: ConfigSchema.parse(JSON.parse(raw)) };
    } catch (cause) {
      return invalidConfig(source, cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  return { success: true, config: ConfigSchema.parse(undefined) };
};
