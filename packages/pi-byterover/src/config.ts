import * as z from "zod/v4";

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

export const maxCuratedTurnCacheSize = 500;

const positiveInteger = () => z.number().int().positive();
const nonEmptyString = () => z.string().trim().min(1);

export const ConfigSchema = z
  .object({
    enabled: z.boolean().default(configDefaults.enabled),
    // BrvBridge options
    brvPath: nonEmptyString().optional().default(configDefaults.brvPath),
    searchTimeoutMs: positiveInteger().default(configDefaults.searchTimeoutMs),
    recallTimeoutMs: positiveInteger().default(configDefaults.recallTimeoutMs),
    persistTimeoutMs: positiveInteger().default(configDefaults.persistTimeoutMs),
    // Plugin options
    quiet: z.boolean().default(configDefaults.quiet),
    autoRecall: z.boolean().default(configDefaults.autoRecall),
    autoPersist: z.boolean().default(configDefaults.autoPersist),
    manualTools: z.boolean().default(configDefaults.manualTools),
    contextTagName: nonEmptyString()
      .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u)
      .default(configDefaults.contextTagName),
    recallPrompt: nonEmptyString().default(configDefaults.recallPrompt),
    persistPrompt: nonEmptyString().default(configDefaults.persistPrompt),
    maxRecallTurns: positiveInteger().default(configDefaults.maxRecallTurns),
    maxRecallChars: positiveInteger().default(configDefaults.maxRecallChars),
  })
  .optional()
  .default(configDefaults);
