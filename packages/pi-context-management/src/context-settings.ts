import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** A `contextManagement` block that authors only current options. */
const CurrentContextSettings = Type.Object(
  { idleRollover: Type.Optional(Type.Unknown()) },
  { additionalProperties: false },
);

/** Obsolete settings are ignored, including invalid values; never writes user configuration. */
export function hasLegacyContextSettings(reader: AgentSession["settingsManager"]): boolean {
  const layers = [reader.getGlobalSettings()];
  if (reader.isProjectTrusted()) layers.push(reader.getProjectSettings());
  return layers.some(
    (layer) =>
      "contextManagement" in layer &&
      layer.contextManagement !== undefined &&
      !Value.Check(CurrentContextSettings, layer.contextManagement),
  );
}
