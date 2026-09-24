import {
  updateFileLocked,
  type UpdateFileLockedOptions,
} from "@ian-pascoe/pi-utils/locked-file-update";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/** Wrap a successful MCP persistence value. */
export function ok<Value>(value: Value): McpStoreResult<Value> {
  return { ok: true, value };
}

/** Wrap an expected MCP persistence failure. */
export function err<Value>(error: McpStoreError): McpStoreResult<Value> {
  return { error, ok: false };
}

/** Match a Node.js system error code without trusting the error's shape. */
export function isNodeErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Store ingress recursively rejects non-JSON values and cycles before persistence.
function checkMcpStoreJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (
    value === null ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive classification establishes the JSON store contract.
    typeof value === "boolean" ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Primitive classification establishes the JSON store contract.
    typeof value === "string" ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only finite numeric JSON values may be persisted.
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only non-null objects reach recursive prototype and cycle checks.
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Recursive store validation establishes every accepted JSON value.
function isMcpStoreJsonValue(value: unknown): value is McpStoreJsonValue {
  return checkMcpStoreJsonValue(value, new Set());
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Store object ingress checks the root kind and every nested JSON value before mutation.
function isMcpStoreJsonObject(value: unknown): value is McpStoreJsonObject {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON scalars and arrays must not masquerade as mutable settings documents.
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isMcpStoreJsonValue(value)
  );
}

function parseJsonObject(
  text: string,
  operation: string,
  path: string,
): McpStoreResult<McpStoreJsonObject> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isMcpStoreJsonObject(parsed)) return ok(parsed);
  } catch {
    // Report malformed JSON without its possibly secret contents.
  }
  return err(new McpStoreError("invalid_document", operation, path));
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
  return parseJsonObject(text, operation, path);
}

async function updateLockedJson(
  path: string,
  update: (text: string | undefined) => McpStoreJsonObject | undefined,
  options: UpdateFileLockedOptions,
): Promise<McpStoreResult<{ readonly changed: boolean }>> {
  try {
    const changed = await updateFileLocked(
      path,
      (text) => {
        const next = update(text);
        return next === undefined ? undefined : `${JSON.stringify(next, undefined, 2)}\n`;
      },
      options,
    );
    return ok({ changed });
  } catch (cause) {
    if (cause instanceof McpStoreError) return err(cause);
    const code = isNodeErrorCode(cause, "ELOCKED") ? "lock_timeout" : "io_failure";
    return err(new McpStoreError(code, "update locked document", path, cause));
  }
}

/**
 * Lock, parse, mutate, and atomically replace one JSON document.
 * Returning undefined from `mutate` leaves the original bytes untouched.
 */
export function mutateLockedMcpJsonDocument(
  path: string,
  mutate: (current: McpStoreJsonObject | undefined) => McpStoreJsonObject | undefined,
  options: UpdateFileLockedOptions = {},
): Promise<McpStoreResult<{ readonly changed: boolean }>> {
  return updateLockedJson(
    path,
    (text) => {
      let current: McpStoreJsonObject | undefined;
      if (text !== undefined) {
        const parsed = parseJsonObject(text, "read document for mutation", path);
        if (!parsed.ok) throw parsed.error;
        current = parsed.value;
      }
      let next: McpStoreJsonObject | undefined;
      try {
        next = mutate(current);
      } catch {
        throw new McpStoreError("invalid_mutation", "apply document mutation", path);
      }
      if (next !== undefined && !isMcpStoreJsonObject(next)) {
        throw new McpStoreError("invalid_mutation", "apply document mutation", path);
      }
      return next;
    },
    options,
  );
}

/** Replace a malformed or valid JSON document under the same atomic lock. */
export async function forceReplaceLockedMcpJsonDocument(
  path: string,
  replacement: McpStoreJsonObject,
  options: UpdateFileLockedOptions = {},
): Promise<McpStoreResult<void>> {
  if (!isMcpStoreJsonObject(replacement)) {
    return err(new McpStoreError("invalid_mutation", "replace document", path));
  }
  const replaced = await updateLockedJson(path, () => replacement, options);
  return replaced.ok ? ok(undefined) : replaced;
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
