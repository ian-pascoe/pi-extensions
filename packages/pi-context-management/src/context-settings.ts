import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const Settings = Type.Object(
  {
    tailTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    warningThreshold: Type.Optional(Type.Number({ minimum: 0.1, maximum: 0.95 })),
    emergencyThreshold: Type.Optional(Type.Number({ minimum: 0.2, maximum: 0.99 })),
    outputReserveTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
    safetyMarginTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 100_000 })),
  },
  { additionalProperties: false },
);

export interface ContextSettings {
  tailTokens: number;
  warningThreshold: number;
  emergencyThreshold: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
}

/** Only the global and trusted-project layers participate; never writes user settings. */
export function resolveContextSettings(reader: AgentSession["settingsManager"]): ContextSettings {
  let settings = {
    tailTokens: 16_000,
    warningThreshold: 0.8,
    emergencyThreshold: 0.9,
    outputReserveTokens: 0,
    safetyMarginTokens: 2048,
  };
  const layers = [reader.getGlobalSettings()];
  if (reader.isProjectTrusted()) layers.push(reader.getProjectSettings());
  for (const layer of layers) {
    if (!("contextManagement" in layer) || layer.contextManagement === undefined) continue;
    if (!Value.Check(Settings, layer.contextManagement))
      throw new Error(
        "Invalid contextManagement settings: " +
          [...Value.Errors(Settings, layer.contextManagement)]
            .map((error) => error.instancePath + " " + error.message)
            .join("; "),
      );
    settings = { ...settings, ...layer.contextManagement };
  }
  if (settings.warningThreshold >= settings.emergencyThreshold)
    throw new Error("contextManagement.warningThreshold must be below emergencyThreshold");
  return settings;
}
