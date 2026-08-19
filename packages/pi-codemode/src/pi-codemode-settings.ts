import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Minimatch } from "minimatch";
import { Type } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_MAX_SESSIONS = 8;
const EXPOSURE_MODES = ["codemode-only", "direct-and-codemode", "direct-only"] as const;
const JsonObjectSchema = Type.Record(Type.String(), Type.Any());
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const PositiveSafeIntegerSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const SettingsDocumentSchema = Type.Object(
  { codemode: Type.Optional(Type.Any()) },
  { additionalProperties: true },
);

type ExposureMode = (typeof EXPOSURE_MODES)[number];
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;
type SettingsScope = "global" | "project";
type ParsedRuleResult =
  | { readonly ok: true; readonly rule: CodeModeExposureRule }
  | { readonly ok: false; readonly warning: string };
type ParsedLayerResult =
  | {
      readonly ok: true;
      readonly maxSessions: number | undefined;
      readonly rules: readonly CodeModeExposureRule[] | undefined;
    }
  | { readonly ok: false; readonly warning: string };

/** One configured rule that classifies exact registered Pi tool names. */
export interface CodeModeExposureRule {
  readonly exposure: ExposureMode;
  readonly pattern: string;
  /** Reports whether this rule matches one case-sensitive registered tool name. */
  matches(toolName: string): boolean;
}

/** Pi's settings shape extended with the CodeMode-owned configuration key. */
export type CodeModeSettingsDocumentInput = PiSettingsDocument | { readonly codemode?: JsonValue };

/** Reads Pi's already trust-filtered global and project settings documents. */
export interface CodeModeSettingsReader {
  getGlobalSettings(): CodeModeSettingsDocumentInput;
  getProjectSettings(): CodeModeSettingsDocumentInput;
}

/** Resolved CodeMode settings, or the single boundary warning that disabled CodeMode. */
export type ResolvedCodeModeSettings =
  | {
      readonly enabled: true;
      readonly maxSessions: number;
      readonly rules: readonly CodeModeExposureRule[];
    }
  | { readonly enabled: false; readonly warning: string };

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return Value.Check(JsonObjectSchema, value);
}

function isExposureMode(value: JsonValue | undefined): value is ExposureMode {
  return EXPOSURE_MODES.some((exposure) => exposure === value);
}

function parseRule(value: JsonValue, path: string): ParsedRuleResult {
  if (!isJsonObject(value)) return { ok: false, warning: `${path}: expected an object` };
  const unknownField = Object.keys(value).find(
    (field) => field !== "pattern" && field !== "exposure",
  );
  if (unknownField !== undefined) {
    return { ok: false, warning: `${path}.${unknownField}: unknown field` };
  }
  if (!Value.Check(NonEmptyStringSchema, value.pattern)) {
    return { ok: false, warning: `${path}.pattern: expected a non-empty string` };
  }
  if (!isExposureMode(value.exposure)) {
    return {
      ok: false,
      warning: `${path}.exposure: expected codemode-only, direct-and-codemode, or direct-only`,
    };
  }

  let matcher: Minimatch;
  try {
    matcher = new Minimatch(value.pattern);
    if (matcher.makeRe() === false) {
      return { ok: false, warning: `${path}.pattern: invalid minimatch pattern` };
    }
  } catch {
    return { ok: false, warning: `${path}.pattern: invalid minimatch pattern` };
  }
  return {
    ok: true,
    rule: {
      exposure: value.exposure,
      pattern: value.pattern,
      matches: (toolName) => matcher.match(toolName),
    },
  };
}

function parseLayer(
  settings: CodeModeSettingsDocumentInput,
  scope: SettingsScope,
): ParsedLayerResult {
  if (!Value.Check(SettingsDocumentSchema, settings)) {
    return { ok: false, warning: `${scope} settings: expected an object` };
  }
  const codemode = "codemode" in settings ? settings.codemode : undefined;
  if (codemode === undefined) {
    return { ok: true, maxSessions: undefined, rules: undefined };
  }
  if (!isJsonObject(codemode)) {
    return { ok: false, warning: `${scope} codemode: expected an object` };
  }
  const unknownField = Object.keys(codemode).find(
    (field) => field !== "maxSessions" && field !== "tools",
  );
  if (unknownField !== undefined) {
    return { ok: false, warning: `${scope} codemode.${unknownField}: unknown field` };
  }

  let maxSessions: number | undefined;
  if (Object.hasOwn(codemode, "maxSessions")) {
    if (!Value.Check(PositiveSafeIntegerSchema, codemode.maxSessions)) {
      return {
        ok: false,
        warning: `${scope} codemode.maxSessions: expected a positive safe integer`,
      };
    }
    maxSessions = codemode.maxSessions;
  }

  let rules: readonly CodeModeExposureRule[] | undefined;
  if (Object.hasOwn(codemode, "tools")) {
    if (!Array.isArray(codemode.tools)) {
      return { ok: false, warning: `${scope} codemode.tools: expected an array` };
    }
    const parsedRules: CodeModeExposureRule[] = [];
    for (const [index, value] of codemode.tools.entries()) {
      const parsed = parseRule(value, `${scope} codemode.tools[${index}]`);
      if (!parsed.ok) return parsed;
      parsedRules.push(parsed.rule);
    }
    rules = parsedRules;
  }

  return { ok: true, maxSessions, rules };
}

/** Resolves independently trusted settings layers into CodeMode session and exposure policy. */
export function resolveCodeModeSettings(reader: CodeModeSettingsReader): ResolvedCodeModeSettings {
  const globalLayer = parseLayer(reader.getGlobalSettings(), "global");
  if (!globalLayer.ok) return { enabled: false, warning: globalLayer.warning };
  const projectLayer = parseLayer(reader.getProjectSettings(), "project");
  if (!projectLayer.ok) return { enabled: false, warning: projectLayer.warning };
  return {
    enabled: true,
    maxSessions: projectLayer.maxSessions ?? globalLayer.maxSessions ?? DEFAULT_MAX_SESSIONS,
    rules: projectLayer.rules ?? globalLayer.rules ?? [],
  };
}
