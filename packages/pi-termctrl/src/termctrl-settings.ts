import type { SettingsManager } from "@earendil-works/pi-coding-agent";
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

/** The effective `settings.termctrl` values after layering global and trusted project settings. */
export interface ResolvedTermctrlSettings {
  readonly replaceBash: boolean;
  readonly defaultViewport: TerminalViewport;
  readonly exitTailLines: number;
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

interface TermctrlLayer {
  replaceBash?: boolean;
  cols?: number;
  rows?: number;
  exitTailLines?: number;
}

export const DEFAULT_TERMCTRL_SETTINGS: Omit<ResolvedTermctrlSettings, "warnings"> = {
  replaceBash: true,
  defaultViewport: { cols: 120, rows: 40 },
  exitTailLines: 20,
};

const JsonObjectSchema = Type.Record(Type.String(), Type.Any());
const SettingsDocumentSchema = Type.Object({ termctrl: Type.Optional(Type.Any()) });
const BooleanSchema = Type.Boolean();
const ViewportDimensionSchema = Type.Integer({ minimum: 1, maximum: VIEWPORT_LIMIT });
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
    warnings,
  };
}
