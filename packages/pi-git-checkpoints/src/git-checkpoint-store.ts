import { spawn, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const MAXIMUM_FIRST_CAPTURE_BYTES = 2 * 1024 * 1024;
const STORE_VERSION = 1;
const LEGACY_UNDO_VERSION = 1;
const TREE_ID_PATTERN = /^[0-9a-f]{40,64}$/;
const TreeIdSchema = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const StoreMetadataSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("repository"), Type.Literal("standalone")]),
    scopeRoot: Type.String(),
    sessionId: Type.String(),
    sourceGitDirectory: Type.Union([Type.String(), Type.Null()]),
    version: Type.Literal(STORE_VERSION),
    workspaceRoot: Type.String(),
  },
  { additionalProperties: false },
);
const LegacyUndoRecordSchema = Type.Object(
  {
    checkpointScopeId: Type.String(),
    paths: Type.Array(Type.String()),
    restoredTreeId: TreeIdSchema,
    safetyTreeId: TreeIdSchema,
    sessionId: Type.String(),
    version: Type.Literal(LEGACY_UNDO_VERSION),
  },
  { additionalProperties: false },
);
/** Repository-backed or standalone checkpoint storage selected at initialization. */
export type GitCheckpointMode = "repository" | "standalone";

/** Source repository state recorded with a Worktree Checkpoint. */
export type GitCheckpointSourceHead =
  | { readonly kind: "head"; readonly commit: string }
  | { readonly kind: "unborn" }
  | { readonly kind: "standalone" };

/** A captured Worktree Checkpoint and paths excluded from that capture. */
export interface GitCheckpointCapture {
  readonly treeId: string;
  readonly sourceHead: GitCheckpointSourceHead;
  readonly skippedPaths: readonly string[];
}

/** One deterministic path change between two Worktree Checkpoints. */
export interface GitCheckpointPathChange {
  readonly path: string;
  readonly status: "A" | "D" | "M";
}

/** Required identities and roots for one isolated per-session Git store. */
export interface InitializeGitCheckpointStoreInput {
  readonly agentDirectory: string;
  readonly sessionId: string;
  readonly startingDirectory: string;
  readonly signal?: AbortSignal;
  readonly effects?: GitCheckpointStoreEffects;
}

/** Narrow fault/liveness seams used by real-filesystem store tests. */
export interface GitCheckpointStoreEffects {
  readonly beforeWritePath?: (
    operation: "restore" | "rollback",
    checkpointPath: string,
  ) => Promise<void> | void;
  readonly isProcessAlive?: (processId: number) => boolean;
}

/** Input for an explicitly approved selective Restore. */
export interface RestoreWorktreeCheckpointInput {
  readonly paths: readonly string[];
  readonly safetyTreeId: string;
  readonly saveUndoRecord: (record: GitCheckpointUndoRecord) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly targetTreeId: string;
}

/** Successful selective Restore result; unsupported paths remain untouched. */
export interface RestoreWorktreeCheckpointResult {
  readonly restoredPaths: readonly string[];
}

/** One-level undo information produced by the latest successful Restore. */
export interface GitCheckpointUndoRecord {
  readonly paths: readonly string[];
  readonly restoredTreeId: string;
  readonly safetyTreeId: string;
}

/** Current undo comparison against the recorded restored tree. */
export type GitCheckpointUndoInspection =
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly divergedPaths: readonly string[] };

/** Input for one-level Worktree Checkpoint undo. */
export interface UndoWorktreeCheckpointInput {
  readonly allowDiverged: boolean;
  readonly consumeUndoRecord: () => Promise<void> | void;
  readonly readUndoRecord: () => GitCheckpointUndoRecord | undefined;
  readonly signal?: AbortSignal;
}

/** Undo either completes, is unavailable, or requires divergent-path approval. */
export type UndoWorktreeCheckpointResult =
  | { readonly kind: "undone"; readonly restoredPaths: readonly string[] }
  | { readonly kind: "unavailable" }
  | { readonly kind: "diverged"; readonly paths: readonly string[] };

/** Retention cleanup parameters for stores beneath one Pi agent directory. */
export interface CleanupGitCheckpointStoresInput {
  readonly agentDirectory: string;
  readonly currentStoreDirectory?: string;
  readonly retentionDays: number;
  readonly now?: Date;
  readonly isProcessAlive?: (processId: number) => boolean;
}

/** Store failure with a stable operation and exact rollback recovery paths. */
export class GitCheckpointStoreError extends Error {
  readonly operation: "capture" | "cleanup" | "initialize" | "restore" | "undo";
  readonly unrecoveredPaths: readonly string[];

  constructor(
    operation: GitCheckpointStoreError["operation"],
    message: string,
    options: { readonly cause?: Error; readonly unrecoveredPaths?: readonly string[] } = {},
  ) {
    super(
      `Git Checkpoints ${operation} failed: ${message}`,
      options.cause ? { cause: options.cause } : undefined,
    );
    this.name = "GitCheckpointStoreError";
    this.operation = operation;
    this.unrecoveredPaths = options.unrecoveredPaths ?? [];
  }
}

