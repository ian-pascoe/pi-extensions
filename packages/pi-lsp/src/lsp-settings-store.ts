import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lockSync } from "proper-lockfile";
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
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  let release: (() => void) | undefined;
  for (let attempt = 0; release === undefined; attempt++) {
    try {
      release = lockSync(settingsPath, { realpath: false });
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "ELOCKED" ||
        attempt >= 9
      )
        throw cause;
      await delay(20);
    }
  }
  // Pi retries this lock synchronously, so never yield while holding it.
  try {
    const file = lstatSync(settingsPath, { throwIfNoEntry: false });
    // Follow an existing settings symlink instead of replacing the link itself.
    const path = file?.isSymbolicLink() ? realpathSync(settingsPath) : settingsPath;
    const current = file === undefined ? undefined : readFileSync(path, "utf8");
    const bom = current?.startsWith("\uFEFF") === true ? "\uFEFF" : "";
    const parsed: unknown = current === undefined ? {} : JSON.parse(current.slice(bom.length));
    if (!Value.Check(SettingsDocumentSchema, parsed)) {
      throw new Error(`Pi LSP: invalid settings document or lsp.enablement in ${settingsPath}`);
    }
    if (parsed.lsp?.enablement?.[input.serverId] === input.enabled) return;
    parsed.lsp = {
      ...parsed.lsp,
      enablement: { ...parsed.lsp?.enablement, [input.serverId]: input.enabled },
    };
    const mode = file === undefined ? 0o600 : statSync(path).mode & 0o777;
    const temporaryPath = resolve(dirname(path), `.pi-lsp-${randomUUID()}.tmp`);
    try {
      const handle = openSync(temporaryPath, "wx", mode);
      try {
        writeFileSync(handle, `${bom}${JSON.stringify(parsed, undefined, 2)}\n`, "utf8");
        fchmodSync(handle, mode);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporaryPath, path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  } finally {
    release();
  }
}
