import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** A `contextManagement` block that authors only current options. */
const CurrentContextSettings = Type.Object(
  {
    idleRollover: Type.Optional(Type.Unknown()),
    maxContextTokens: Type.Optional(Type.Unknown()),
    tailTokens: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

type SettingsReader = Pick<
  AgentSession["settingsManager"],
  "getGlobalSettings" | "getProjectSettings" | "isProjectTrusted"
>;

/** Obsolete settings are ignored, including invalid values; never writes user configuration. */
export function hasLegacyContextSettings(reader: SettingsReader): boolean {
  const layers = [reader.getGlobalSettings()];
  if (reader.isProjectTrusted()) layers.push(reader.getProjectSettings());
  return layers.some(
    (layer) =>
      "contextManagement" in layer &&
      layer.contextManagement !== undefined &&
      !Value.Check(CurrentContextSettings, layer.contextManagement),
  );
}

/** Normal Rollover keeps no Tail by default: the Handoff, Notes, and History carry continuity. */
export const DEFAULT_TAIL_TOKENS = 0;

/** Models declaring a larger context window are treated as having this one. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 400_000;

export type SettingsScope = "global" | "project";
export type ContextSettingKey = "tailTokens" | "maxContextTokens" | "idleRollover";
const SettingsBlock = Type.Record(Type.String(), Type.Unknown());

interface TokenSettingRead {
  value: number;
  invalid: SettingsScope[];
}

/** One integer `contextManagement` key from global then trusted project settings; invalid layers are skipped. */
function readTokenSetting(
  reader: SettingsReader,
  key: Exclude<ContextSettingKey, "idleRollover">,
  minimum: number,
  fallback: number,
): TokenSettingRead {
  const Tokens = Type.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });
  let value = fallback;
  const invalid: SettingsScope[] = [];
  const layers: Array<[SettingsScope, object]> = [["global", reader.getGlobalSettings()]];
  if (reader.isProjectTrusted()) layers.push(["project", reader.getProjectSettings()]);
  for (const [scope, document] of layers) {
    const block: unknown = Object.getOwnPropertyDescriptor(document, "contextManagement")?.value;
    if (!Value.Check(SettingsBlock, block)) continue;
    const authored = block[key];
    if (authored === undefined) continue;
    if (Value.Check(Tokens, authored)) value = authored;
    else invalid.push(scope);
  }
  return { value, invalid };
}

/** Effective Tail budget and the scopes whose `tailTokens` value was invalid and skipped. */
export interface TailTokensRead {
  tailTokens: number;
  invalid: SettingsScope[];
}

/** `contextManagement.tailTokens` from global then trusted project settings; invalid layers are skipped. */
export function readTailTokens(reader: SettingsReader): TailTokensRead {
  const { value, invalid } = readTokenSetting(reader, "tailTokens", 0, DEFAULT_TAIL_TOKENS);
  return { tailTokens: value, invalid };
}

/** Effective Context Limit ceiling and the scopes whose `maxContextTokens` value was invalid and skipped. */
export interface MaxContextTokensRead {
  maxContextTokens: number;
  invalid: SettingsScope[];
}

/** `contextManagement.maxContextTokens` from global then trusted project settings; invalid layers are skipped. */
export function readMaxContextTokens(reader: SettingsReader): MaxContextTokensRead {
  const { value, invalid } = readTokenSetting(
    reader,
    "maxContextTokens",
    1,
    DEFAULT_MAX_CONTEXT_TOKENS,
  );
  return { maxContextTokens: value, invalid };
}
