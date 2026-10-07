import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { rewriteNamespaceDocument } from "@ian-pascoe/pi-utils/layered-settings";
import { updateFileLocked } from "@ian-pascoe/pi-utils/locked-file-update";
import { resolve } from "node:path";

/** Identifies the standard Pi settings file changed by a Subagent Access command. */
export type MinimalSubagentsSettingsScope = "global" | "project";

/** Supplies only the Root Agent context needed to select and authorize a settings file. */
export interface MinimalSubagentsSettingsWriteContext {
  readonly cwd: string;
  isProjectTrusted(): boolean;
}

/**
 * Set or remove `minimalSubagents.enabled` in global or trusted-project Pi settings,
 * preserving every unrelated setting. Writes re-read the file under Pi's settings lock.
 * @returns The changed settings path.
 */
export async function writeMinimalSubagentsEnabled(
  context: MinimalSubagentsSettingsWriteContext,
  agentDirectory: string,
  scope: MinimalSubagentsSettingsScope,
  enabled: boolean | undefined,
): Promise<string> {
  const path =
    scope === "global"
      ? resolve(agentDirectory, "settings.json")
      : resolve(context.cwd, CONFIG_DIR_NAME, "settings.json");
  if (scope === "project" && !context.isProjectTrusted()) {
    throw new Error(
      `Minimal subagents project settings write refused because the project is not trusted: ${path}`,
    );
  }

  await updateFileLocked(path, (current) =>
    rewriteNamespaceDocument({
      current,
      namespace: "minimalSubagents",
      invalid: (reason, cause) => {
        if (reason === "malformed")
          return new Error(`Minimal subagents settings JSON is malformed at ${path}`, { cause });
        return new Error(
          reason === "root"
            ? `Minimal subagents settings at ${path} must have an object root`
            : `Minimal subagents settings at ${path} must have an object minimalSubagents`,
        );
      },
      update: (stored) => {
        const minimalSubagents = { ...stored };
        if (enabled === undefined) delete minimalSubagents.enabled;
        else minimalSubagents.enabled = enabled;
        return minimalSubagents;
      },
    }),
  );
  return path;
}
