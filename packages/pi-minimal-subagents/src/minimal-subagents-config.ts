import type { JsonValue } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_MAX_SUBAGENT_DEPTH, THINKING_LEVELS } from "./minimal-subagents-capabilities.js";

const MODEL_ROLE_NAME_MAX_LENGTH = 64;
const MODEL_ROLE_HINT_MAX_LENGTH = 500;

const JsonValueSchema = Type.Unsafe<JsonValue>({});
const SettingsDocumentSchema = Type.Object({
  minimalSubagents: Type.Optional(JsonValueSchema),
});
const MinimalSubagentsSettingsSchema = Type.Object({
  maxSubagentDepth: Type.Optional(JsonValueSchema),
  modelRoles: Type.Optional(JsonValueSchema),
});
const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const MaxSubagentDepthSettingSchema = Type.Union([PositiveSafeIntegerSchema, Type.Null()]);
const ShorthandModelRoleSchema = Type.String();
const ExpandedModelRoleSchema = Type.Object(
  {
    model: Type.String(),
    hint: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const ModelRoleEntriesSchema = Type.Record(Type.String(), JsonValueSchema);
const ModelRolesSettingSchema = Type.Union([ModelRoleEntriesSchema, Type.Null()]);

type ModelRoleThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Describes one user-authored advisory model role shown to subagent callers. */
export interface MinimalSubagentsModelRole {
  name: string;
  model: string;
  thinkingLevel?: ModelRoleThinkingLevel;
  hint?: string;
}

/** Contains the validated minimal subagents settings used by one extension session. */
export interface ResolvedMinimalSubagentsConfig {
  maxSubagentDepth: number;
  modelRoles: MinimalSubagentsModelRole[];
  warnings: string[];
}

interface MinimalSubagentsSettingsDocument {
  minimalSubagents?: JsonValue;
}

interface MinimalSubagentsConfigInput {
  globalSettings: MinimalSubagentsSettingsDocumentInput;
  projectSettings: MinimalSubagentsSettingsDocumentInput;
  eligibleModelIds: readonly string[];
}

type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;
type MinimalSubagentsSettingsDocumentInput = PiSettingsDocument | MinimalSubagentsSettingsDocument;

interface MinimalSubagentsSettingsReader {
  getGlobalSettings(): MinimalSubagentsSettingsDocumentInput;
  getProjectSettings(): MinimalSubagentsSettingsDocumentInput;
}

type SettingsScope = "global" | "project";

interface ScopedSettingValue {
  scope: SettingsScope;
  value: ModelRoleWireValue;
}

interface ParsedMinimalSubagentsSettings {
  maxSubagentDepth?: MaxSubagentDepthWireValue;
  modelRoles?: ModelRolesWireValue;
}

type MaxSubagentDepthWireValue =
  | { kind: "depth"; value: number }
  | { kind: "reset" }
  | { kind: "invalid" };

type ModelRoleWireValue =
  | { kind: "delete" }
  | { kind: "shorthand"; model: string }
  | { kind: "expanded"; fields: Static<typeof ExpandedModelRoleSchema> }
  | { kind: "malformed-expanded"; fields: Record<string, JsonValue> }
  | { kind: "invalid" };

type ModelRolesWireValue =
  | { kind: "reset" }
  | { kind: "entries"; entries: ReadonlyMap<string, ModelRoleWireValue> }
  | { kind: "invalid" };

function parseMaxSubagentDepthWireValue(value: JsonValue): MaxSubagentDepthWireValue {
  if (!Value.Check(MaxSubagentDepthSettingSchema, value)) return { kind: "invalid" };
  return value === null ? { kind: "reset" } : { kind: "depth", value };
}

function parseModelRoleWireValue(value: JsonValue): ModelRoleWireValue {
  if (value === null) return { kind: "delete" };
  if (Value.Check(ShorthandModelRoleSchema, value)) return { kind: "shorthand", model: value };
  if (Value.Check(JsonObjectSchema, value)) {
    return Value.Check(ExpandedModelRoleSchema, value)
      ? { kind: "expanded", fields: value }
      : { kind: "malformed-expanded", fields: value };
  }
  return { kind: "invalid" };
}

function isExpandedModelRoleWireValue(
  value: ModelRoleWireValue,
): value is Extract<ModelRoleWireValue, { kind: "expanded" | "malformed-expanded" }> {
  return value.kind === "expanded" || value.kind === "malformed-expanded";
}

function parseModelRolesWireValue(value: JsonValue): ModelRolesWireValue {
  if (!Value.Check(ModelRolesSettingSchema, value)) return { kind: "invalid" };
  if (value === null) return { kind: "reset" };
  return {
    kind: "entries",
    entries: new Map(
      Object.entries(value).map(([name, roleValue]) => [name, parseModelRoleWireValue(roleValue)]),
    ),
  };
}

function readMinimalSubagentsSettings(
  settings: MinimalSubagentsSettingsDocumentInput,
  scope: SettingsScope,
  warnings: string[],
): ParsedMinimalSubagentsSettings {
  if (!Value.Check(SettingsDocumentSchema, settings)) return {};
  const minimalSubagents = settings.minimalSubagents;
  if (minimalSubagents === undefined) return {};
  if (Value.Check(MinimalSubagentsSettingsSchema, minimalSubagents)) {
    const parsed: ParsedMinimalSubagentsSettings = {};
    if (minimalSubagents.maxSubagentDepth !== undefined) {
      parsed.maxSubagentDepth = parseMaxSubagentDepthWireValue(minimalSubagents.maxSubagentDepth);
    }
    if (minimalSubagents.modelRoles !== undefined) {
      parsed.modelRoles = parseModelRolesWireValue(minimalSubagents.modelRoles);
    }
    return parsed;
  }
  warnings.push(`${scope} minimalSubagents: expected an object`);
  return {};
}

function mergeModelRoleEntries(
  globalValue: ModelRolesWireValue | undefined,
  projectValue: ModelRolesWireValue | undefined,
  warnings: string[],
): Map<string, ScopedSettingValue> {
  const entries = new Map<string, ScopedSettingValue>();
  if (globalValue?.kind === "entries") {
    for (const [name, value] of globalValue.entries) {
      entries.set(name, { scope: "global", value });
    }
  } else if (globalValue?.kind === "invalid") {
    warnings.push("global minimalSubagents.modelRoles: expected an object or null");
  }
  if (projectValue?.kind === "reset") return new Map();
  if (projectValue === undefined) return entries;
  if (projectValue.kind === "invalid") {
    warnings.push("project minimalSubagents.modelRoles: expected an object or null");
    return entries;
  }
  if (projectValue.kind !== "entries") return entries;

  for (const [name, value] of projectValue.entries) {
    if (value.kind === "delete") {
      entries.delete(name);
      continue;
    }
    const inherited = entries.get(name)?.value;
    const mergedValue =
      inherited !== undefined &&
      isExpandedModelRoleWireValue(inherited) &&
      isExpandedModelRoleWireValue(value)
        ? parseModelRoleWireValue({ ...inherited.fields, ...value.fields })
        : value;
    entries.set(name, { scope: "project", value: mergedValue });
  }
  return entries;
}

interface ResolvedModelRoleReference {
  model: string;
  thinkingLevel?: ModelRoleThinkingLevel;
}

function resolveThinkingLevelSuffix(suffix: string): ModelRoleThinkingLevel | undefined {
  return THINKING_LEVELS.find((thinkingLevel) => thinkingLevel === suffix);
}

function resolveModelRoleReference(
  model: string,
  eligibleModels: ReadonlySet<string>,
  path: string,
  warnings: string[],
): ResolvedModelRoleReference | undefined {
  if (eligibleModels.has(model)) return { model };

  const separatorIndex = model.lastIndexOf(":");
  if (separatorIndex >= 0) {
    const prefix = model.slice(0, separatorIndex);
    const suffix = model.slice(separatorIndex + 1);
    if (eligibleModels.has(prefix)) {
      const thinkingLevel = resolveThinkingLevelSuffix(suffix);
      if (thinkingLevel !== undefined) return { model: prefix, thinkingLevel };
      warnings.push(`${path}: unknown thinking level suffix: ${suffix}`);
      return undefined;
    }
  }

  warnings.push(`${path}: model is not eligible: ${model}`);
  return undefined;
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
    const expandedRoleObject = isExpandedModelRoleWireValue(value) ? value.fields : undefined;
    if (expandedRoleObject !== undefined) {
      const invalidFields = Object.keys(expandedRoleObject).filter(
        (key) => key !== "model" && key !== "hint",
      );
      if (invalidFields.length > 0) {
        warnings.push(`${path}: unknown field: ${invalidFields.join(", ")}`);
        continue;
      }
    } else if (value.kind !== "shorthand") {
      warnings.push(`${path}: expected a model string or expanded role object`);
      continue;
    }

    const modelValue =
      expandedRoleObject === undefined && value.kind === "shorthand"
        ? value.model
        : expandedRoleObject?.model;
    if (
      !Value.Check(ShorthandModelRoleSchema, modelValue) ||
      modelValue.length === 0 ||
      modelValue !== modelValue.trim()
    ) {
      warnings.push(`${path}: model must be a non-empty trimmed string`);
      continue;
    }
    const resolvedModel = resolveModelRoleReference(modelValue, eligibleModels, path, warnings);
    if (resolvedModel === undefined) continue;

    const hintValue = expandedRoleObject?.hint;
    if (
      hintValue !== undefined &&
      (!Value.Check(ShorthandModelRoleSchema, hintValue) ||
        hintValue.length === 0 ||
        hintValue !== hintValue.trim() ||
        /[\r\n]/.test(hintValue) ||
        hintValue.length > MODEL_ROLE_HINT_MAX_LENGTH)
    ) {
      warnings.push(`${path}.hint: expected trimmed single-line text up to 500 characters`);
      continue;
    }
    const role: MinimalSubagentsModelRole = {
      name,
      model: resolvedModel.model,
    };
    if (resolvedModel.thinkingLevel !== undefined) {
      role.thinkingLevel = resolvedModel.thinkingLevel;
    }
    if (hintValue !== undefined && Value.Check(ShorthandModelRoleSchema, hintValue)) {
      role.hint = hintValue;
    }
    roles.push(role);
  }
  return roles;
}

function resolveMaxSubagentDepth(
  globalValue: MaxSubagentDepthWireValue | undefined,
  projectValue: MaxSubagentDepthWireValue | undefined,
  warnings: string[],
): number {
  let resolvedDepth = DEFAULT_MAX_SUBAGENT_DEPTH;
  if (globalValue?.kind === "depth") {
    resolvedDepth = globalValue.value;
  } else if (globalValue?.kind === "invalid") {
    warnings.push(
      "global minimalSubagents.maxSubagentDepth: expected a positive safe integer or null",
    );
  }
  if (projectValue === undefined) return resolvedDepth;
  if (projectValue.kind === "reset") return DEFAULT_MAX_SUBAGENT_DEPTH;
  if (projectValue.kind === "depth") return projectValue.value;
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
