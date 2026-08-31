import type { JsonValue } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Identifies the standard Pi settings file changed by a Subagent Access command. */
export type MinimalSubagentsSettingsScope = "global" | "project";

/** Describes why a scoped minimal subagents settings write could not complete. */
export type MinimalSubagentsSettingsWriteFailureReason =
  | "project-untrusted"
  | "malformed-json"
  | "incompatible-shape"
  | "filesystem";

/** Reports an expected scoped settings failure without throwing through the command boundary. */
export class MinimalSubagentsSettingsWriteError extends Error {
  readonly _tag = "MinimalSubagentsSettingsWriteError" as const;

  /** Create a settings write failure carrying its exact scope and path. */
  constructor(
    readonly scope: MinimalSubagentsSettingsScope,
    readonly path: string,
    readonly reason: MinimalSubagentsSettingsWriteFailureReason,
    message: string,
    readonly operation?: SettingsFilesystemOperation,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Returns the path changed by a successful write or a typed expected settings failure. */
export type MinimalSubagentsSettingsWriteResult =
  | {
      readonly ok: true;
      readonly scope: MinimalSubagentsSettingsScope;
      readonly path: string;
    }
  | {
      readonly ok: false;
      readonly error: MinimalSubagentsSettingsWriteError;
    };

/** Supplies only the Root Agent context needed to select and authorize a settings file. */
export interface MinimalSubagentsSettingsWriteContext {
  readonly cwd: string;
  isProjectTrusted(): boolean;
}

type SettingsFilesystemOperation = "prepare" | "lock" | "read" | "write" | "release";
type SettingsJsonObject = Record<string, JsonValue>;

type ParsedSettingsDocument =
  | { readonly ok: true; readonly settings: SettingsJsonObject }
  | { readonly ok: false; readonly error: MinimalSubagentsSettingsWriteError };

interface ExistingSettingsDocument {
  readonly settings: SettingsJsonObject;
  readonly mode: number;
}

const JsonValueSchema = Type.Unsafe<JsonValue>({});
const SettingsJsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
const SETTINGS_LOCK_RETRY_DELAY_MS = 20;
const SETTINGS_LOCK_RETRIES = 100;
const NEW_SETTINGS_FILE_MODE = 0o600;
const settingsWriteTails = new Map<string, Promise<void>>();

function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function settingsContractError(
  scope: MinimalSubagentsSettingsScope,
  path: string,
  detail: string,
): MinimalSubagentsSettingsWriteError {
  return new MinimalSubagentsSettingsWriteError(
    scope,
    path,
    "incompatible-shape",
    `Minimal subagents settings shape is incompatible for ${scope} settings at ${path}: ${detail}`,
  );
}

function parseSettingsDocument(
  content: string,
  scope: MinimalSubagentsSettingsScope,
  path: string,
): ParsedSettingsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripUtf8Bom(content));
  } catch (cause) {
    return {
      ok: false,
      error: new MinimalSubagentsSettingsWriteError(
        scope,
        path,
        "malformed-json",
        `Minimal subagents settings JSON is malformed for ${scope} settings at ${path}`,
        "read",
        cause,
      ),
    };
  }

  if (!Value.Check(SettingsJsonObjectSchema, parsed)) {
    return { ok: false, error: settingsContractError(scope, path, "expected an object root") };
  }
  const minimalSubagents = parsed.minimalSubagents;
  if (minimalSubagents !== undefined && !Value.Check(SettingsJsonObjectSchema, minimalSubagents)) {
    return {
      ok: false,
      error: settingsContractError(
        scope,
        path,
        "expected minimalSubagents to be an object or absent",
      ),
    };
  }
  return { ok: true, settings: parsed };
}

function mutateMinimalSubagentsEnabled(
  settings: SettingsJsonObject,
  enabled: boolean | undefined,
): void {
  const currentMinimalSubagents = settings.minimalSubagents;
  const minimalSubagents = Value.Check(SettingsJsonObjectSchema, currentMinimalSubagents)
    ? currentMinimalSubagents
    : {};

  if (enabled === undefined) {
    delete minimalSubagents.enabled;
  } else {
    minimalSubagents.enabled = enabled;
  }

  if (Object.keys(minimalSubagents).length === 0) {
    delete settings.minimalSubagents;
  } else {
    settings.minimalSubagents = minimalSubagents;
  }
}

function filesystemWriteError(
  scope: MinimalSubagentsSettingsScope,
  path: string,
  operation: SettingsFilesystemOperation,
  cause: unknown,
): MinimalSubagentsSettingsWriteError {
  return new MinimalSubagentsSettingsWriteError(
    scope,
    path,
    "filesystem",
    `Minimal subagents settings ${operation} failed for ${scope} settings at ${path}`,
    operation,
    cause,
  );
}

function enqueueSettingsWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
  const predecessor = settingsWriteTails.get(path) ?? Promise.resolve();
  const operation = predecessor.catch(() => undefined).then(write);
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  settingsWriteTails.set(path, tail);
  return operation.finally(() => {
    if (settingsWriteTails.get(path) === tail) settingsWriteTails.delete(path);
  });
}

async function readSettingsDocumentUnderLock(
  scope: MinimalSubagentsSettingsScope,
  path: string,
): Promise<ExistingSettingsDocument | MinimalSubagentsSettingsWriteError> {
  let fileMode = NEW_SETTINGS_FILE_MODE;
  let content: string;
  try {
    const fileStat = await stat(path);
    fileMode = fileStat.mode & 0o7777;
    content = await readFile(path, "utf8");
  } catch (cause) {
    if (isNodeErrorWithCode(cause, "ENOENT")) return { settings: {}, mode: fileMode };
    return filesystemWriteError(scope, path, "read", cause);
  }

  const parsed = parseSettingsDocument(content, scope, path);
  return parsed.ok ? { settings: parsed.settings, mode: fileMode } : parsed.error;
}

function isNodeErrorWithCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

async function replaceSettingsFileAtomically(
  path: string,
  settings: SettingsJsonObject,
  mode: number,
  temporaryId: string,
): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${temporaryId}.tmp`);
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryFile = await open(temporaryPath, "wx", mode);
    await temporaryFile.chmod(mode);
    await temporaryFile.writeFile(`${JSON.stringify(settings, undefined, 2)}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, path);
  } catch (cause) {
    if (temporaryFile !== undefined) await temporaryFile.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/**
 * Mutates only `minimalSubagents.enabled` in global or trusted-project Pi settings.
 * Calls targeting the same file are serialized in process and re-read while holding Pi's lock.
 */
export class MinimalSubagentsSettingsWriter {
  private readonly globalSettingsPath: string;
  private readonly projectSettingsPath: string;

  /** Bind settings paths to one Root Agent context; the directory supplier exists for isolated tests. */
  constructor(
    private readonly context: MinimalSubagentsSettingsWriteContext,
    getAgentDirectory: () => string = getAgentDir,
    private readonly createTemporaryId: () => string = randomUUID,
  ) {
    this.globalSettingsPath = resolve(getAgentDirectory(), "settings.json");
    this.projectSettingsPath = resolve(context.cwd, CONFIG_DIR_NAME, "settings.json");
  }

  /** Set or remove one authored Subagent Access default, preserving every unrelated setting. */
  async writeMinimalSubagentsEnabled(
    scope: MinimalSubagentsSettingsScope,
    enabled: boolean | undefined,
  ): Promise<MinimalSubagentsSettingsWriteResult> {
    const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
    if (scope === "project" && !this.context.isProjectTrusted()) {
      return {
        ok: false,
        error: new MinimalSubagentsSettingsWriteError(
          scope,
          path,
          "project-untrusted",
          `Minimal subagents project settings write refused because the project is not trusted: ${path}`,
        ),
      };
    }

    return enqueueSettingsWrite(path, () => this.writeEnabledUnderLock(scope, path, enabled));
  }

  private async writeEnabledUnderLock(
    scope: MinimalSubagentsSettingsScope,
    path: string,
    enabled: boolean | undefined,
  ): Promise<MinimalSubagentsSettingsWriteResult> {
    try {
      await mkdir(dirname(path), { recursive: true });
    } catch (cause) {
      return { ok: false, error: filesystemWriteError(scope, path, "prepare", cause) };
    }

    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        retries: {
          retries: SETTINGS_LOCK_RETRIES,
          factor: 1,
          minTimeout: SETTINGS_LOCK_RETRY_DELAY_MS,
          maxTimeout: SETTINGS_LOCK_RETRY_DELAY_MS,
          randomize: false,
        },
      });
    } catch (cause) {
      return { ok: false, error: filesystemWriteError(scope, path, "lock", cause) };
    }

    let result: MinimalSubagentsSettingsWriteResult;
    try {
      const existing = await readSettingsDocumentUnderLock(scope, path);
      if (existing instanceof MinimalSubagentsSettingsWriteError) {
        result = { ok: false, error: existing };
      } else {
        try {
          mutateMinimalSubagentsEnabled(existing.settings, enabled);
          await replaceSettingsFileAtomically(
            path,
            existing.settings,
            existing.mode,
            this.createTemporaryId(),
          );
          result = { ok: true, scope, path };
        } catch (cause) {
          result = { ok: false, error: filesystemWriteError(scope, path, "write", cause) };
        }
      }
    } finally {
      try {
        await release();
      } catch (cause) {
        result = { ok: false, error: filesystemWriteError(scope, path, "release", cause) };
      }
    }
    return result;
  }
}
