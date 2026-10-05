import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { LspInputError } from "./lsp-input-error.js";
import { LspServerClientError } from "./lsp-server-client.js";
import type {
  LspServerDefinition,
  LspServerEnablement,
  LspTimeouts,
  ResolvedLspSettings,
} from "./pi-lsp-settings.js";

/** Configures one language identifier for filename and extension routing. */
export interface LspServerLanguage {
  /** Exact filenames that this language server accepts, without path segments. */
  readonly fileNames?: readonly string[];
  /** File extensions that this language server accepts, including the leading period. */
  readonly extensions?: readonly string[];
  /** Protocol language identifier sent when opening a matching document. */
  readonly languageId: string;
}

/** Describes the routing fields of one configured language server. */
export interface LspServerRoutingDefinition {
  /** Stable settings-map key used to label matching language servers. */
  readonly serverId: string;
  /** Languages and file patterns accepted by this server. */
  readonly languages: readonly LspServerLanguage[];
  /** Exclude this server when none of its root markers exists above the requested file. */
  readonly requireRootMarker?: boolean;
  /** Basename glob patterns that select this server instance's nearest workspace root. */
  readonly rootMarkers?: readonly string[];
  /**
   * Basename glob patterns whose nearest ancestor, within the root search limit, is the root
   * instead. Root markers still decide the Activation Gate and the fallback root.
   */
  readonly workspaceRootMarkers?: readonly string[];
}

/** Supplies one ancestor directory and its entry basenames, ordered nearest-first. */
export interface LspAncestorDirectory {
  /** Absolute directory path. */
  readonly path: string;
  /** Basenames directly contained by this directory. */
  readonly entryNames: readonly string[];
}

/** Identifies a server definition and language mapping selected for a file. */
export interface LspServerRoute {
  /** Configured server ID. */
  readonly serverId: string;
  /** Language mapping that matched the requested file. */
  readonly language: LspServerLanguage;
  /** Root selected by the definition's root and workspace root markers, or the working directory. */
  readonly rootPath: string;
}

/** Minimum client lifecycle contract required by the session-scoped server manager. */
export interface LspManagedServerClient {
  /** Negotiated language-server capabilities, returned unchanged by `capabilities`. */
  readonly capabilities: unknown;
  /** Gracefully stop the language-server process and release protocol resources. */
  shutdown(): Promise<void>;
}

/** Provides all parsed inputs needed to start one language-server process. */
export interface LspServerStartInput {
  /** Complete configured Server Definition. */
  readonly definition: LspServerDefinition;
  /** Marks a started instance unavailable after a process or protocol failure. */
  readonly onUnavailable: (cause: unknown) => void;
  /** Workspace root selected for this Server Instance. */
  readonly rootPath: string;
  /** Cancels initialization when the Instance is stopped before startup completes. */
  readonly signal: AbortSignal;
  /** Resolved request and lifecycle timeout policy. */
  readonly timeouts: LspTimeouts;
}

/** Names the capability an operation requires so unsupported-operation failures can cite it. */
export interface LspCapabilityRequirement<TClient extends LspManagedServerClient> {
  /** Protocol method of the capability, such as `textDocument/declaration`. */
  readonly method: string;
  /** Whether a ready client currently advertises the capability. */
  readonly isSupportedBy: (client: TClient) => boolean;
}

/** Starts one concrete client for a selected Server Definition and root. */
export type StartLspServerClient<TClient extends LspManagedServerClient> = (
  input: LspServerStartInput,
) => Promise<TClient>;

/** Classifies a labeled failure from one matching Server Instance. */
export type LspServerFailureCode =
  | "ambiguous-server"
  | "no-capable-server"
  | "no-matching-server"
  | "request-failed"
  | "request-timeout"
  | "root-marker-not-found"
  | "server-disabled"
  | "server-unavailable";

/** Preserves one matching server's failure without discarding sibling successes. */
export interface LspServerFailure {
  /** Stable machine-readable failure class. */
  readonly code: LspServerFailureCode;
  /** Searchable caller-facing error prefixed with `Pi LSP:`. */
  readonly message: string;
  /** Configured server ID, or the requested missing ID. */
  readonly serverId: string;
}

/** Labels a successful value with the Server Instance that produced it. */
export interface LspServerSuccess<T> {
  /** Selected workspace root. */
  readonly rootPath: string;
  /** Configured server ID. */
  readonly serverId: string;
  /** Successful operation value, including authoritative empty values. */
  readonly value: T;
}

/** Keeps successful multi-server reads useful when independent servers fail. */
export interface LspServerReadResult<T> {
  /** Labeled operational failures in deterministic route order. */
  readonly failures: readonly LspServerFailure[];
  /** Labeled successful values in deterministic route order. */
  readonly successes: readonly LspServerSuccess<T>[];
}

/** Supplies one ready client and its exact Server Instance route. */
export interface LspResolvedServerClient<TClient extends LspManagedServerClient> {
  /** Ready language-server client. */
  readonly client: TClient;
  /** Exact configured definition used to start the client. */
  readonly definition: LspServerDefinition;
  /** Exact matching route. */
  readonly route: LspServerRoute;
}

/** Returns either one exact ready client or an operation-specific routing failure. */
export type LspServerResolution<TClient extends LspManagedServerClient> =
  | { readonly kind: "failure"; readonly failure: LspServerFailure }
  | { readonly kind: "success"; readonly instance: LspResolvedServerClient<TClient> };

/** Returns one instance's preview-request value and the instance that produced it, or why not. */
export type LspServerMutationResult<TClient extends LspManagedServerClient, T> =
  | { readonly kind: "failure"; readonly failure: LspServerFailure }
  | {
      readonly kind: "success";
      readonly instance: LspResolvedServerClient<TClient>;
      readonly value: T;
    };

