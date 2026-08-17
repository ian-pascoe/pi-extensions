import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_RETENTION_DAYS = 7;
const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const GitCheckpointsLayerSchema = Type.Object(
  { retentionDays: Type.Optional(Type.Any()) },
  { additionalProperties: true },
);
const SettingsDocumentSchema = Type.Object(
  { gitCheckpoints: Type.Optional(Type.Any()) },
  { additionalProperties: true },
);

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;

/** Pi settings extended with the Git Checkpoints-owned configuration key. */
export type GitCheckpointsSettingsDocumentInput =
  | PiSettingsDocument
  | { readonly gitCheckpoints?: JsonValue };

/** Contains trusted Git Checkpoints settings and non-fatal configuration warnings. */
export interface ResolvedGitCheckpointsSettings {
  readonly retentionDays: number;
  readonly warnings: readonly string[];
}

interface ParsedGitCheckpointsLayer {
  readonly retentionDays?: number;
  readonly warnings: readonly string[];
}

function readGitCheckpointsLayer(
  settings: GitCheckpointsSettingsDocumentInput,
  scope: "global" | "project",
): ParsedGitCheckpointsLayer {
  if (!Value.Check(SettingsDocumentSchema, settings)) {
    return { warnings: [`${scope} settings: expected a JSON object`] };
  }
  const gitCheckpoints = "gitCheckpoints" in settings ? settings.gitCheckpoints : undefined;
  if (gitCheckpoints === undefined) return { warnings: [] };
  if (!Value.Check(GitCheckpointsLayerSchema, gitCheckpoints)) {
    return { warnings: [`${scope} gitCheckpoints: expected an object`] };
  }

  const warnings = Object.keys(gitCheckpoints)
    .filter((field) => field !== "retentionDays")
    .map((field) => `${scope} gitCheckpoints.${field}: unknown field`);
  if (gitCheckpoints.retentionDays === undefined) return { warnings };
  if (!Value.Check(PositiveSafeIntegerSchema, gitCheckpoints.retentionDays)) {
    return {
      warnings: [
        ...warnings,
        `${scope} gitCheckpoints.retentionDays: expected a positive safe integer`,
      ],
    };
  }
  return { retentionDays: gitCheckpoints.retentionDays, warnings };
}

/** Resolves global and trusted-project Git Checkpoints settings. */
export function resolveGitCheckpointsSettings(
  settingsManager: SettingsManager,
): ResolvedGitCheckpointsSettings {
  const globalLayer = readGitCheckpointsLayer(settingsManager.getGlobalSettings(), "global");
  const projectLayer = readGitCheckpointsLayer(settingsManager.getProjectSettings(), "project");
  return {
    retentionDays:
      projectLayer.retentionDays ?? globalLayer.retentionDays ?? DEFAULT_RETENTION_DAYS,
    warnings: [...globalLayer.warnings, ...projectLayer.warnings],
  };
}
