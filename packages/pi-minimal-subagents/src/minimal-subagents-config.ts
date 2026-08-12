import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  stripThinkingSuffix,
} from "./minimal-subagents-capabilities.js";

const MODEL_ROLE_NAME_MAX_LENGTH = 64;
const MODEL_ROLE_HINT_MAX_LENGTH = 500;

/** Describes one user-authored advisory model role shown to subagent callers. */
export interface MinimalSubagentsModelRole {
  name: string;
  model: string;
  hint?: string;
}

/** Contains the validated minimal subagents settings used by one extension session. */
export interface ResolvedMinimalSubagentsConfig {
  maxSubagentDepth: number;
  modelRoles: MinimalSubagentsModelRole[];
  warnings: string[];
}

interface MinimalSubagentsConfigInput {
  globalSettings: unknown;
  projectSettings: unknown;
  eligibleModelIds: readonly string[];
}

interface MinimalSubagentsSettingsReader {
  getGlobalSettings(): unknown;
  getProjectSettings(): unknown;
}

type SettingsScope = "global" | "project";

interface ScopedSettingValue {
  scope: SettingsScope;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMinimalSubagentsSettings(
  settings: unknown,
  scope: SettingsScope,
  warnings: string[],
): Record<string, unknown> {
  if (!isRecord(settings) || settings.minimalSubagents === undefined) return {};
  if (isRecord(settings.minimalSubagents)) return settings.minimalSubagents;
  warnings.push(`${scope} minimalSubagents: expected an object`);
  return {};
}

function mergeModelRoleEntries(
  globalValue: unknown,
  projectValue: unknown,
  warnings: string[],
): Map<string, ScopedSettingValue> {
  const entries = new Map<string, ScopedSettingValue>();
  if (globalValue !== undefined) {
    if (isRecord(globalValue)) {
      for (const [name, value] of Object.entries(globalValue)) {
        entries.set(name, { scope: "global", value });
      }
    } else if (globalValue !== null) {
      warnings.push("global minimalSubagents.modelRoles: expected an object or null");
    }
  }
  if (projectValue === null) return new Map();
  if (projectValue === undefined) return entries;
  if (!isRecord(projectValue)) {
    warnings.push("project minimalSubagents.modelRoles: expected an object or null");
    return entries;
  }

  for (const [name, value] of Object.entries(projectValue)) {
    if (value === null) {
      entries.delete(name);
      continue;
    }
    const inherited = entries.get(name)?.value;
    entries.set(name, {
      scope: "project",
      value: isRecord(inherited) && isRecord(value) ? { ...inherited, ...value } : value,
    });
  }
  return entries;
}

function parseModelRoles(
  entries: ReadonlyMap<string, ScopedSettingValue>,
  eligibleModelIds: readonly string[],
  warnings: string[],
): MinimalSubagentsModelRole[] {
  const eligibleModels = new Set(eligibleModelIds);
  const roles: MinimalSubagentsModelRole[] = [];
  for (const [name, entry] of entries) {
    const path = `${entry.scope} minimalSubagents.modelRoles.${name}`;
    if (
      name.length === 0 ||
      name !== name.trim() ||
      /[\r\n]/.test(name) ||
      name.length > MODEL_ROLE_NAME_MAX_LENGTH
    ) {
      warnings.push(`${path}: role name must be trimmed single-line text up to 64 characters`);
      continue;
    }

    const value = entry.value;
    if (isRecord(value)) {
      const unknownFields = Object.keys(value).filter((key) => key !== "model" && key !== "hint");
      if (unknownFields.length > 0) {
        warnings.push(`${path}: unknown field: ${unknownFields.join(", ")}`);
        continue;
      }
    } else if (typeof value !== "string") {
      warnings.push(`${path}: expected a model string or expanded role object`);
      continue;
    }

    const model = typeof value === "string" ? value : value.model;
    if (typeof model !== "string" || model.length === 0 || model !== model.trim()) {
      warnings.push(`${path}: model must be a non-empty trimmed string`);
      continue;
    }
    if (stripThinkingSuffix(model) !== model) {
      warnings.push(
        `${path}: thinking level suffixes are not allowed; choose thinking_level per spawn`,
      );
      continue;
    }
    if (!eligibleModels.has(model)) {
      warnings.push(`${path}: model is not eligible: ${model}`);
      continue;
    }

    const hint = isRecord(value) ? value.hint : undefined;
    if (
      hint !== undefined &&
      (typeof hint !== "string" ||
        hint.length === 0 ||
        hint !== hint.trim() ||
        /[\r\n]/.test(hint) ||
        hint.length > MODEL_ROLE_HINT_MAX_LENGTH)
    ) {
      warnings.push(`${path}.hint: expected trimmed single-line text up to 500 characters`);
      continue;
    }
    roles.push({ name, model, ...(hint === undefined ? {} : { hint }) });
  }
  return roles;
}

function resolveMaxSubagentDepth(
  globalValue: unknown,
  projectValue: unknown,
  warnings: string[],
): number {
  let resolvedDepth = DEFAULT_MAX_SUBAGENT_DEPTH;
  if (globalValue !== undefined && globalValue !== null) {
    if (Number.isSafeInteger(globalValue) && Number(globalValue) > 0) {
      resolvedDepth = Number(globalValue);
    } else {
      warnings.push(
        "global minimalSubagents.maxSubagentDepth: expected a positive safe integer or null",
      );
    }
  }
  if (projectValue === undefined) return resolvedDepth;
  if (projectValue === null) return DEFAULT_MAX_SUBAGENT_DEPTH;
  if (Number.isSafeInteger(projectValue) && Number(projectValue) > 0) {
    return Number(projectValue);
  }
  warnings.push(
    "project minimalSubagents.maxSubagentDepth: expected a positive safe integer or null",
  );
  return resolvedDepth;
}

/** Resolve trusted global and project settings into validated subagent guidance and limits. */
export function resolveMinimalSubagentsConfig(
  input: MinimalSubagentsConfigInput,
): ResolvedMinimalSubagentsConfig {
  const warnings: string[] = [];
  const globalConfig = readMinimalSubagentsSettings(input.globalSettings, "global", warnings);
  const projectConfig = readMinimalSubagentsSettings(input.projectSettings, "project", warnings);
  const maxSubagentDepth = resolveMaxSubagentDepth(
    globalConfig.maxSubagentDepth,
    projectConfig.maxSubagentDepth,
    warnings,
  );
  const modelRoleEntries = mergeModelRoleEntries(
    globalConfig.modelRoles,
    projectConfig.modelRoles,
    warnings,
  );

  return {
    maxSubagentDepth,
    modelRoles: parseModelRoles(modelRoleEntries, input.eligibleModelIds, warnings),
    warnings,
  };
}

/** Resolve model roles and depth from Pi's trust-aware global and project settings layers. */
export function resolveMinimalSubagentsSettings(
  settings: MinimalSubagentsSettingsReader,
  eligibleModelIds: readonly string[],
): ResolvedMinimalSubagentsConfig {
  return resolveMinimalSubagentsConfig({
    globalSettings: settings.getGlobalSettings(),
    projectSettings: settings.getProjectSettings(),
    eligibleModelIds,
  });
}