/** Returns the routes a request may use, or why none applies. */
type LspRouteSelection =
  | { readonly kind: "failure"; readonly failure: LspServerFailure }
  | { readonly kind: "routes"; readonly routes: readonly [LspServerRoute, ...LspServerRoute[]] };

/** Describes one configured or previously resolved Server Instance without starting it. */
export interface LspServerStatusEntry {
  /** Latest unavailable reason, when startup, process, or protocol lifecycle failed. */
  readonly error?: string;
  /** The Server Definition's language mappings, which decide the files it handles. */
  readonly languages: readonly LspServerLanguage[];
  /** Workspace root for a resolved instance; absent before any file routes to the server. */
  readonly rootPath?: string;
  /** Configured server ID. */
  readonly serverId: string;
  /** Session lifecycle state. */
  readonly state: "configured" | "disabled" | "running" | "starting" | "stopped" | "unavailable";
}

/** Reports configuration failures and session-scoped Server Instance states. */
export interface LspServerManagerStatus {
  /** Server entries ordered by ID and then root. */
  readonly servers: readonly LspServerStatusEntry[];
  /** Strict settings failures kept visible until Pi `/reload`. */
  readonly warnings: readonly string[];
}

/** Workspace roots of one Server Definition other than a searched Server Instance root. */
export interface LspOtherWorkspaceRoots {
  /** Up to `LSP_OTHER_WORKSPACE_ROOT_LIMIT` absolute roots, sorted. */
  readonly rootPaths: readonly string[];
  /**
   * Whether more roots may exist than `rootPaths` lists: more were found, or discovery stopped at
   * its directory limit before checking every directory that could hold one. Unchecked directories
   * inside a searched workspace root do not count; they are reported with its unloaded packages.
   */
  readonly hasMore: boolean;
}

/** Package roots inside a workspace root whose Server Instance has synchronized none of their files. */
export interface LspUnloadedWorkspacePackages {
  /** Every unloaded absolute package root found, sorted. */
  readonly packageRoots: readonly string[];
  /** Whether discovery stopped at its directory limit before checking every directory in the root. */
  readonly hasMore: boolean;
}

/** How to tell which files a Server Instance has loaded. */
export interface LspLoadedDocuments<TClient extends LspManagedServerClient> {
  /** The file a request was made for, which counts as loaded. */
  readonly queriedFilePath: string;
  /** Absolute paths of the documents a running instance currently has synchronized. */
  readonly synchronizedFilePaths: (client: TClient) => Iterable<string>;
}

/** What a request to one Server Instance may not consider. */
export interface LspWorkspaceScope {
  /** Other workspace roots of the same Server Definition. */
  readonly otherRoots: LspOtherWorkspaceRoots;
  /** Present for a workspace root whose definition has root markers, when loaded documents were given. */
  readonly unloadedPackages?: LspUnloadedWorkspacePackages;
}

function summarizeOtherRoots(
  roots: ReadonlySet<string>,
  unchecked: boolean,
): LspOtherWorkspaceRoots {
  const sorted = [...roots].sort((left, right) => left.localeCompare(right));
  return {
    rootPaths: sorted.slice(0, LSP_OTHER_WORKSPACE_ROOT_LIMIT),
    hasMore: sorted.length > LSP_OTHER_WORKSPACE_ROOT_LIMIT || unchecked,
  };
}

/** Most other workspace roots one discovery reports. */
export const LSP_OTHER_WORKSPACE_ROOT_LIMIT = 5;

/** Default for the most directories one root-marker discovery lists, bounding its cost. */
export const LSP_ROOT_DISCOVERY_DIRECTORY_LIMIT = 4096;

/** Directories root-marker discovery never descends into: installed dependencies. */
const ROOT_DISCOVERY_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules"]);

/** Construction inputs for one session-scoped language-server manager. */
export interface LspServerManagerInput<TClient extends LspManagedServerClient> {
  /** Pi session working directory used for relative paths and root fallback. */
  readonly cwd: string;
  /** Fully parsed trust-aware LSP settings. */
  readonly settings: ResolvedLspSettings;
  /** Concrete process/client constructor owned by the LSP client module. */
  readonly startClient: StartLspServerClient<TClient>;
  /** Lists one directory's entry names for root-marker routing; defaults to the filesystem. */
  readonly readDirectory?: (directoryPath: string) => Promise<readonly string[]>;
  /**
   * Home directory that bounds workspace-root routing and other-root discovery; defaults to the
   * user's home directory.
   */
  readonly homeDirectory?: string;
  /** Most directories one root-marker discovery lists; defaults to `LSP_ROOT_DISCOVERY_DIRECTORY_LIMIT`. */
  readonly rootDiscoveryDirectoryLimit?: number;
}