interface GitProcessOptions {
  readonly cwd: string;
  readonly input?: Buffer | string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly allowedExitCodes?: readonly number[] | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

interface GitProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface SourceRepository {
  readonly commonGitDirectory: string;
  readonly gitDirectory: string;
  readonly worktree: string;
}

type StoreMetadata = Static<typeof StoreMetadataSchema>;
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface FilesystemScan {
  readonly paths: readonly string[];
  readonly skipped: readonly string[];
}

interface TreeEntry {
  readonly mode: "100644" | "100755" | "120000";
}

interface PreparedRestorePath {
  readonly checkpointPath: string;
  readonly entry?: TreeEntry;
}

function errorFrom<Cause>(cause: Cause): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function runGit(
  arguments_: readonly string[],
  options: GitProcessOptions,
): Promise<GitProcessResult> {
  const environment = { ...process.env, ...options.environment };
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_COMMON_DIR;
  delete environment.GIT_OBJECT_DIRECTORY;
  delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  if (options.environment?.GIT_INDEX_FILE === undefined) delete environment.GIT_INDEX_FILE;
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (options.signal) spawnOptions.signal = options.signal;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", arguments_, spawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    child.once("error", rejectOnce);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      const result = {
        exitCode: exitCode ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      } satisfies GitProcessResult;
      if ((options.allowedExitCodes ?? [0]).includes(result.exitCode)) {
        resolvePromise(result);
        return;
      }
      rejectPromise(
        new Error(result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`),
      );
    });
    if (options.input === undefined) child.stdin?.end();
    else child.stdin?.end(options.input);
  });
}

function normalizedCheckpointPath(checkpointPath: string): string {
  const normalized = sep === "\\" ? checkpointPath.replaceAll("\\", "/") : checkpointPath;
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe checkpoint path: ${checkpointPath}`);
  }
  return normalized;
}

function checkpointPathFromAbsolute(workspaceRoot: string, absolutePath: string): string {
  return relative(workspaceRoot, absolutePath).replaceAll(sep, "/");
}

function pathBelongsToScope(checkpointPath: string, scopePath: string): boolean {
  return (
    scopePath === "." || checkpointPath === scopePath || checkpointPath.startsWith(`${scopePath}/`)
  );
}

function pathListInput(paths: readonly string[]): Buffer {
  return Buffer.from(`${paths.join("\0")}\0`);
}

