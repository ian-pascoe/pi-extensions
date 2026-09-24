import { updateFileLocked } from "@ian-pascoe/pi-utils/locked-file-update";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const SettingsDocumentSchema = Type.Object({
  lsp: Type.Optional(
    Type.Object({
      enablement: Type.Optional(
        Type.Record(Type.String({ pattern: "^[\\s\\S]+$" }), Type.Boolean(), {
          additionalProperties: false,
        }),
      ),
    }),
  ),
});

/** Selects one durable Server Enablement Override without modifying its Server Definition. */
export interface WriteLspEnablementInput {
  readonly agentDirectory: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly scope: "global" | "project";
  readonly serverId: string;
  readonly enabled: boolean;
}

/** Preserve unrelated JSON and atomically update eligibility under Pi's native settings lock. */
export async function writeLspEnablement(input: WriteLspEnablementInput): Promise<void> {
  if (input.scope === "project" && !input.projectTrusted) {
    throw new Error("Pi LSP: cannot modify settings in an untrusted project");
  }
  if (input.serverId.length === 0) throw new Error("Pi LSP: server ID must not be empty");
  const settingsPath =
    input.scope === "global"
      ? resolve(input.agentDirectory, "settings.json")
      : resolve(input.cwd, ".pi/settings.json");
  await updateFileLocked(settingsPath, (current) => {
    const bom = current?.startsWith("\uFEFF") === true ? "\uFEFF" : "";
    const parsed: unknown = current === undefined ? {} : JSON.parse(current.slice(bom.length));
    if (!Value.Check(SettingsDocumentSchema, parsed)) {
      throw new Error(`Pi LSP: invalid settings document or lsp.enablement in ${settingsPath}`);
    }
    if (parsed.lsp?.enablement?.[input.serverId] === input.enabled) return undefined;
    parsed.lsp = {
      ...parsed.lsp,
      enablement: { ...parsed.lsp?.enablement, [input.serverId]: input.enabled },
    };
    return `${bom}${JSON.stringify(parsed, undefined, 2)}\n`;
  });
}
