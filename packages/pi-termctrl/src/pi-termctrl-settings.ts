import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type SettingsManager,
  type TruncationOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const VIEWPORT_LIMIT = 1_000;
const EXIT_TAIL_LIMIT = 1_000;

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type SettingsScope = "global" | "project";

/** A Terminal's size in character cells. */
export interface TerminalViewport {
  readonly cols: number;
  readonly rows: number;
}

/** The most lines and bytes of model-visible output that a setting allows. */
export type LineByteLimits = Readonly<Required<TruncationOptions>>;

/** The effective `settings.termctrl` values after layering global and trusted project settings. */
export interface ResolvedTermctrlSettings {
  readonly replaceBash: boolean;
  readonly defaultViewport: TerminalViewport;
  readonly exitTailLines: number;
  /**
   * Limits on the model-visible `bash` output: a foreground result or the output so far of a
   * backgrounding one. Undefined restores Pi's own limits.
   */
  readonly bashTail: LineByteLimits | undefined;
  /**
   * Limits on the scrolled-off lines a Terminal result shows, kept from their start and end.
   * Undefined restores Pi's own limits on the whole result.
   */
  readonly scrollback: LineByteLimits | undefined;
  readonly warnings: readonly string[];
}

/** Pi's core settings type or a test document carrying the extension-owned `termctrl` value. */
export type TermctrlSettingsDocumentInput =
  | ReturnType<SettingsManager["getGlobalSettings"]>
  | { readonly termctrl?: JsonValue };

/** Reads Pi's already trust-filtered global and project settings documents. */
export interface TermctrlSettingsReader {
  getGlobalSettings(): TermctrlSettingsDocumentInput;
  getProjectSettings(): TermctrlSettingsDocumentInput;
}

/** The settings that limit model-visible output. */
type LineByteLimitKey = "bashTail" | "scrollback";

/** One layer's value for a `bashTail` or `scrollback` setting. */
interface LineByteLimitsLayer {
  enabled?: boolean;
  lines?: number;
  bytes?: number;
}

interface TermctrlLayer {
  replaceBash?: boolean;
  cols?: number;
  rows?: number;
  exitTailLines?: number;
  bashTail?: LineByteLimitsLayer;
  scrollback?: LineByteLimitsLayer;
}

export const DEFAULT_TERMCTRL_SETTINGS: Omit<
  ResolvedTermctrlSettings,
  "warnings" | LineByteLimitKey
> & { readonly [key in LineByteLimitKey]: LineByteLimits } = {
  replaceBash: true,
  defaultViewport: { cols: 120, rows: 40 },
  exitTailLines: 20,
  bashTail: { maxLines: 300, maxBytes: 16 * 1024 },
  scrollback: { maxLines: 100, maxBytes: 16 * 1024 },
};

const JsonObjectSchema = Type.Record(Type.String(), Type.Any());
const SettingsDocumentSchema = Type.Object({ termctrl: Type.Optional(Type.Any()) });
const BooleanSchema = Type.Boolean();
const ViewportDimensionSchema = Type.Integer({ minimum: 1, maximum: VIEWPORT_LIMIT });
const LimitLinesSchema = Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES });
const LimitBytesSchema = Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_BYTES });
const ExitTailLinesSchema = Type.Integer({ minimum: 0, maximum: EXIT_TAIL_LIMIT });

