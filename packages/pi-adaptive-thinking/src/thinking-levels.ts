import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export const fallbackThinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof fallbackThinkingLevels)[number];

const levelSet = new Set<string>(fallbackThinkingLevels);

export const isThinkingLevel = (level: string): level is PiThinkingLevel => levelSet.has(level);

export const resolveSupportedThinkingLevels = (
  model: Model<Api> | undefined,
): PiThinkingLevel[] => {
  if (!model) return [...fallbackThinkingLevels];

  return getSupportedThinkingLevels(model).filter(
    (level: ModelThinkingLevel): level is PiThinkingLevel => isThinkingLevel(level),
  );
};
