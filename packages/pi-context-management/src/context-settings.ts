import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** A `contextManagement` block that authors only current options. */
const CurrentContextSettings = Type.Object(
  { idleRollover: Type.Optional(Type.Unknown()), tailTokens: Type.Optional(Type.Unknown()) },
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

const TailTokens = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Any `contextManagement` object that authored `tailTokens`. */
const AuthoredTail = Type.Object({ tailTokens: Type.Unknown() });

/** Effective Tail budget and the scopes whose `tailTokens` value was invalid and skipped. */
export interface TailTokensRead {
  tailTokens: number;
  invalid: Array<"global" | "project">;
}

/** `contextManagement.tailTokens` from global then trusted project settings; invalid layers are skipped. */
export function readTailTokens(reader: SettingsReader): TailTokensRead {
  let tailTokens = DEFAULT_TAIL_TOKENS;
  const invalid: TailTokensRead["invalid"] = [];
  const layers: Array<["global" | "project", object]> = [["global", reader.getGlobalSettings()]];
  if (reader.isProjectTrusted()) layers.push(["project", reader.getProjectSettings()]);
  for (const [scope, document] of layers) {
    const block: unknown = Object.getOwnPropertyDescriptor(document, "contextManagement")?.value;
    if (!Value.Check(AuthoredTail, block) || block.tailTokens === undefined) continue;
    if (Value.Check(TailTokens, block.tailTokens)) tailTokens = block.tailTokens;
    else invalid.push(scope);
  }
  return { tailTokens, invalid };
}
