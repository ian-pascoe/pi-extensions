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

const ConfigInputSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    quiet: Type.Boolean(),
    toolName: Type.String({ minLength: 1 }),
    toolDescription: Type.String({ minLength: 1 }),
    statusToolName: Type.String({ minLength: 1 }),
    guidance: Type.Optional(Type.String({ minLength: 1 })),
    systemPrompt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const hasOwnProperty = (input: unknown, property: string) =>
  typeof input === "object" &&
  input !== null &&
  Object.prototype.hasOwnProperty.call(input, property);

/** Returns whether raw configuration uses the deprecated system prompt alias. */
export const usesDeprecatedSystemPrompt = (input: unknown) => hasOwnProperty(input, "systemPrompt");

/** Parses configuration and normalizes legacy system prompt guidance. */
export const parseConfig = (input: unknown): AdaptiveThinkingConfig => {
  const usesGuidance = hasOwnProperty(input, "guidance");
  const usesSystemPrompt = usesDeprecatedSystemPrompt(input);
  if (usesGuidance && usesSystemPrompt) {
    throw new Error(
      "Adaptive Thinking configuration cannot contain both guidance and systemPrompt",
    );
  }

  const rawInput = input as Record<string, unknown> | undefined;
  const merged = {
    ...configDefaults,
    ...rawInput,
    guidance: usesSystemPrompt ? rawInput?.systemPrompt : (rawInput?.guidance ?? defaultGuidance),
  };
  delete (merged as Record<string, unknown>).systemPrompt;

  const config = Parse(ConfigInputSchema, merged) as AdaptiveThinkingConfig;
  if (config.toolName === config.statusToolName) {
    throw new Error("Adaptive Thinking toolName and statusToolName must be different");
  }
  return config;
};
