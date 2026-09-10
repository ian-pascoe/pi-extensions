import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Obsolete settings are ignored, including invalid values; never writes user configuration. */
export function hasLegacyContextSettings(reader: AgentSession["settingsManager"]): boolean {
  const layers = [reader.getGlobalSettings()];
  if (reader.isProjectTrusted()) layers.push(reader.getProjectSettings());
  return layers.some(
    (layer) => "contextManagement" in layer && layer.contextManagement !== undefined,
  );
}
