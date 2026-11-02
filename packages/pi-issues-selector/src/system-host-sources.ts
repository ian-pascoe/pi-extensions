import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { HostSources } from "./issue-repository.js";

/** The real environment and file system, for the host CLIs' configuration. */
export function systemHostSources(): HostSources {
  return {
    environment: { env: process.env, platform: process.platform, homedir: homedir() },
    readText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