function parseNullList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function parseIndexPaths(value: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const record of parseNullList(value)) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const header = record.slice(0, tab);
    const mode = header.slice(0, header.indexOf(" "));
    paths.set(record.slice(tab + 1), mode);
  }
  return paths;
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function findDotGit(startingDirectory: string): Promise<boolean> {
  let current = startingDirectory;
  while (true) {
    if (await pathExists(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function discoverSourceRepository(
  startingDirectory: string,
  signal?: AbortSignal,
): Promise<SourceRepository | undefined> {
  const result = await runGit(
    ["-C", startingDirectory, "rev-parse", "--path-format=absolute", "--show-toplevel"],
    { allowedExitCodes: [0, 128], cwd: startingDirectory, signal },
  );
  if (result.exitCode !== 0) {
    if (await findDotGit(startingDirectory))
      throw new Error(result.stderr.trim() || "source repository is unusable");
    return undefined;
  }
  const worktree = await realpath(result.stdout.trim());
  const gitDirectoryResult = await runGit(
    ["-C", startingDirectory, "rev-parse", "--path-format=absolute", "--absolute-git-dir"],
    { cwd: startingDirectory, signal },
  );
  const commonResult = await runGit(
    ["-C", startingDirectory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: startingDirectory, signal },
  );
  return {
    commonGitDirectory: await realpath(resolve(startingDirectory, commonResult.stdout.trim())),
    gitDirectory: await realpath(resolve(startingDirectory, gitDirectoryResult.stdout.trim())),
    worktree,
  };
}

async function writeJsonAtomically<Value extends object>(
  absolutePath: string,
  value: Value,
): Promise<void> {
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporaryPath, absolutePath);
}

function stableWorkspaceId(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex");
}

function stableCheckpointScopeId(
  mode: GitCheckpointMode,
  workspaceRoot: string,
  scopeRoot: string,
): string {
  return createHash("sha256").update(`${mode}\0${workspaceRoot}\0${scopeRoot}`).digest("hex");
}

async function copySourceIndex(
  source: SourceRepository,
  privateGitDirectory: string,
): Promise<void> {
  const sourceIndex = join(source.gitDirectory, "index");
  if (await pathExists(sourceIndex))
    await copyFile(sourceIndex, join(privateGitDirectory, "index"));
  for (const entry of await readdir(source.commonGitDirectory)) {
    if (entry.startsWith("sharedindex.")) {
      await copyFile(join(source.commonGitDirectory, entry), join(privateGitDirectory, entry));
    }
  }
}

async function configureAlternates(
  source: SourceRepository,
  privateGitDirectory: string,
): Promise<void> {
  const sourceObjects = join(source.commonGitDirectory, "objects");
  const alternates = new Set<string>([sourceObjects]);
  const sourceAlternatesPath = join(sourceObjects, "info", "alternates");
  if (await pathExists(sourceAlternatesPath)) {
    for (const line of (await readFile(sourceAlternatesPath, "utf8")).split(/\r?\n/)) {
      if (!line) continue;
      const alternate = isAbsolute(line) ? line : resolve(sourceObjects, line);
      if (await pathExists(alternate)) alternates.add(await realpath(alternate));
    }
  }
  const infoDirectory = join(privateGitDirectory, "objects", "info");
  await mkdir(infoDirectory, { recursive: true });
  await writeFile(join(infoDirectory, "alternates"), `${[...alternates].join("\n")}\n`);
}

function validateStoreMetadata(value: JsonValue, expected: StoreMetadata): boolean {
  return (
    Value.Check(StoreMetadataSchema, value) &&
    value.version === expected.version &&
    value.sessionId === expected.sessionId &&
    value.mode === expected.mode &&
    value.workspaceRoot === expected.workspaceRoot &&
    value.scopeRoot === expected.scopeRoot &&
    value.sourceGitDirectory === expected.sourceGitDirectory
  );
}

async function assertReusableStore(storeDirectory: string, expected: StoreMetadata): Promise<void> {
  const metadataPath = join(storeDirectory, "store.json");
  if (!(await pathExists(metadataPath))) return;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (cause) {
    throw new Error("stored checkpoint identity is unreadable", { cause: errorFrom(cause) });
  }
  if (!validateStoreMetadata(parsed, expected))
    throw new Error("stored checkpoint identity does not match this session");
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function rejectOtherLiveProcesses(
  storeDirectory: string,
  isAlive: (processId: number) => boolean,
): Promise<void> {
  if (!(await pathExists(storeDirectory))) return;
  for (const entry of await readdir(storeDirectory)) {
    const match = /^active-(\d+)$/.exec(entry);
    if (!match) continue;
    const processId = Number(match[1]);
    if (processId !== process.pid && isAlive(processId))
      throw new Error(`checkpoint store is active in process ${processId}`);
    if (!isAlive(processId)) await rm(join(storeDirectory, entry), { force: true });
  }
}

/** Initializes a repository or standalone isolated Git store without workspace metadata writes. */
export async function initializeGitCheckpointStore(
  input: InitializeGitCheckpointStoreInput,
): Promise<GitCheckpointStore> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sessionId)) {
    throw new GitCheckpointStoreError("initialize", "invalid session ID");
  }
  try {
    await runGit(["--version"], { cwd: input.startingDirectory, signal: input.signal });
    const scopeRoot = await realpath(input.startingDirectory);
    if (!(await stat(scopeRoot)).isDirectory())
      throw new Error("starting directory is not a directory");
    const source = await discoverSourceRepository(scopeRoot, input.signal);
    const mode: GitCheckpointMode = source ? "repository" : "standalone";
    const workspaceRoot = source?.worktree ?? scopeRoot;
    const scopePath = checkpointPathFromAbsolute(workspaceRoot, scopeRoot) || ".";
    if (scopePath !== "." && (scopePath.startsWith("../") || isAbsolute(scopePath))) {
      throw new Error("starting directory escapes the canonical workspace root");
    }
    const workspaceId = stableWorkspaceId(workspaceRoot);
    const storeDirectory = join(
      input.agentDirectory,
      "git-checkpoints",
      workspaceId,
      input.sessionId,
    );
    const privateGitDirectory = join(storeDirectory, "git");
    const metadata = {
      mode,
      scopeRoot,
      sessionId: input.sessionId,
      sourceGitDirectory: source?.gitDirectory ?? null,
      version: STORE_VERSION,
      workspaceRoot,
    } satisfies StoreMetadata;
    await assertReusableStore(storeDirectory, metadata);
    await rejectOtherLiveProcesses(storeDirectory, input.effects?.isProcessAlive ?? processIsAlive);
    const isNewStore = !(await pathExists(join(storeDirectory, "store.json")));
    await mkdir(storeDirectory, { recursive: true });
    if (isNewStore) {
      await runGit(
        ["--git-dir", privateGitDirectory, "--work-tree", workspaceRoot, "init", "--quiet"],
        {
          cwd: workspaceRoot,
          signal: input.signal,
        },
      );
      for (const [key, value] of [
        ["core.autocrlf", "false"],
        ["core.fsmonitor", "false"],
        ["core.longpaths", "true"],
        ["core.symlinks", "true"],
        ["feature.manyFiles", "true"],
        ["index.version", "4"],
      ] as const) {
        await runGit(
          ["--git-dir", privateGitDirectory, "--work-tree", workspaceRoot, "config", key, value],
          { cwd: workspaceRoot, signal: input.signal },
        );
      }
      if (source) {
        await configureAlternates(source, privateGitDirectory);
        await copySourceIndex(source, privateGitDirectory);
      }
      await writeJsonAtomically(join(storeDirectory, "store.json"), metadata);
    }
    const store = new GitCheckpointStore({
      effects: input.effects,
      mode,
      privateGitDirectory,
      scopePath,
      scopeRoot,
      sessionId: input.sessionId,
      source,
      storeDirectory,
      workspaceRoot,
    });
    await store.touchActivity();
    await writeFile(store.activeMarkerPath, `${new Date().toISOString()}\n`, {
      flag: "w",
      mode: 0o600,
    });
    return store;
  } catch (cause) {
    if (cause instanceof GitCheckpointStoreError) throw cause;
    throw new GitCheckpointStoreError("initialize", errorFrom(cause).message, {
      cause: errorFrom(cause),
    });
  }
}

interface GitCheckpointStoreConstruction {
  readonly effects: GitCheckpointStoreEffects | undefined;
  readonly mode: GitCheckpointMode;
  readonly privateGitDirectory: string;
  readonly scopePath: string;
  readonly scopeRoot: string;
  readonly sessionId: string;
  readonly source: SourceRepository | undefined;
  readonly storeDirectory: string;
  readonly workspaceRoot: string;
}

/** Serializes capture, compare, Restore, and undo against one private mutable index. */
export class GitCheckpointStore {
  /** Process marker removed during session shutdown. */
  readonly activeMarkerPath: string;
  /** Stable identity for the canonical workspace and starting-directory scope. */
  readonly checkpointScopeId: string;
  /** Repository-backed or standalone checkpoint mode fixed for this store. */
  readonly mode: GitCheckpointMode;
  /** Canonical starting directory whose paths may be restored. */
  readonly scopeRoot: string;
  /** Per-session directory containing private Git checkpoint data. */
  readonly storeDirectory: string;
  /** Canonical source worktree, or the starting directory in standalone mode. */
  readonly workspaceRoot: string;
  private readonly effects: GitCheckpointStoreEffects | undefined;
  private readonly privateGitDirectory: string;
  private readonly scopePath: string;
  private readonly sessionId: string;
  private readonly source: SourceRepository | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private captureFailure?: string;

  /** Constructs a validated store; callers use initializeGitCheckpointStore. */
  constructor(input: GitCheckpointStoreConstruction) {
    this.activeMarkerPath = join(input.storeDirectory, `active-${process.pid}`);
    this.checkpointScopeId = stableCheckpointScopeId(
      input.mode,
      input.workspaceRoot,
      input.scopeRoot,
    );
    this.effects = input.effects;
    this.mode = input.mode;
    this.privateGitDirectory = input.privateGitDirectory;
    this.scopePath = input.scopePath;
    this.scopeRoot = input.scopeRoot;
    this.sessionId = input.sessionId;
    this.source = input.source;
    this.storeDirectory = input.storeDirectory;
    this.workspaceRoot = input.workspaceRoot;
  }

  /** Returns the permanent capture failure that disables this store until reload. */
  get lastCaptureFailure(): string | undefined {
    return this.captureFailure;
  }

  /** Marks this store as recently active for retention cleanup. */
  async touchActivity(): Promise<void> {
    const activityPath = join(this.storeDirectory, "activity");
    const now = new Date();
    try {
      await utimes(activityPath, now, now);
    } catch {
      const handle = await open(activityPath, "a", 0o600);
      await handle.close();
    }
  }

  private privateGitArguments(commandArguments: readonly string[]): string[] {
    return [
      "--git-dir",
      this.privateGitDirectory,
      "--work-tree",
      this.workspaceRoot,
      ...commandArguments,
    ];
  }

  private sourceGitArguments(commandArguments: readonly string[]): string[] {
    return ["-C", this.workspaceRoot, ...commandArguments];
  }

  private async privateGit(
    commandArguments: readonly string[],
    options: Omit<GitProcessOptions, "cwd"> = {},
  ) {
    return runGit(this.privateGitArguments(commandArguments), {
      ...options,
      cwd: this.workspaceRoot,
      environment: {
        ...options.environment,
        GIT_INDEX_FILE:
          options.environment?.GIT_INDEX_FILE ?? join(this.privateGitDirectory, "index"),
      },
    });
  }

  private async sourceGit(
    commandArguments: readonly string[],
    options: Omit<GitProcessOptions, "cwd"> = {},
  ) {
    return runGit(this.sourceGitArguments(commandArguments), {
      ...options,
      cwd: this.workspaceRoot,
      environment: { ...options.environment, GIT_OPTIONAL_LOCKS: "0" },
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertEnabled(operation: "capture" | "restore" | "undo"): void {
    if (this.captureFailure)
      throw new GitCheckpointStoreError(
        operation,
        `checkpointing is disabled: ${this.captureFailure}`,
      );
  }

  private validatePath(checkpointPath: string): string {
    const normalized = normalizedCheckpointPath(checkpointPath);
    if (!pathBelongsToScope(normalized, this.scopePath)) {
      throw new Error(`path is outside the starting-directory scope: ${checkpointPath}`);
    }
    return normalized;
  }

  private async scanFilesystem(signal?: AbortSignal): Promise<FilesystemScan> {
    const paths: string[] = [];
    const skipped: string[] = [];
    const visit = async (directory: string, isScopeRoot: boolean): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      const directories: { readonly absolutePath: string; readonly checkpointPath: string }[] = [];
      for (const entry of entries) {
        if (isScopeRoot && entry.name === ".git") continue;
        const absolutePath = join(directory, entry.name);
        const checkpointPath = checkpointPathFromAbsolute(this.workspaceRoot, absolutePath);
        if (entry.isDirectory()) {
          if (await pathExists(join(absolutePath, ".git"))) {
            skipped.push(checkpointPath);
            continue;
          }
          directories.push({ absolutePath, checkpointPath });
          continue;
        }
        if (entry.isFile() || entry.isSymbolicLink()) paths.push(checkpointPath);
        else skipped.push(checkpointPath);
      }
      const ignoredDirectories = await this.ignoredPaths(
        directories.map(({ checkpointPath }) => checkpointPath),
        signal,
      );
      for (const child of directories) {
        if (!ignoredDirectories.has(child.checkpointPath)) await visit(child.absolutePath, false);
      }
    };
    await visit(this.scopeRoot, true);
    return { paths, skipped };
  }

  private async ignoredPaths(paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const result = this.source
      ? await this.sourceGit(["check-ignore", "--no-index", "--stdin", "-z"], {
          allowedExitCodes: [0, 1],
          input: pathListInput(paths),
          signal,
        })
      : await this.privateGit(["check-ignore", "--no-index", "--stdin", "-z"], {
          allowedExitCodes: [0, 1],
          input: pathListInput(paths),
          signal,
        });
    return new Set(parseNullList(result.stdout));
  }

  private async currentSourceHead(signal?: AbortSignal): Promise<GitCheckpointSourceHead> {
    if (!this.source) return { kind: "standalone" };
    const head = await this.sourceGit(["rev-parse", "--verify", "HEAD"], {
      allowedExitCodes: [0, 128],
      signal,
    });
    if (head.exitCode !== 0) return { kind: "unborn" };
    return { commit: head.stdout.trim(), kind: "head" };
  }

  private async captureUnserialized(signal?: AbortSignal): Promise<GitCheckpointCapture> {
    const scan = await this.scanFilesystem(signal);
    const privateIndex = parseIndexPaths(
      (
        await this.privateGit(["ls-files", "--stage", "-z", "--", `:(literal)${this.scopePath}`], {
          signal,
        })
      ).stdout,
    );
    const sourceIndex = this.source
      ? parseIndexPaths(
          (
            await this.sourceGit(
              ["ls-files", "--stage", "-z", "--", `:(literal)${this.scopePath}`],
              { signal },
            )
          ).stdout,
        )
      : new Map<string, string>();
    const candidates = new Set([...scan.paths, ...privateIndex.keys(), ...sourceIndex.keys()]);
    const sourceTracked = new Set(sourceIndex.keys());
    const privateOnly = [...candidates].filter(
      (checkpointPath) => !sourceTracked.has(checkpointPath),
    );
    const ignored = await this.ignoredPaths(privateOnly, signal);
    const skipped = new Set([...scan.skipped, ...ignored]);
    const allowed: string[] = [];

    for (const checkpointPath of candidates) {
      if (
        scan.skipped.some(
          (skippedPath) =>
            checkpointPath === skippedPath || checkpointPath.startsWith(`${skippedPath}/`),
        )
      ) {
        continue;
      }
      const sourceMode = sourceIndex.get(checkpointPath);
      const privateMode = privateIndex.get(checkpointPath);
      if (sourceMode === "160000" || privateMode === "160000") {
        skipped.add(checkpointPath);
        continue;
      }
      if (!sourceTracked.has(checkpointPath) && ignored.has(checkpointPath)) continue;
      const absolutePath = join(this.workspaceRoot, ...checkpointPath.split("/"));
      try {
        const information = await lstat(absolutePath);
        if (!information.isFile() && !information.isSymbolicLink()) {
          skipped.add(checkpointPath);
          continue;
        }
        if (
          !sourceTracked.has(checkpointPath) &&
          !privateIndex.has(checkpointPath) &&
          information.isFile() &&
          information.size > MAXIMUM_FIRST_CAPTURE_BYTES
        ) {
          skipped.add(checkpointPath);
          continue;
        }
      } catch (cause) {
        const error = errorFrom(cause);
        if (!("code" in error) || error.code !== "ENOENT") throw error;
      }
      allowed.push(checkpointPath);
    }

    const removePaths = [...privateIndex.keys()].filter((checkpointPath) =>
      [...ignored, ...skipped].some(
        (skippedPath) =>
          checkpointPath === skippedPath || checkpointPath.startsWith(`${skippedPath}/`),
      ),
    );
    if (removePaths.length > 0) {
      await this.privateGit(
        [
          "rm",
          "--cached",
          "-r",
          "-f",
          "--ignore-unmatch",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { input: pathListInput(removePaths), signal },
      );
    }
    if (allowed.length > 0) {
      await this.privateGit(
        ["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
        { input: pathListInput(allowed), signal },
      );
    }
    const tree = await this.privateGit(["write-tree"], { signal });
    const treeId = tree.stdout.trim();
    if (!TREE_ID_PATTERN.test(treeId)) throw new Error("Git returned an invalid tree ID");
    return {
      skippedPaths: [...skipped].toSorted(),
      sourceHead: await this.currentSourceHead(signal),
      treeId,
    };
  }

  private async captureForOperation(
    operation: "capture" | "undo",
    signal?: AbortSignal,
  ): Promise<GitCheckpointCapture> {
    try {
      return await this.captureUnserialized(signal);
    } catch (cause) {
      const error = errorFrom(cause);
      this.captureFailure = error.message;
      throw new GitCheckpointStoreError(operation, error.message, { cause: error });
    }
  }

  /** Captures the starting-directory scope; one failure disables later operations until reload. */
  capture(signal?: AbortSignal): Promise<GitCheckpointCapture> {
    return this.serialize(async () => {
      this.assertEnabled("capture");
      const result = await this.captureForOperation("capture", signal);
      await this.touchActivity();
      return result;
    });
  }

  private assertTreeId(treeId: string): void {
    if (!TREE_ID_PATTERN.test(treeId)) throw new Error(`invalid checkpoint tree ID: ${treeId}`);
  }

  /** Compares two Worktree Checkpoints inside the starting-directory scope. */
  compareTrees(
    fromTreeId: string,
    toTreeId: string,
    paths?: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly GitCheckpointPathChange[]> {
    return this.serialize(() => this.compareTreesUnserialized(fromTreeId, toTreeId, paths, signal));
  }

  private async assertSafeDestination(checkpointPath: string): Promise<string> {
    const normalized = this.validatePath(checkpointPath);
    const destination = join(this.workspaceRoot, ...normalized.split("/"));
    const parentParts = normalized.split("/").slice(0, -1);
    let ancestor = this.workspaceRoot;
    for (const part of parentParts) {
      ancestor = join(ancestor, part);
      try {
        if ((await lstat(ancestor)).isSymbolicLink())
          throw new Error(`destination ancestor is a symlink: ${normalized}`);
      } catch (cause) {
        const error = errorFrom(cause);
        if (error.message.startsWith("destination ancestor is a symlink:")) throw error;
        if ("code" in error && error.code === "ENOENT") break;
        throw error;
      }
    }
    return destination;
  }

  private async treeEntries(treeId: string, signal?: AbortSignal): Promise<Map<string, TreeEntry>> {
    this.assertTreeId(treeId);
    const result = await this.privateGit(
      ["ls-tree", "-r", "-z", treeId, "--", `:(literal)${this.scopePath}`],
      { signal },
    );
    const entries = new Map<string, TreeEntry>();
    for (const record of parseNullList(result.stdout)) {
      const tab = record.indexOf("\t");
      if (tab === -1) continue;
      const mode = record.slice(0, record.indexOf(" "));
      const checkpointPath = record.slice(tab + 1);
      if (mode === "100644" || mode === "100755" || mode === "120000")
        entries.set(checkpointPath, { mode });
    }
    return entries;
  }

  private async restoreSkippedPaths(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const sourceTracked = this.source
      ? new Set(
          parseIndexPaths(
            (await this.sourceGit(["ls-files", "--stage", "-z"], { signal })).stdout,
          ).keys(),
        )
      : new Set<string>();
    const ignored = await this.ignoredPaths(
      paths.filter((path) => !sourceTracked.has(path)),
      signal,
    );
    const skipped = new Set(ignored);
    for (const checkpointPath of paths) {
      let ancestor = this.workspaceRoot;
      for (const segment of checkpointPath.split("/")) {
        ancestor = join(ancestor, segment);
        if (await pathExists(join(ancestor, ".git"))) {
          skipped.add(checkpointPath);
          break;
        }
      }
    }
    return skipped;
  }

  private async materializeTreePaths(
    treeId: string,
    prepared: readonly PreparedRestorePath[],
    temporaryDirectory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const presentPaths = prepared.filter((item) => item.entry).map((item) => item.checkpointPath);
    if (presentPaths.length === 0) return;
    const temporaryIndex = join(temporaryDirectory, "index");
    const environment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    await this.privateGit(["read-tree", treeId], { environment, signal });
    const materializedRoot = join(temporaryDirectory, "files");
    await mkdir(materializedRoot, { recursive: true });
    await this.privateGit(
      ["checkout-index", "--force", "--stdin", "-z", `--prefix=${materializedRoot}/`],
      {
        environment,
        input: pathListInput(presentPaths),
        signal,
      },
    );
  }

  private async writePreparedPath(
    prepared: PreparedRestorePath,
    temporaryDirectory: string,
    operation: "restore" | "rollback",
  ): Promise<void> {
    await this.effects?.beforeWritePath?.(operation, prepared.checkpointPath);
    const destination = await this.assertSafeDestination(prepared.checkpointPath);
    try {
      const destinationInformation = await lstat(destination);
      if (destinationInformation.isDirectory()) {
        throw new Error(`destination is a directory: ${prepared.checkpointPath}`);
      }
      if (!destinationInformation.isFile() && !destinationInformation.isSymbolicLink()) {
        throw new Error(`destination is unsupported: ${prepared.checkpointPath}`);
      }
    } catch (cause) {
      const error = errorFrom(cause);
      if (!("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (!prepared.entry) {
      await rm(destination, { force: true });
      return;
    }
    const materialized = join(temporaryDirectory, "files", ...prepared.checkpointPath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await this.assertSafeDestination(prepared.checkpointPath);
    const temporaryDestination = join(dirname(destination), `.pi-git-checkpoint-${randomUUID()}`);
    const materializedInformation = await lstat(materialized);
    if (prepared.entry.mode === "120000") {
      await symlink(await readlink(materialized), temporaryDestination);
    } else {
      if (!materializedInformation.isFile())
        throw new Error(`materialized path is not a file: ${prepared.checkpointPath}`);
      await copyFile(materialized, temporaryDestination);
      await chmod(temporaryDestination, prepared.entry.mode === "100755" ? 0o755 : 0o644);
    }
    try {
      await rename(temporaryDestination, destination);
    } finally {
      await rm(temporaryDestination, { force: true });
    }
  }

  private async writeTreePaths(
    treeId: string,
    paths: readonly string[],
    operation: "restore" | "rollback",
    signal?: AbortSignal,
    continueAfterFailure = false,
  ): Promise<{
    readonly completed: readonly string[];
    readonly failed: readonly string[];
    readonly skipped: readonly string[];
  }> {
    const entries = await this.treeEntries(treeId, signal);
    const prepared: PreparedRestorePath[] = [];
    const skipped: string[] = [];
    const normalizedPaths = [...new Set(paths.map((path) => this.validatePath(path)))].toSorted();
    for (const checkpointPath of normalizedPaths) await this.assertSafeDestination(checkpointPath);
    const excludedPaths = await this.restoreSkippedPaths(normalizedPaths, signal);
    for (const checkpointPathValue of normalizedPaths) {
      const checkpointPath = this.validatePath(checkpointPathValue);
      if (excludedPaths.has(checkpointPath)) {
        skipped.push(checkpointPath);
        continue;
      }
      const entry = entries.get(checkpointPath);
      if (!entry) {
        const treeResult = await this.privateGit(
          ["ls-tree", "-z", treeId, "--", `:(literal)${checkpointPath}`],
          { signal },
        );
        if (treeResult.stdout) {
          skipped.push(checkpointPath);
          continue;
        }
      }
      prepared.push(entry ? { checkpointPath, entry } : { checkpointPath });
    }
    const temporaryDirectory = join(this.storeDirectory, `restore-${randomUUID()}`);
    await mkdir(temporaryDirectory, { recursive: true });
    const completed: string[] = [];
    const failed: string[] = [];
    try {
      await this.materializeTreePaths(treeId, prepared, temporaryDirectory, signal);
      for (const item of prepared) {
        try {
          signal?.throwIfAborted();
          await this.writePreparedPath(item, temporaryDirectory, operation);
          completed.push(item.checkpointPath);
        } catch (cause) {
          failed.push(item.checkpointPath);
          if (!continueAfterFailure) throw cause;
        }
      }
      return { completed, failed, skipped };
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }

  private legacyUndoPath(): string {
    return join(this.storeDirectory, "undo.json");
  }

  private async readLegacyUndo(): Promise<GitCheckpointUndoRecord | undefined> {
    try {
      const parsed: JsonValue = JSON.parse(await readFile(this.legacyUndoPath(), "utf8"));
      if (
        !Value.Check(LegacyUndoRecordSchema, parsed) ||
        parsed.sessionId !== this.sessionId ||
        parsed.checkpointScopeId !== this.checkpointScopeId ||
        !parsed.paths.every((checkpointPath) =>
          pathBelongsToScope(normalizedCheckpointPath(checkpointPath), this.scopePath),
        )
      ) {
        return undefined;
      }
      return {
        paths: parsed.paths,
        restoredTreeId: parsed.restoredTreeId,
        safetyTreeId: parsed.safetyTreeId,
      };
    } catch {
      return undefined;
    }
  }

  /** Imports valid legacy undo.json state through the callback, then removes the obsolete file. */
  migrateLegacyUndo(
    saveUndoRecord?: (record: GitCheckpointUndoRecord) => Promise<void> | void,
  ): Promise<void> {
    return this.serialize(async () => {
      const record = await this.readLegacyUndo();
      if (record && saveUndoRecord) await saveUndoRecord(record);
      await rm(this.legacyUndoPath(), { force: true });
    });
  }

  /** Restores only approved paths, rolling partial writes back from the Safety Checkpoint. */
  restore(input: RestoreWorktreeCheckpointInput): Promise<RestoreWorktreeCheckpointResult> {
    return this.serialize(async () => {
      this.assertEnabled("restore");
      const paths = input.paths.map((checkpointPath) => this.validatePath(checkpointPath));
      this.assertTreeId(input.targetTreeId);
      this.assertTreeId(input.safetyTreeId);
      try {
        const result = await this.writeTreePaths(
          input.targetTreeId,
          paths,
          "restore",
          input.signal,
        );
        const restoredPaths = result.completed;
        await this.touchActivity();
        if (restoredPaths.length > 0) {
          await input.saveUndoRecord({
            paths: restoredPaths,
            restoredTreeId: input.targetTreeId,
            safetyTreeId: input.safetyTreeId,
          });
        }
        return { restoredPaths };
      } catch (cause) {
        const original = errorFrom(cause);
        const rollback = await this.writeTreePaths(
          input.safetyTreeId,
          paths,
          "rollback",
          undefined,
          true,
        ).catch(() => ({
          completed: [],
          failed: paths,
          skipped: [],
        }));
        throw new GitCheckpointStoreError("restore", original.message, {
          cause: original,
          unrecoveredPaths: [...new Set([...rollback.failed, ...rollback.skipped])].toSorted(),
        });
      }
    });
  }

  /** Compares live paths with the latest recorded Restore for undo confirmation. */
  inspectUndo(
    readUndoRecord: () => GitCheckpointUndoRecord | undefined,
    signal?: AbortSignal,
  ): Promise<GitCheckpointUndoInspection> {
    return this.serialize(async () => {
      const record = readUndoRecord();
      if (!record) return { kind: "unavailable" };
      this.assertEnabled("undo");
      const live = await this.captureForOperation("undo", signal);
      const changes = await this.compareTreesUnserialized(
        record.restoredTreeId,
        live.treeId,
        record.paths,
        signal,
      );
      return { divergedPaths: changes.map((change) => change.path), kind: "ready" };
    });
  }

  private async compareTreesUnserialized(
    fromTreeId: string,
    toTreeId: string,
    paths: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<readonly GitCheckpointPathChange[]> {
    this.assertTreeId(fromTreeId);
    this.assertTreeId(toTreeId);
    const filter = paths
      ? new Set(paths.map((checkpointPath) => this.validatePath(checkpointPath)))
      : undefined;
    const result = await this.privateGit(
      [
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        fromTreeId,
        toTreeId,
        "--",
        `:(literal)${this.scopePath}`,
      ],
      { signal },
    );
    const fields = parseNullList(result.stdout);
    const changes: GitCheckpointPathChange[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const checkpointPath = fields[index + 1];
      if (!checkpointPath || (filter && !filter.has(checkpointPath))) continue;
      const statusValue = fields[index]?.slice(0, 1);
      changes.push({
        path: checkpointPath,
        status: statusValue === "A" || statusValue === "D" ? statusValue : "M",
      });
    }
    return changes.toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  }

  /** Restores the Safety Checkpoint once, refusing divergent live paths unless approved. */
  undo(input: UndoWorktreeCheckpointInput): Promise<UndoWorktreeCheckpointResult> {
    return this.serialize(async () => {
      this.assertEnabled("undo");
      const record = input.readUndoRecord();
      if (!record) return { kind: "unavailable" };
      const live = await this.captureForOperation("undo", input.signal);
      const changes = await this.compareTreesUnserialized(
        record.restoredTreeId,
        live.treeId,
        record.paths,
        input.signal,
      );
      const divergedPaths = changes.map((change) => change.path);
      if (divergedPaths.length > 0 && !input.allowDiverged)
        return { kind: "diverged", paths: divergedPaths };
      try {
        const result = await this.writeTreePaths(
          record.safetyTreeId,
          record.paths,
          "restore",
          input.signal,
        );
        await this.touchActivity();
        await input.consumeUndoRecord();
        return { kind: "undone", restoredPaths: result.completed };
      } catch (cause) {
        const original = errorFrom(cause);
        const rollback = await this.writeTreePaths(
          live.treeId,
          record.paths,
          "rollback",
          undefined,
          true,
        ).catch(() => ({
          completed: [],
          failed: record.paths,
          skipped: [],
        }));
        throw new GitCheckpointStoreError("undo", original.message, {
          cause: original,
          unrecoveredPaths: [...new Set([...rollback.failed, ...rollback.skipped])].toSorted(),
        });
      }
    });
  }

  /** Removes this process's live marker without deleting checkpoint history. */
  async shutdown(): Promise<void> {
    await this.operationTail;
    await rm(this.activeMarkerPath, { force: true });
  }
}

/** Best-effort inactive store cleanup; failures are returned for one caller-owned log line. */
export async function cleanupGitCheckpointStores(
  input: CleanupGitCheckpointStoresInput,
): Promise<readonly string[]> {
  const failures: string[] = [];
  const root = join(input.agentDirectory, "git-checkpoints");
  const current = input.currentStoreDirectory ? resolve(input.currentStoreDirectory) : undefined;
  const now = input.now?.getTime() ?? Date.now();
  const cutoff = now - input.retentionDays * 24 * 60 * 60 * 1000;
  const isAlive = input.isProcessAlive ?? processIsAlive;
  try {
    for (const workspace of await readdir(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const workspaceDirectory = join(root, workspace.name);
      for (const session of await readdir(workspaceDirectory, { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        const storeDirectory = join(workspaceDirectory, session.name);
        if (resolve(storeDirectory) === current) continue;
        let live = false;
        for (const entry of await readdir(storeDirectory)) {
          const match = /^active-(\d+)$/.exec(entry);
          if (!match) continue;
          const processId = Number(match[1]);
          if (isAlive(processId)) live = true;
          else await rm(join(storeDirectory, entry), { force: true });
        }
        if (live) continue;
        const activityPath = join(storeDirectory, "activity");
        const activity = await stat(activityPath).catch(() => stat(storeDirectory));
        if (activity.mtimeMs < cutoff) await rm(storeDirectory, { force: true, recursive: true });
      }
    }
  } catch (cause) {
    const error = errorFrom(cause);
    if (!("code" in error) || error.code !== "ENOENT") failures.push(error.message);
  }
  return failures;
}
