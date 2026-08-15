import type { JsonValue } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Parse } from "typebox/value";

export const defaultGuidance =
  "You MUST manage thinking level actively. " +
  "Lower it before trivial or routine turns; raise it for ambiguity, debugging, risky changes, or multi-step synthesis. " +
  "Reassess at turn start, after meaningful new evidence, and when the task shifts. " +
  "NEVER leave the current level unchanged by inertia, and NEVER reply to a trivial turn before considering a downshift.";

export type AdaptiveThinkingConfig = {
  enabled: boolean;
  quiet: boolean;
  toolName: string;
  toolDescription: string;
  statusToolName: string;
  guidance: string;
};

export const configDefaults: AdaptiveThinkingConfig = {
  enabled: true,
  quiet: false,
  toolName: "set_thinking_level",
  toolDescription: "Set your thinking level",
  statusToolName: "get_thinking_level",
  guidance: defaultGuidance,
};

const ConfigValueSchema = Type.Object({
  enabled: Type.Boolean(),
  quiet: Type.Boolean(),
  toolName: Type.String({ minLength: 1 }),
  toolDescription: Type.String({ minLength: 1 }),
  statusToolName: Type.String({ minLength: 1 }),
  guidance: Type.String({ minLength: 1 }),
});

const ConfigOverridesSchema = Type.Partial(
  Type.Intersect([
    ConfigValueSchema,
    Type.Object({ systemPrompt: Type.Optional(Type.String({ minLength: 1 })) }),
  ]),
  { additionalProperties: false },
);

/** Parsed configuration and metadata retained from the configuration ingress boundary. */
export type ParsedAdaptiveThinkingConfig = {
  config: AdaptiveThinkingConfig;
  usedDeprecatedSystemPrompt: boolean;
};

/** Parses optional configuration values and normalizes the deprecated system prompt alias. */
export const parseAdaptiveThinkingConfig = (
  input: JsonValue | undefined,
): ParsedAdaptiveThinkingConfig => {
  const overrides = input === undefined ? {} : Parse(ConfigOverridesSchema, input);
  const usesGuidance = overrides.guidance !== undefined;
  const usesSystemPrompt = overrides.systemPrompt !== undefined;
  if (usesGuidance && usesSystemPrompt) {
    throw new Error(
      "Adaptive Thinking configuration cannot contain both guidance and systemPrompt",
    );
  }

  const guidance = overrides.guidance ?? overrides.systemPrompt ?? configDefaults.guidance;
  const config: AdaptiveThinkingConfig = {
    enabled: overrides.enabled ?? configDefaults.enabled,
    quiet: overrides.quiet ?? configDefaults.quiet,
    toolName: overrides.toolName ?? configDefaults.toolName,
    toolDescription: overrides.toolDescription ?? configDefaults.toolDescription,
    statusToolName: overrides.statusToolName ?? configDefaults.statusToolName,
    guidance,
  };
  if (config.toolName === config.statusToolName) {
    throw new Error("Adaptive Thinking toolName and statusToolName must be different");
  }

  return { config, usedDeprecatedSystemPrompt: usesSystemPrompt };
};

/** Parses configuration at the public configuration seam. */
export const parseConfig = (input: JsonValue | undefined): AdaptiveThinkingConfig =>
  parseAdaptiveThinkingConfig(input).config;
