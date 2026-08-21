import { Decode, type StaticDecode, Type } from "typebox";
import { Value } from "typebox/value";

export const brvGitignoreBeginMarker = "# BEGIN pi-byterover";
export const brvGitignoreEndMarker = "# END pi-byterover";

export const brvGitignoreRules = `# Dream state and logs
dream-log/
dream-state.json
dream.lock

# Review backups
review-backups/

# Generated files
config.json
_queue_status.json
.snapshot.json
_manifest.json
_index.md
*.abstract.md
*.overview.md
`;

export const brvGitignore = `${brvGitignoreBeginMarker}\n${brvGitignoreRules}${brvGitignoreEndMarker}\n`;

export const configDefaults = {
  enabled: true,
  brvPath: "brv",
  searchTimeoutMs: 30_000,
  recallTimeoutMs: 30_000,
  persistTimeoutMs: 60_000,
  quiet: false,
  autoRecall: true,
  autoPersist: true,
  manualTools: true,
  contextTagName: "byterover-context",
  recallPrompt:
    `Recall any relevant context that would help answer the latest user message.\n` +
    `Use the recent conversation only to resolve references and intent.\n` +
    `Do not restate the query in your findings.`,
  persistPrompt:
    `The following is a conversation between a user and an AI assistant.\n` +
    `Curate only information with lasting value: facts, decisions, technical details, preferences, or notable outcomes.\n` +
    `Skip trivial messages such as greetings, acknowledgments ("ok", "thanks", "sure", "got it"), one-word replies, anything with no substantive content.`,
  maxRecallTurns: 3,
  maxRecallChars: 4096,
};

/** Raw, partially-specified Byterover configuration document. */
export type ByteroverConfigDocument = StaticDecode<typeof ConfigSchema>;

/** Fully defaulted Byterover configuration. */
export type ByteroverConfig = ByteroverConfigDocument & typeof configDefaults;

/** Parses one Byterover configuration document, rejecting invalid values, then applies defaults. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function IS the untrusted-document parser boundary.
export const parseConfigDocument = (value: unknown): ByteroverConfig => ({
  ...configDefaults,
  ...Value.Decode(ConfigSchema, value === undefined ? {} : value),
});

const trimmedNonEmptyString = () =>
  Decode(Type.String({ minLength: 1, pattern: "\\S" }), (value) => value.trim());

export const ConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    // BrvBridge options
    brvPath: Type.Optional(trimmedNonEmptyString()),
    searchTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    recallTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    persistTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    // Plugin options
    quiet: Type.Optional(Type.Boolean()),
    autoRecall: Type.Optional(Type.Boolean()),
    autoPersist: Type.Optional(Type.Boolean()),
    manualTools: Type.Optional(Type.Boolean()),
    contextTagName: Type.Optional(
      Decode(Type.String({ minLength: 1, pattern: "^\\s*[A-Za-z][A-Za-z0-9._-]*\\s*$" }), (value) =>
        value.trim(),
      ),
    ),
    recallPrompt: Type.Optional(trimmedNonEmptyString()),
    persistPrompt: Type.Optional(trimmedNonEmptyString()),
    maxRecallTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    maxRecallChars: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