/** Removes Pi's optional leading path sigil before file routing. */
export function normalizeLspFilePath(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function languageMatchesFile(language: LspServerLanguage, filePath: string): boolean {
  const fileName = basename(filePath);
  return (
    language.fileNames?.includes(fileName) === true ||
    language.extensions?.includes(extname(fileName)) === true
  );
}

function containsLspRootMarker(
  entryNames: readonly string[],
  rootMarkers: readonly string[],
): boolean {
  return entryNames.some((entryName) =>
    rootMarkers.some((rootMarker) => matchesGlob(entryName, rootMarker)),
  );
}

function isSameOrAncestorDirectory(ancestor: string, descendant: string): boolean {
  const relativePath = relative(ancestor, descendant);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

/**
 * Whether an upward root search must not use `directory`: the home directory and every directory
 * above it, including the filesystem root, are out of scope unless the working directory is at or
 * above `directory`.
 */
function isBeyondLspRootSearchLimit(
  directory: string,
  cwd: string,
  homeDirectory: string,
): boolean {
  return (
    isSameOrAncestorDirectory(directory, homeDirectory) &&
    !isSameOrAncestorDirectory(cwd, directory)
  );
}

/** Whether a definition selects its root from ancestor directories at all. */
function hasLspRootMarkers(definition: {
  readonly rootMarkers?: readonly string[];
  readonly workspaceRootMarkers?: readonly string[];
}): boolean {
  return (
    (definition.rootMarkers?.length ?? 0) > 0 || (definition.workspaceRootMarkers?.length ?? 0) > 0
  );
}

/**
 * Select a definition's root from ancestors ordered nearest-first: the nearest ancestor holding a
 * workspace root marker within the root search limit, else the nearest holding a root marker,
 * else the working directory. Returns `undefined` when the Activation Gate requires a root marker
 * and none is found; workspace root markers never satisfy the gate.
 */
function findLspRoot(
  definition: LspServerRoutingDefinition,
  ancestorDirectories: readonly LspAncestorDirectory[],
  cwd: string,
  homeDirectory: string,
): string | undefined {
  const rootMarkers = definition.rootMarkers ?? [];
  const markerRoot =
    rootMarkers.length === 0
      ? undefined
      : ancestorDirectories.find(({ entryNames }) => containsLspRootMarker(entryNames, rootMarkers))
          ?.path;
  if (markerRoot === undefined && definition.requireRootMarker === true) return undefined;
  const workspaceRootMarkers = definition.workspaceRootMarkers ?? [];
  const workspaceRoot =
    workspaceRootMarkers.length === 0
      ? undefined
      : ancestorDirectories.find(
          ({ entryNames, path }) =>
            !isBeyondLspRootSearchLimit(path, cwd, homeDirectory) &&
            containsLspRootMarker(entryNames, workspaceRootMarkers),
        )?.path;
  return workspaceRoot ?? markerRoot ?? cwd;
}

/**
 * Route one file to every matching configured server in stable settings-map order. Workspace root
 * markers are not searched at `homeDirectory` or above it unless `cwd` is at or above it.
 */
export function routeLspServersForFile(
  serverDefinitions: readonly LspServerRoutingDefinition[],
  filePath: string,
  cwd: string,
  ancestorDirectories: readonly LspAncestorDirectory[],
  homeDirectory: string = homedir(),
): readonly LspServerRoute[] {
  const normalizedFilePath = normalizeLspFilePath(filePath);
  const resolvedCwd = resolve(cwd);
  const resolvedHomeDirectory = resolve(homeDirectory);
  const routes: LspServerRoute[] = [];

  for (const serverDefinition of serverDefinitions) {
    const language = serverDefinition.languages.find((candidate) =>
      languageMatchesFile(candidate, normalizedFilePath),
    );
    if (language === undefined) continue;
    const rootPath = findLspRoot(
      serverDefinition,
      ancestorDirectories,
      resolvedCwd,
      resolvedHomeDirectory,
    );
    if (rootPath === undefined) continue;
    routes.push({
      serverId: serverDefinition.serverId,
      language,
      rootPath,
    });
  }

  return routes;
}

/** The root-selection inputs that marker-root discovery mirrors. */
interface LspRootDiscoveryPolicy {
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly rootMarkers: readonly string[];
  readonly workspaceRootMarkers: readonly string[];
}

/** Directories one discovery walk lists concurrently; they are still visited in walk order. */
const ROOT_DISCOVERY_READ_CONCURRENCY = 32;

/** Whether `directory` holds a workspace root marker that root selection may use. */
function isLspWorkspaceRoot(
  directory: string,
  entryNames: readonly string[],
  policy: LspRootDiscoveryPolicy,
): boolean {
  return (
    containsLspRootMarker(entryNames, policy.workspaceRootMarkers) &&
    !isBeyondLspRootSearchLimit(directory, policy.cwd, policy.homeDirectory)
  );
}

/** What one discovery walk found below its base directory. */
interface LspDiscoveredRoots {
  /** Roots other than the searched root that discovered marker directories route to. */
  readonly otherRoots: readonly string[];
  /** Directories with a root marker that route to the searched root, which is excluded. */
  readonly packageRoots: readonly string[];
  /** Directories left unlisted at the directory limit; nothing below them was checked either. */
  readonly unchecked: readonly string[];
}

async function listLspDiscoveryDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/**
 * Walk `baseDirectory` and the directories under it once, breadth first in name order, skipping
 * hidden and dependency directories and symbolic links. A directory holding a root or workspace
 * root marker routes like a file there would: to its nearest workspace-marker directory within the
 * root search limit, or else to itself. Routes other than `searchedRoot` are other roots. The walk
 * lists at most `directoryLimit` directories, and stops once `maxOtherRoots` other roots are found
 * unless it collects packages.
 *
 * With `collectPackages`, root-marker directories routing to `searchedRoot` are its packages.
 * `searchedRoot` and its subtree are then walked first, even when it lies below a directory the
 * walk skips or the limit would not reach, and the walk from `baseDirectory` skips them after.
 */
async function discoverLspRoots(
  baseDirectory: string,
  policy: LspRootDiscoveryPolicy,
  searchedRoot: string,
  options: {
    readonly collectPackages: boolean;
    readonly directoryLimit: number;
    readonly maxOtherRoots: number;
  },
): Promise<LspDiscoveredRoots> {
  const otherRoots = new Set<string>();
  const packageRoots: string[] = [];
  const isDone = () => !options.collectPackages && otherRoots.size >= options.maxOtherRoots;
  const found = (unchecked: readonly string[]): LspDiscoveredRoots => ({
    otherRoots: [...otherRoots],
    packageRoots,
    unchecked,
  });
  const starts =
    options.collectPackages && baseDirectory !== searchedRoot
      ? [searchedRoot, baseDirectory]
      : [baseDirectory];
  let listed = 0;
  for (const [startIndex, start] of starts.entries()) {
    const skippedSubtree = startIndex > 0 ? searchedRoot : undefined;
    const queue: { readonly path: string; readonly workspaceRoot: string | undefined }[] = [
      { path: start, workspaceRoot: undefined },
    ];
    while (queue.length > 0 && !isDone()) {
      if (listed === options.directoryLimit) {
        return found([...queue.map(({ path }) => path), ...starts.slice(startIndex + 1)]);
      }
      const batch = queue.splice(
        0,
        Math.min(ROOT_DISCOVERY_READ_CONCURRENCY, options.directoryLimit - listed),
      );
      const listings = await Promise.all(batch.map(({ path }) => listLspDiscoveryDirectory(path)));
      for (const [index, item] of batch.entries()) {
        if (isDone()) return found([]);
        listed++;
        const entries = listings[index];
        if (entries === undefined) continue;
        entries.sort((left, right) => left.name.localeCompare(right.name));
        const entryNames = entries.map(({ name }) => name);
        const isWorkspaceRoot = isLspWorkspaceRoot(item.path, entryNames, policy);
        const workspaceRoot = isWorkspaceRoot ? item.path : item.workspaceRoot;
        const hasRootMarker = containsLspRootMarker(entryNames, policy.rootMarkers);
        if (isWorkspaceRoot || hasRootMarker) {
          const routedRoot = workspaceRoot ?? item.path;
          if (routedRoot !== searchedRoot) {
            otherRoots.add(routedRoot);
          } else if (options.collectPackages && hasRootMarker && item.path !== searchedRoot) {
            packageRoots.push(item.path);
          }
        }
        for (const entry of entries) {
          const path = resolve(item.path, entry.name);
          if (
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !ROOT_DISCOVERY_SKIPPED_DIRECTORIES.has(entry.name) &&
            path !== skippedSubtree
          ) {
            queue.push({ path, workspaceRoot });
          }
        }
      }
    }
  }
  return found([]);
}

/**
 * Pick where marker-root discovery starts for `searchedRoot`: its outermost ancestor (itself
 * included) that holds one of `markers`, or the working directory when that is a higher ancestor.
 * The upward walk stops below the home directory and every directory above it, including the
 * filesystem root, unless the working directory is at or above that directory. Home and
 * filesystem-root scans therefore stay out of scope.
 */
async function findLspDiscoveryBase(
  searchedRoot: string,
  rootMarkers: readonly string[],
  cwd: string,
  homeDirectory: string,
  readDirectory: (directoryPath: string) => Promise<readonly string[]>,
): Promise<string> {
  let base = searchedRoot;
  let directory = searchedRoot;
  for (;;) {
    if (isBeyondLspRootSearchLimit(directory, cwd, homeDirectory)) return base;
    let entryNames: readonly string[] = [];
    try {
      entryNames = await readDirectory(directory);
    } catch {
      // An unreadable ancestor holds no markers we can see; keep climbing.
    }
    if (directory === cwd || containsLspRootMarker(entryNames, rootMarkers)) base = directory;
    const parent = dirname(directory);
    if (parent === directory) return base;
    directory = parent;
  }
}

function describeLspError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function lspInstanceKey(serverId: string, rootPath: string): string {
  return JSON.stringify([serverId, rootPath]);
}

async function readLspAncestorDirectories(
  filePath: string,
  readDirectory: (directoryPath: string) => Promise<readonly string[]>,
): Promise<LspAncestorDirectory[]> {
  const directories: LspAncestorDirectory[] = [];
  let currentDirectory = dirname(filePath);
  for (;;) {
    let entryNames: readonly string[] = [];
    try {
      entryNames = await readDirectory(currentDirectory);
    } catch {
      // A target can be newly created; continue upward until an existing ancestor is found.
    }
    directories.push({ entryNames, path: currentDirectory });
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return directories;
    currentDirectory = parentDirectory;
  }
}

function incapableServerFailure<TClient extends LspManagedServerClient>(
  serverId: string,
  capability: LspCapabilityRequirement<TClient>,
): LspServerFailure {
  return {
    code: "no-capable-server",
    message: `Pi LSP: server ${serverId} does not support ${capability.method}`,
    serverId,
  };
}

function noCapableServerFailure<TClient extends LspManagedServerClient>(
  capability: LspCapabilityRequirement<TClient>,
  incapableServerIds: readonly string[],
): LspServerFailure {
  return {
    code: "no-capable-server",
    message: `Pi LSP: no matching server supports ${capability.method}; matching servers without it: ${incapableServerIds.join(", ")}`,
    serverId: "*",
  };
}

function unavailableFailure(route: LspServerRoute, error: string): LspServerFailure {
  return {
    code: "server-unavailable",
    message: `Pi LSP: server ${route.serverId} is unavailable for ${route.rootPath}: ${error}`,
    serverId: route.serverId,
  };
}

/**
 * Run one operation on a ready instance, labeling a server failure with its server. A client
 * timeout becomes `request-timeout`. An `LspInputError` is the caller's to fix and a cancellation
 * is the caller's abort, so both propagate unlabeled.
 */
async function runServerOperation<TClient extends LspManagedServerClient, T>(
  { client, route }: LspResolvedServerClient<TClient>,
  operation: (client: TClient, route: LspServerRoute) => Promise<T>,
): Promise<LspServerSuccess<T> | LspServerFailure> {
  try {
    return {
      rootPath: route.rootPath,
      serverId: route.serverId,
      value: await operation(client, route),
    };
  } catch (error) {
    if (error instanceof LspInputError) throw error;
    if (error instanceof LspServerClientError && error.kind === "cancelled") throw error;
    return {
      code:
        error instanceof LspServerClientError && error.kind === "timeout"
          ? "request-timeout"
          : "request-failed",
      message: `Pi LSP: server ${route.serverId} request failed: ${describeLspError(error)}`,
      serverId: route.serverId,
    };
  }
}

/** Own lazy Server Instance creation, routing, failure state, restart, and session shutdown. */
export class LspServerManager<TClient extends LspManagedServerClient = LspManagedServerClient> {
  private readonly clients = new Map<string, TClient>();
  private readonly inFlightStarts = new Map<string, Promise<LspServerResolution<TClient>>>();
  private readonly inFlightStops = new Map<string, Promise<void>>();
  private readonly knownRoutes = new Map<string, LspServerRoute>();
  private readonly unavailable = new Map<string, string>();
  private readonly instanceLifetimes = new Map<string, AbortController>();
  private closed = false;

  private configuredEnablement: ReadonlyMap<string, LspServerEnablement>;
  private sessionEnablement: ReadonlyMap<string, boolean> = new Map();

  /** Bind parsed settings and one concrete client constructor to the current Pi session. */
  constructor(private readonly input: LspServerManagerInput<TClient>) {
    this.configuredEnablement = input.settings.enablement;
  }

  /** Resolve eligibility independently of whether any Instance is running. */
  getEnablement(serverId: string): LspServerEnablement {
    if (!this.input.settings.servers.has(serverId)) {
      throw new Error(`Pi LSP: unknown server ${serverId}`);
    }
    const session = this.sessionEnablement.get(serverId);
    if (session !== undefined) return { enabled: session, scope: "session" };
    return this.configuredEnablement.get(serverId) ?? { enabled: true, scope: "default" };
  }

  /** Apply current settings and branch choices, stopping all effectively disabled Instances. */
  async setEnablement(
    configured: ReadonlyMap<string, LspServerEnablement>,
    session: ReadonlyMap<string, boolean>,
  ): Promise<void> {
    this.configuredEnablement = new Map(configured);
    this.sessionEnablement = new Map(session);
    await Promise.all(
      [...this.knownRoutes.values()]
        .filter((route) => !this.getEnablement(route.serverId).enabled)
        .map((route) => this.stopServer(route.serverId, route.rootPath)),
    );
  }

  /** Return configuration and known instance state without starting a server. */
  getStatus(): LspServerManagerStatus {
    const servers: LspServerStatusEntry[] = [];
    for (const [serverId, { languages }] of this.input.settings.servers) {
      const routes = [...this.knownRoutes.entries()]
        .filter(([, route]) => route.serverId === serverId)
        .sort(([, left], [, right]) => left.rootPath.localeCompare(right.rootPath));
      if (routes.length === 0) {
        servers.push({
          languages,
          serverId,
          state: this.getEnablement(serverId).enabled ? "configured" : "disabled",
        });
        continue;
      }
      for (const [key, route] of routes) {
        const error = this.unavailable.get(key);
        const instance = { languages, rootPath: route.rootPath, serverId };
        if (!this.getEnablement(serverId).enabled) {
          servers.push({ ...instance, state: "disabled" });
        } else if (error !== undefined) {
          servers.push({ ...instance, error, state: "unavailable" });
        } else if (this.inFlightStarts.has(key)) {
          servers.push({ ...instance, state: "starting" });
        } else if (this.clients.has(key)) {
          servers.push({ ...instance, state: "running" });
        } else {
          servers.push({ ...instance, state: "stopped" });
        }
      }
    }
    return {
      servers,
      warnings: this.input.settings.warnings,
    };
  }

  private async routeFile(
    filePath: string,
    requestedServerId?: string,
  ): Promise<readonly LspServerRoute[]> {
    const absolutePath = resolve(this.input.cwd, normalizeLspFilePath(filePath));
    // Route only candidates: the requested definition, or every enabled one when none is named.
    const candidates = [...this.input.settings.servers.values()].filter(
      (definition) =>
        (requestedServerId === undefined
          ? this.getEnablement(definition.id).enabled
          : definition.id === requestedServerId) &&
        definition.languages.some((language) => languageMatchesFile(language, absolutePath)),
    );
    // Ancestor listings are costly in large directories; list them only when a candidate has
    // root or workspace root markers to find. Marker-free candidates root at the working directory.
    const ancestors = candidates.some(hasLspRootMarkers)
      ? await readLspAncestorDirectories(absolutePath, this.input.readDirectory ?? readdir)
      : [];
    const definitions = candidates.map((definition) => ({
      languages: definition.languages,
      requireRootMarker: definition.requireRootMarker,
      rootMarkers: definition.rootMarkers,
      serverId: definition.id,
      workspaceRootMarkers: definition.workspaceRootMarkers ?? [],
    }));
    return routeLspServersForFile(
      definitions,
      absolutePath,
      this.input.cwd,
      ancestors,
      this.input.homeDirectory ?? homedir(),
    );
  }

  /** IDs of the Server Definitions accepting the file's language, before enablement and gating. */
  private languageServerIds(filePath: string): readonly string[] {
    const absolutePath = resolve(this.input.cwd, normalizeLspFilePath(filePath));
    return [...this.input.settings.servers.values()]
      .filter((definition) =>
        definition.languages.some((language) => languageMatchesFile(language, absolutePath)),
      )
      .map((definition) => definition.id);
  }

  /** Find workspace roots of one Server Definition other than `rootPath`; see `findWorkspaceScope`. */
  async findOtherWorkspaceRoots(
    serverId: string,
    rootPath: string,
  ): Promise<LspOtherWorkspaceRoots> {
    return (await this.findWorkspaceScope(serverId, rootPath)).otherRoots;
  }

  /**
   * Describe what a request to the Server Instance at `rootPath` may not consider, with one
   * bounded walk.
   *
   * Other roots are roots of the definition's known Server Instances, and the roots that
   * directories holding one of its root or workspace root markers route to, found under the
   * outermost ancestor of `rootPath` that has a marker (or under the working directory, when that
   * is higher). Files under them route to other Server Instances; package directories inside a
   * searched workspace root route to it and are not other roots.
   *
   * With `loaded`, when `rootPath` was selected by a workspace root marker and the definition has
   * root markers, unloaded packages are the directories under it holding a root marker (and
   * routing to it) in which the instance has synchronized no document: a language server loads a
   * package's project only when a file there is opened. A document belongs to its nearest package
   * root, and the queried file counts as synchronized.
   *
   * The walk skips hidden and `node_modules` directories and lists at most
   * `rootDiscoveryDirectoryLimit` directories. When it looks for packages, it walks the workspace
   * root's subtree first, even below a skipped directory. Unchecked directories inside the
   * workspace root can hide only its packages and nested workspaces, so they mark the unloaded
   * packages, not the other roots, as incomplete; unchecked directories elsewhere, including its
   * ancestors, mark only the other roots as incomplete.
   */
  async findWorkspaceScope(
    serverId: string,
    rootPath: string,
    loaded?: LspLoadedDocuments<TClient>,
  ): Promise<LspWorkspaceScope> {
    const searchedRoot = resolve(this.input.cwd, rootPath);
    const maxRoots = LSP_OTHER_WORKSPACE_ROOT_LIMIT + 1;
    const roots = new Set(
      [...this.knownRoutes.values()]
        .filter((route) => route.serverId === serverId && route.rootPath !== searchedRoot)
        .map((route) => route.rootPath),
    );
    const definition = this.input.settings.servers.get(serverId);
    if (definition === undefined || !hasLspRootMarkers(definition)) {
      return { otherRoots: summarizeOtherRoots(roots, false) };
    }
    const policy = this.rootDiscoveryPolicy(definition);
    const readDirectory = this.input.readDirectory ?? readdir;
    let isWorkspaceRoot = false;
    if (policy.workspaceRootMarkers.length > 0) {
      let entryNames: readonly string[] = [];
      try {
        entryNames = await readDirectory(searchedRoot);
      } catch {
        // An unreadable root holds no markers we can see.
      }
      isWorkspaceRoot = isLspWorkspaceRoot(searchedRoot, entryNames, policy);
    }
    const collectPackages =
      loaded !== undefined && isWorkspaceRoot && policy.rootMarkers.length > 0;
    if (roots.size >= maxRoots && !collectPackages) {
      return { otherRoots: summarizeOtherRoots(roots, false) };
    }
    const discoveryBase = await findLspDiscoveryBase(
      searchedRoot,
      [...policy.rootMarkers, ...policy.workspaceRootMarkers],
      policy.cwd,
      policy.homeDirectory,
      readDirectory,
    );
    const discovery = await discoverLspRoots(discoveryBase, policy, searchedRoot, {
      collectPackages,
      directoryLimit: this.input.rootDiscoveryDirectoryLimit ?? LSP_ROOT_DISCOVERY_DIRECTORY_LIMIT,
      maxOtherRoots: maxRoots,
    });
    for (const root of discovery.otherRoots) roots.add(root);
    const isInsideSearchedRoot = (path: string) => isSameOrAncestorDirectory(searchedRoot, path);
    const otherRoots = summarizeOtherRoots(
      roots,
      discovery.unchecked.some((path) => !isWorkspaceRoot || !isInsideSearchedRoot(path)),
    );
    if (!collectPackages) return { otherRoots };

    const client = this.clients.get(lspInstanceKey(serverId, searchedRoot));
    const loadedPackages = new Set<string>();
    for (const filePath of [
      resolve(this.input.cwd, normalizeLspFilePath(loaded.queriedFilePath)),
      ...(client === undefined ? [] : loaded.synchronizedFilePaths(client)),
    ]) {
      // The nearest package root is the longest one containing the file.
      let owner: string | undefined;
      for (const packageRoot of discovery.packageRoots) {
        if (
          isSameOrAncestorDirectory(packageRoot, filePath) &&
          (owner === undefined || packageRoot.length > owner.length)
        ) {
          owner = packageRoot;
        }
      }
      if (owner !== undefined) loadedPackages.add(owner);
    }
    return {
      otherRoots,
      unloadedPackages: {
        packageRoots: discovery.packageRoots
          .filter((packageRoot) => !loadedPackages.has(packageRoot))
          .sort((left, right) => left.localeCompare(right)),
        hasMore: discovery.unchecked.some(isInsideSearchedRoot),
      },
    };
  }

  private rootDiscoveryPolicy(definition: LspServerDefinition): LspRootDiscoveryPolicy {
    return {
      cwd: resolve(this.input.cwd),
      homeDirectory: resolve(this.input.homeDirectory ?? homedir()),
      rootMarkers: definition.rootMarkers,
      workspaceRootMarkers: definition.workspaceRootMarkers ?? [],
    };
  }

  /**
   * Query matching capable instances while retaining independent operational failures. An
   * `LspInputError` or a cancellation from `operation` rejects the whole read: it is the
   * caller's input or abort, not a server failure.
   */
  async runRead<T>(
    filePath: string,
    serverId: string | undefined,
    capability: LspCapabilityRequirement<TClient>,
    operation: (client: TClient, route: LspServerRoute) => Promise<T>,
  ): Promise<LspServerReadResult<T>> {
    const selection = await this.selectRoutes(filePath, serverId);
    if (selection.kind === "failure") return { failures: [selection.failure], successes: [] };
    const { routes } = selection;

    const outcomes = await Promise.all(
      routes.map(async (route): Promise<LspServerSuccess<T> | LspServerFailure | undefined> => {
        const resolution = await this.ensureClient(route);
        if (resolution.kind === "failure") return resolution.failure;
        if (!capability.isSupportedBy(resolution.instance.client)) {
          if (serverId === undefined) return undefined;
          return incapableServerFailure(route.serverId, capability);
        }
        return runServerOperation(resolution.instance, operation);
      }),
    );

    const failures: LspServerFailure[] = [];
    const successes: LspServerSuccess<T>[] = [];
    for (const outcome of outcomes) {
      if (outcome === undefined) continue;
      if ("code" in outcome) failures.push(outcome);
      else successes.push(outcome);
    }
    const incapableServerIds = routes
      .filter((_route, index) => outcomes[index] === undefined)
      .map((route) => route.serverId);
    if (successes.length === 0 && incapableServerIds.length > 0) {
      failures.push(noCapableServerFailure(capability, incapableServerIds));
    }
    return { failures, successes };
  }

  /** Resolve exactly one capable matching instance before a preview-producing mutation request. */
  private async resolveMutationClient(
    filePath: string,
    serverId: string | undefined,
    capability: LspCapabilityRequirement<TClient>,
  ): Promise<LspServerResolution<TClient>> {
    const selection = await this.selectRoutes(filePath, serverId);
    if (selection.kind === "failure") return selection;
    const { routes } = selection;

    const resolutions = await Promise.all(routes.map((route) => this.ensureClient(route)));
    const capable = resolutions.filter(
      (resolution): resolution is Extract<LspServerResolution<TClient>, { kind: "success" }> =>
        resolution.kind === "success" && capability.isSupportedBy(resolution.instance.client),
    );
    const onlyCapable = capable[0];
    if (onlyCapable !== undefined && capable.length === 1) return onlyCapable;
    if (capable.length > 1) {
      return {
        kind: "failure",
        failure: {
          code: "ambiguous-server",
          message: `Pi LSP: mutation matches multiple capable servers; provide server_id (${capable
            .map(({ instance }) => instance.route.serverId)
            .join(", ")})`,
          serverId: serverId ?? "*",
        },
      };
    }

    const unavailableResolution = resolutions.find(
      (resolution): resolution is Extract<LspServerResolution<TClient>, { kind: "failure" }> =>
        resolution.kind === "failure",
    );
    if (unavailableResolution !== undefined) return unavailableResolution;
    return {
      kind: "failure",
      failure:
        serverId === undefined
          ? noCapableServerFailure(
              capability,
              routes.map((route) => route.serverId),
            )
          : incapableServerFailure(serverId, capability),
    };
  }

  /**
   * Run one preview-producing request on exactly one capable matching instance. Like `runRead`,
   * an operation failure becomes a labeled `request-failed` or `request-timeout` failure, while an
   * `LspInputError` or a cancellation rejects.
   */
  async runMutation<T>(
    filePath: string,
    serverId: string | undefined,
    capability: LspCapabilityRequirement<TClient>,
    operation: (client: TClient, route: LspServerRoute) => Promise<T>,
  ): Promise<LspServerMutationResult<TClient, T>> {
    const resolution = await this.resolveMutationClient(filePath, serverId, capability);
    if (resolution.kind === "failure") return resolution;
    const { instance } = resolution;
    const outcome = await runServerOperation(instance, operation);
    if ("code" in outcome) return { kind: "failure", failure: outcome };
    return { kind: "success", instance, value: outcome.value };
  }

  /** Start one exact Server Instance and return its negotiated capabilities. */
  async getCapabilities(serverId: string, filePath: string): Promise<LspServerResolution<TClient>> {
    const selection = await this.selectRoutes(filePath, serverId);
    if (selection.kind === "failure") return selection;
    return this.ensureClient(selection.routes[0]);
  }

  /** Clear sticky failure state, stop the old process, and start the exact Server Instance again. */
  async restartServer(serverId: string, filePath: string): Promise<LspServerResolution<TClient>> {
    const selection = await this.selectRoutes(filePath, serverId);
    if (selection.kind === "failure") return selection;
    const route = selection.routes[0];
    if (!this.getEnablement(serverId).enabled) return this.ensureClient(route);
    this.knownRoutes.set(lspInstanceKey(serverId, route.rootPath), route);
    try {
      await this.stopServer(serverId, route.rootPath);
    } catch {
      // Restart still attempts a fresh process after an old failed client's cleanup error.
    }
    return this.ensureClient(route);
  }

  /** Stop one known Instance without preventing its next lazy startup. */
  async stopServer(serverId: string, rootPath: string): Promise<void> {
    const key = lspInstanceKey(serverId, resolve(this.input.cwd, normalizeLspFilePath(rootPath)));
    if (!this.knownRoutes.has(key)) {
      throw new Error(`Pi LSP: no known instance of ${serverId} for ${rootPath}`);
    }
    const existingStop = this.inFlightStops.get(key);
    if (existingStop !== undefined) return existingStop;
    const lifetime = this.instanceLifetimes.get(key);
    this.instanceLifetimes.delete(key);
    lifetime?.abort();
    const client = this.clients.get(key);
    this.clients.delete(key);
    this.unavailable.delete(key);
    const stop = (async () => {
      await this.inFlightStarts.get(key);
      await client?.shutdown();
    })();
    this.inFlightStops.set(key, stop);
    try {
      await stop;
    } finally {
      this.inFlightStops.delete(key);
    }
  }

  /** Gracefully stop every client once and clear all session-scoped instance state. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.knownRoutes.values()].map((route) =>
        this.stopServer(route.serverId, route.rootPath),
      ),
    );
    this.clients.clear();
    this.inFlightStarts.clear();
    this.instanceLifetimes.clear();
    this.unavailable.clear();
    this.knownRoutes.clear();
  }

  /**
   * Select the routes a request may use: `serverId`'s route, or every enabled matching route.
   * Without `serverId`, when no route applies and every Server Definition handling the file's
   * language is disabled, the failure is `server-disabled` naming them rather than no matching
   * server. An enabled definition excluded by its Activation Gate keeps that silent exclusion.
   */
  private async selectRoutes(
    filePath: string,
    serverId: string | undefined,
  ): Promise<LspRouteSelection> {
    const [first, ...rest] = await this.routeFile(filePath, serverId);
    if (first !== undefined) return { kind: "routes", routes: [first, ...rest] };
    if (serverId === undefined) {
      const languageServerIds = this.languageServerIds(filePath);
      if (
        languageServerIds.length > 0 &&
        languageServerIds.every((id) => !this.getEnablement(id).enabled)
      ) {
        return {
          kind: "failure",
          failure: {
            code: "server-disabled",
            message: `Pi LSP: all servers matching ${normalizeLspFilePath(filePath)} are disabled: ${languageServerIds.join(", ")}; enable one with /lsp enable <id>`,
            serverId: "*",
          },
        };
      }
    }
    return { kind: "failure", failure: this.noMatchingFailure(serverId, filePath) };
  }

  private noMatchingFailure(serverId: string | undefined, filePath: string): LspServerFailure {
    const normalizedFilePath = normalizeLspFilePath(filePath);
    const definition =
      serverId === undefined ? undefined : this.input.settings.servers.get(serverId);
    if (
      definition?.requireRootMarker === true &&
      definition.languages.some((language) => languageMatchesFile(language, normalizedFilePath))
    ) {
      return {
        code: "root-marker-not-found",
        message: `Pi LSP: required root marker not found for server ${definition.id} and ${normalizedFilePath}; expected one of: ${definition.rootMarkers.join(", ")}`,
        serverId: definition.id,
      };
    }
    let message: string;
    if (serverId === undefined) {
      message = `Pi LSP: no configured server matches ${normalizedFilePath}`;
    } else if (definition === undefined) {
      message = `Pi LSP: server ${serverId} is not configured`;
    } else {
      message = `Pi LSP: server ${serverId} does not match ${normalizedFilePath}`;
    }
    return { code: "no-matching-server", message, serverId: serverId ?? "*" };
  }

  private ensureClient(route: LspServerRoute): Promise<LspServerResolution<TClient>> {
    if (this.closed) {
      return Promise.resolve({
        kind: "failure",
        failure: unavailableFailure(route, "session runtime is shut down"),
      });
    }
    if (!this.getEnablement(route.serverId).enabled) {
      return Promise.resolve({
        kind: "failure",
        failure: {
          code: "server-disabled",
          message: `Pi LSP: server ${route.serverId} is disabled; enable it with /lsp enable ${route.serverId} first`,
          serverId: route.serverId,
        },
      });
    }
    const key = lspInstanceKey(route.serverId, route.rootPath);
    const stopping = this.inFlightStops.get(key);
    if (stopping !== undefined) {
      return stopping.then(
        () => this.ensureClient(route),
        (cause): LspServerResolution<TClient> => ({
          kind: "failure",
          failure: unavailableFailure(route, describeLspError(cause)),
        }),
      );
    }
    this.knownRoutes.set(key, route);
    const unavailableReason = this.unavailable.get(key);
    if (unavailableReason !== undefined) {
      return Promise.resolve({
        kind: "failure",
        failure: unavailableFailure(route, unavailableReason),
      });
    }
    const client = this.clients.get(key);
    const definition = this.input.settings.servers.get(route.serverId);
    if (client !== undefined && definition !== undefined) {
      return Promise.resolve({
        kind: "success",
        instance: { client, definition, route },
      });
    }
    const inFlight = this.inFlightStarts.get(key);
    if (inFlight !== undefined) return inFlight;
    if (definition === undefined) {
      return Promise.resolve({
        kind: "failure",
        failure: this.noMatchingFailure(route.serverId, route.rootPath),
      });
    }

    const lifetime = new AbortController();
    this.instanceLifetimes.set(key, lifetime);
    const start = this.startClient(key, route, definition, lifetime);
    this.inFlightStarts.set(key, start);
    void start.finally(() => {
      if (this.inFlightStarts.get(key) === start) this.inFlightStarts.delete(key);
    });
    return start;
  }

  private async startClient(
    key: string,
    route: LspServerRoute,
    definition: LspServerDefinition,
    lifetime: AbortController,
  ): Promise<LspServerResolution<TClient>> {
    try {
      const client = await this.input.startClient({
        definition,
        onUnavailable: (error) => {
          if (this.instanceLifetimes.get(key) === lifetime) {
            this.unavailable.set(key, describeLspError(error));
          }
        },
        rootPath: route.rootPath,
        signal: lifetime.signal,
        timeouts: this.input.settings.timeouts,
      });
      if (this.instanceLifetimes.get(key) !== lifetime) {
        await client.shutdown();
        return {
          kind: "failure",
          failure: unavailableFailure(route, "Instance was stopped during startup"),
        };
      }
      const failure = this.unavailable.get(key);
      if (failure !== undefined) {
        await client.shutdown().catch(() => {});
        return { kind: "failure", failure: unavailableFailure(route, failure) };
      }
      this.clients.set(key, client);
      return { kind: "success", instance: { client, definition, route } };
    } catch (error) {
      const message = describeLspError(error);
      if (this.instanceLifetimes.get(key) === lifetime) this.unavailable.set(key, message);
      return { kind: "failure", failure: unavailableFailure(route, message) };
    }
  }
}
