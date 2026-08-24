// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This file owns the JSON.parse boundary; recursive primitive checks establish the JSON document contract before mutation.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_RETRY_DELAY_MS = 20;
const LOCK_RETRIES = 99;
const LOCK_STALE_MS = 10_000;
const DEFAULT_NEW_FILE_MODE = 0o600;

/** A JSON value accepted by the MCP settings and authentication stores. */
export type McpStoreJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpStoreJsonValue[]
  | McpStoreJsonObject;

/** A JSON object accepted by the MCP settings and authentication stores. */
export interface McpStoreJsonObject {
  readonly [key: string]: McpStoreJsonValue;
}

/** Identifies the Pi settings layer changed by a persistent MCP command. */
export type McpSettingsScope = "global" | "project";

/** Expected persistence failure returned without exposing document contents. */
export class McpStoreError extends Error {
  readonly _tag = "McpStoreError" as const;

  constructor(
    readonly code:
      | "invalid_document"
      | "invalid_mutation"
      | "io_failure"
      | "lock_timeout"
      | "project_untrusted",
    readonly operation: string,
    readonly path: string,
    override readonly cause?: unknown,
  ) {
    super(`MCP store ${operation} failed (${code})`);
  }
}

/** Explicit result returned by MCP persistence operations. */
export type McpStoreResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: McpStoreError };

/** One trust-filtered Pi settings document with its provenance. */
export interface McpSettingsLayerDocument {
  readonly document: McpStoreJsonObject;
  readonly path: string;
  readonly scope: McpSettingsScope;
}

/** Global and optional trusted-project settings documents. */
export interface McpSettingsLayers {
  readonly global: McpSettingsLayerDocument;
  readonly project?: McpSettingsLayerDocument;
}

/** Observable outcome of one Server Definition mutation. */
export interface McpSettingsMutationResult {
  readonly changed: boolean;
  readonly path: string;
  readonly scope: McpSettingsScope;
}

/** Inputs that determine Pi's global/project settings paths and trust gate. */
export interface McpSettingsStoreOptions {
  readonly agentDirectory: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

interface AtomicJsonMutationOptions {
  readonly fallbackMode?: number;
  readonly forceMode?: number;
}

function ok<Value>(value: Value): McpStoreResult<Value> {
  return { ok: true, value };
}

function err<Value>(error: McpStoreError): McpStoreResult<Value> {
  return { error, ok: false };
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function checkMcpStoreJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      return false;
    }
  }

  ancestors.add(value);
  try {
    return (Array.isArray(value) ? value : Object.values(value)).every((item) =>
      checkMcpStoreJsonValue(item, ancestors),
    );
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isMcpStoreJsonValue(value: unknown): value is McpStoreJsonValue {
  return checkMcpStoreJsonValue(value, new Set());
}

function isMcpStoreJsonObject(value: unknown): value is McpStoreJsonObject {
  return isMcpStoreJsonValue(value) && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function acquireMcpStoreLock(lockPath: string): Promise<McpStoreResult<string>> {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    const owner = randomUUID();
    let created = false;
    try {
      const handle = await open(lockPath, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(owner, "utf8");
      } catch (cause) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw cause;
      } finally {
        await handle.close();
      }
      return ok(owner);
    } catch (cause) {
      if (!isNodeErrorCode(cause, "EEXIST")) {
        if (created) await rm(lockPath, { force: true }).catch(() => undefined);
        return err(new McpStoreError("io_failure", "acquire lock", lockPath, cause));
      }
      try {
        const lock = await stat(lockPath);
        if (lock.mtimeMs < Date.now() - LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statCause) {
        if (isNodeErrorCode(statCause, "ENOENT")) continue;
        return err(new McpStoreError("io_failure", "inspect lock", lockPath, statCause));
      }
      if (attempt === LOCK_RETRIES) {
        return err(new McpStoreError("lock_timeout", "acquire lock", lockPath, cause));
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  return err(new McpStoreError("lock_timeout", "acquire lock", lockPath));
}

async function releaseMcpStoreLock(lockPath: string, owner: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) === owner) await rm(lockPath);
  } catch {
    return;
  }
}

async function readJsonObject(
  path: string,
  operation: string,
): Promise<McpStoreResult<McpStoreJsonObject | undefined>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return ok(undefined);
    return err(new McpStoreError("io_failure", operation, path, cause));
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isMcpStoreJsonObject(parsed)) {
      return err(new McpStoreError("invalid_document", operation, path));
    }
    return ok(parsed);
  } catch {
    return err(new McpStoreError("invalid_document", operation, path));
  }
}

