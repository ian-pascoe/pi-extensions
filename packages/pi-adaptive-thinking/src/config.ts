import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";

export const defaultSystemPrompt =
  "You MUST manage thinking level actively. " +
  "Lower it before trivial or routine turns; raise it for ambiguity, debugging, risky changes, or multi-step synthesis. " +
  "Reassess at turn start, after meaningful new evidence, and when the task shifts. " +
  "NEVER leave the current level unchanged by inertia, and NEVER reply to a trivial turn before considering a downshift.";

export const configDefaults = {
  enabled: true,
  quiet: false,
  toolName: "set_thinking_level",
  toolDescription: "Set your thinking level",
  systemPrompt: defaultSystemPrompt,
};

export const ConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    quiet: Type.Boolean(),
    toolName: Type.String({ minLength: 1 }),
    toolDescription: Type.String({ minLength: 1 }),
    systemPrompt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type AdaptiveThinkingConfig = Static<typeof ConfigSchema>;

export const parseConfig = (input: unknown): AdaptiveThinkingConfig => {
  const merged = input === undefined ? configDefaults : { ...configDefaults, ...input };
  return Parse(ConfigSchema, merged);
};