function isJsonObject(value: JsonValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function readLayer(
  document: TermctrlSettingsDocumentInput,
  scope: SettingsScope,
  warnings: string[],
): TermctrlLayer {
  const layer: TermctrlLayer = {};
  if (!Value.Check(SettingsDocumentSchema, document)) {
    warnings.push(`${scope} settings: expected a JSON object`);
    return layer;
  }
  const section: JsonValue | undefined = document.termctrl;
  if (section === undefined) return layer;
  if (!isJsonObject(section)) {
    warnings.push(`${scope} termctrl: expected a JSON object`);
    return layer;
  }
  for (const [key, value] of Object.entries(section)) {
    const path = `${scope} termctrl.${key}`;
    switch (key) {
      case "replaceBash":
        if (Value.Check(BooleanSchema, value)) layer.replaceBash = value;
        else warnings.push(`${path}: expected a boolean`);
        break;
      case "exitTailLines":
        if (Value.Check(ExitTailLinesSchema, value)) layer.exitTailLines = value;
        else warnings.push(`${path}: expected an integer from 0 to ${EXIT_TAIL_LIMIT}`);
        break;
      case "bashTail":
      case "scrollback":
        layer[key] = readLineByteLimits(value, path, warnings);
        break;
      case "defaultViewport":
        readViewport(value, path, layer, warnings);
        break;
      default:
        warnings.push(`${path}: unknown field`);
    }
  }
  return layer;
}

function readViewport(value: JsonValue, path: string, layer: TermctrlLayer, warnings: string[]) {
  if (!isJsonObject(value)) {
    warnings.push(`${path}: expected a JSON object`);
    return;
  }
  for (const [key, dimension] of Object.entries(value)) {
    if (key !== "cols" && key !== "rows") {
      warnings.push(`${path}.${key}: unknown field`);
      continue;
    }
    if (Value.Check(ViewportDimensionSchema, dimension)) layer[key] = dimension;
    else warnings.push(`${path}.${key}: expected an integer from 1 to ${VIEWPORT_LIMIT}`);
  }
}

function readLineByteLimits(
  value: JsonValue,
  path: string,
  warnings: string[],
): LineByteLimitsLayer {
  if (Value.Check(BooleanSchema, value)) return { enabled: value };
  if (value === 0) return { enabled: false };
  if (!isJsonObject(value)) {
    warnings.push(`${path}: expected a boolean, 0, or a JSON object`);
    return {};
  }
  const limits: LineByteLimitsLayer = {};
  let valid = 0;
  for (const [key, limit] of Object.entries(value)) {
    if (key === "lines") {
      if (Value.Check(LimitLinesSchema, limit)) {
        limits.lines = limit;
        valid++;
      } else warnings.push(`${path}.lines: expected an integer from 1 to ${DEFAULT_MAX_LINES}`);
    } else if (key === "bytes") {
      if (Value.Check(LimitBytesSchema, limit)) {
        limits.bytes = limit;
        valid++;
      } else warnings.push(`${path}.bytes: expected an integer from 1 to ${DEFAULT_MAX_BYTES}`);
    } else {
      warnings.push(`${path}.${key}: unknown field`);
    }
  }
  // An object with only invalid fields must not override a lower layer's opt-out.
  if (valid > 0 || Object.keys(value).length === 0) limits.enabled = true;
  return limits;
}

/** Layer a `bashTail` or `scrollback` setting: the project's fields over the global ones, over the defaults. */
function resolveLineByteLimits(
  key: LineByteLimitKey,
  globalLayer: TermctrlLayer,
  projectLayer: TermctrlLayer,
): LineByteLimits | undefined {
  const global = globalLayer[key];
  const project = projectLayer[key];
  if (!(project?.enabled ?? global?.enabled ?? true)) return undefined;
  const defaults = DEFAULT_TERMCTRL_SETTINGS[key];
  return {
    maxLines: project?.lines ?? global?.lines ?? defaults.maxLines,
    maxBytes: project?.bytes ?? global?.bytes ?? defaults.maxBytes,
  };
}

/** Resolve global and trusted-project `termctrl` settings, keeping valid fields around warnings. */
export function resolveTermctrlSettings(reader: TermctrlSettingsReader): ResolvedTermctrlSettings {
  const warnings: string[] = [];
  const globalLayer = readLayer(reader.getGlobalSettings(), "global", warnings);
  const projectLayer = readLayer(reader.getProjectSettings(), "project", warnings);
  const defaults = DEFAULT_TERMCTRL_SETTINGS;
  return {
    replaceBash: projectLayer.replaceBash ?? globalLayer.replaceBash ?? defaults.replaceBash,
    defaultViewport: {
      cols: projectLayer.cols ?? globalLayer.cols ?? defaults.defaultViewport.cols,
      rows: projectLayer.rows ?? globalLayer.rows ?? defaults.defaultViewport.rows,
    },
    exitTailLines:
      projectLayer.exitTailLines ?? globalLayer.exitTailLines ?? defaults.exitTailLines,
    bashTail: resolveLineByteLimits("bashTail", globalLayer, projectLayer),
    scrollback: resolveLineByteLimits("scrollback", globalLayer, projectLayer),
    warnings,
  };
}
