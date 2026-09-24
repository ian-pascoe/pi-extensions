import type { JsonValue } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { updateFileLocked } from "@ian-pascoe/pi-utils/locked-file-update";
import { resolve } from "node:path";

/** Identifies the standard Pi settings file changed by a Subagent Access command. */
export type MinimalSubagentsSettingsScope = "global" | "project";

/** Supplies only the Root Agent context needed to select and authorize a settings file. */
export interface MinimalSubagentsSettingsWriteContext {
  readonly cwd: string;
  isProjectTrusted(): boolean;
}

type SettingsJsonObject = Record<string, JsonValue>;

function isSettingsJsonObject(value: JsonValue | undefined): value is SettingsJsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON.parse already established JSON data; distinguish object roots and settings blocks from primitives and arrays.
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSettings(content: string | undefined, path: string): SettingsJsonObject {
  if (content === undefined) return {};
  // JSON.parse is the provenance for this JSON type; the object shape is checked below.
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch (cause) {
    throw new Error(`Minimal subagents settings JSON is malformed at ${path}`, { cause });
  }
  if (!isSettingsJsonObject(parsed)) {
    throw new Error(`Minimal subagents settings at ${path} must have an object root`);
  }
  if (parsed.minimalSubagents !== undefined && !isSettingsJsonObject(parsed.minimalSubagents)) {
    throw new Error(`Minimal subagents settings at ${path} must have an object minimalSubagents`);
  }
  return parsed;
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

  await updateFileLocked(path, (content) => {
    const settings = parseSettings(content, path);
    const current = settings.minimalSubagents;
    const minimalSubagents = isSettingsJsonObject(current) ? { ...current } : {};
    if (enabled === undefined) delete minimalSubagents.enabled;
    else minimalSubagents.enabled = enabled;
    if (Object.keys(minimalSubagents).length === 0) delete settings.minimalSubagents;
    else settings.minimalSubagents = minimalSubagents;
    return `${JSON.stringify(settings, undefined, 2)}\n`;
  });
  return path;
}