async function writeAtomicJsonObject(
  path: string,
  document: McpStoreJsonObject,
  options: AtomicJsonMutationOptions,
): Promise<McpStoreResult<void>> {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.pi-mcp.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let mode = options.forceMode;
    if (mode === undefined) {
      try {
        mode = (await stat(path)).mode & 0o777;
      } catch (cause) {
        if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
        mode = options.fallbackMode ?? DEFAULT_NEW_FILE_MODE;
      }
    }
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(`${JSON.stringify(document, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
    return ok(undefined);
  } catch (cause) {
    return err(new McpStoreError("io_failure", "write atomic document", path, cause));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Lock, parse, mutate, and atomically replace one JSON document.
 * Returning undefined from `mutate` leaves the original bytes untouched.
 */
export async function mutateLockedMcpJsonDocument(
  path: string,
  mutate: (current: McpStoreJsonObject | undefined) => McpStoreJsonObject | undefined,
  options: AtomicJsonMutationOptions = {},
): Promise<McpStoreResult<{ readonly changed: boolean }>> {
  try {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
  } catch (cause) {
    return err(new McpStoreError("io_failure", "create parent directory", path, cause));
  }

  const lockPath = `${path}.pi-mcp.lock`;
  const acquired = await acquireMcpStoreLock(lockPath);
  if (!acquired.ok) return acquired;

  try {
    const current = await readJsonObject(path, "read document for mutation");
    if (!current.ok) return current;
    let next: McpStoreJsonObject | undefined;
    try {
      next = mutate(current.value);
    } catch {
      return err(new McpStoreError("invalid_mutation", "apply document mutation", path));
    }
    if (next === undefined) return ok({ changed: false });
    if (!isMcpStoreJsonObject(next)) {
      return err(new McpStoreError("invalid_mutation", "apply document mutation", path));
    }
    const written = await writeAtomicJsonObject(path, next, options);
    return written.ok ? ok({ changed: true }) : written;
  } finally {
    await releaseMcpStoreLock(lockPath, acquired.value);
  }
}

/** Replace a malformed or valid JSON document under the same atomic lock. */
export async function forceReplaceLockedMcpJsonDocument(
  path: string,
  replacement: McpStoreJsonObject,
  options: AtomicJsonMutationOptions = {},
): Promise<McpStoreResult<void>> {
  if (!isMcpStoreJsonObject(replacement)) {
    return err(new McpStoreError("invalid_mutation", "replace document", path));
  }
  try {
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
  } catch (cause) {
    return err(new McpStoreError("io_failure", "create parent directory", path, cause));
  }
  const lockPath = `${path}.pi-mcp.lock`;
  const acquired = await acquireMcpStoreLock(lockPath);
  if (!acquired.ok) return acquired;
  try {
    return await writeAtomicJsonObject(path, replacement, options);
  } finally {
    await releaseMcpStoreLock(lockPath, acquired.value);
  }
}

function cloneJsonObject(document: McpStoreJsonObject): McpStoreJsonObject {
  return structuredClone(document);
}

function settingsMcpObject(document: McpStoreJsonObject): McpStoreJsonObject {
  const mcp = document.mcp;
  if (mcp === undefined) return {};
  if (!isMcpStoreJsonObject(mcp)) throw new Error("mcp must be an object");
  return cloneJsonObject(mcp);
}

function settingsServersObject(mcp: McpStoreJsonObject): McpStoreJsonObject {
  const servers = mcp.servers;
  if (servers === undefined) return {};
  if (!isMcpStoreJsonObject(servers)) throw new Error("mcp.servers must be an object");
  return cloneJsonObject(servers);
}

function isDisabledMask(value: McpStoreJsonValue | undefined): boolean {
  return isMcpStoreJsonObject(value) && Object.keys(value).length === 1 && value.enabled === false;
}

/** Owns trust-aware global and project MCP settings mutations. */
export class McpSettingsStore {
  /** Absolute path to Pi's global settings document. */
  readonly globalSettingsPath: string;
  /** Absolute path to the project's trust-gated settings document. */
  readonly projectSettingsPath: string;

  /** Bind settings paths and the current project-trust decision. */
  constructor(private readonly options: McpSettingsStoreOptions) {
    this.globalSettingsPath = join(options.agentDirectory, "settings.json");
    this.projectSettingsPath = join(options.cwd, ".pi", "settings.json");
  }

  /** Read global and trusted-project documents without merging their provenance. */
  async readLayers(): Promise<McpStoreResult<McpSettingsLayers>> {
    const global = await readJsonObject(this.globalSettingsPath, "read global settings");
    if (!global.ok) return global;
    const globalLayer: McpSettingsLayerDocument = {
      document: global.value ?? {},
      path: this.globalSettingsPath,
      scope: "global",
    };
    if (!this.options.projectTrusted) return ok({ global: globalLayer });

    const project = await readJsonObject(this.projectSettingsPath, "read project settings");
    if (!project.ok) return project;
    return ok({
      global: globalLayer,
      project: {
        document: project.value ?? {},
        path: this.projectSettingsPath,
        scope: "project",
      },
    });
  }

  /** Add or completely replace one Server Definition in the selected settings layer. */
  setServerDefinition(
    scope: McpSettingsScope,
    serverName: string,
    definition: McpStoreJsonObject,
  ): Promise<McpStoreResult<McpSettingsMutationResult>> {
    return this.mutateServer(scope, serverName, (servers) => {
      servers[serverName] = cloneJsonObject(definition);
      return true;
    });
  }

  /** Remove one layer-owned Server Definition; a project removal may reveal the global definition. */
  removeServerDefinition(
    scope: McpSettingsScope,
    serverName: string,
  ): Promise<McpStoreResult<McpSettingsMutationResult>> {
    return this.mutateServer(scope, serverName, (servers) => {
      if (!(serverName in servers)) return false;
      delete servers[serverName];
      return true;
    });
  }

  /** Disable a complete definition, or write a project mask for an inherited definition. */
  disableServerDefinition(
    scope: McpSettingsScope,
    serverName: string,
    inherited: boolean,
  ): Promise<McpStoreResult<McpSettingsMutationResult>> {
    return this.mutateServer(scope, serverName, (servers) => {
      const current = servers[serverName];
      if (current === undefined) {
        if (!inherited || scope !== "project") throw new Error("Server Definition is absent");
        servers[serverName] = { enabled: false };
        return true;
      }
      if (!isMcpStoreJsonObject(current)) throw new Error("Server Definition must be an object");
      if (current.enabled === false) return false;
      servers[serverName] = { ...current, enabled: false };
      return true;
    });
  }

  /** Enable a complete definition, or remove a project mask to reveal its inherited definition. */
  enableServerDefinition(
    scope: McpSettingsScope,
    serverName: string,
  ): Promise<McpStoreResult<McpSettingsMutationResult>> {
    return this.mutateServer(scope, serverName, (servers) => {
      const current = servers[serverName];
      if (current === undefined) return false;
      if (isDisabledMask(current)) {
        delete servers[serverName];
        return true;
      }
      if (!isMcpStoreJsonObject(current)) throw new Error("Server Definition must be an object");
      if (current.enabled === true) return false;
      servers[serverName] = { ...current, enabled: true };
      return true;
    });
  }

  private async mutateServer(
    scope: McpSettingsScope,
    serverName: string,
    mutate: (servers: Record<string, McpStoreJsonValue>) => boolean,
  ): Promise<McpStoreResult<McpSettingsMutationResult>> {
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
    if (scope === "project" && !this.options.projectTrusted) {
      return err(new McpStoreError("project_untrusted", "mutate project settings", path));
    }
    if (serverName.length === 0) {
      return err(new McpStoreError("invalid_mutation", "mutate Server Definition", path));
    }

    let operationChanged = false;
    const mutation = await mutateLockedMcpJsonDocument(path, (current) => {
      const document = { ...current };
      const mcp = { ...settingsMcpObject(document) };
      const servers = { ...settingsServersObject(mcp) };
      operationChanged = mutate(servers);
      if (!operationChanged) return undefined;
      mcp.servers = servers;
      document.mcp = mcp;
      return document;
    });
    if (!mutation.ok) return mutation;
    return ok({ changed: operationChanged, path, scope });
  }
}
