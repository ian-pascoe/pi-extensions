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
  /** Nearest matching ancestor directory, or the caller's working directory. */
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
  /** Nearest workspace root selected for this Server Instance. */
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
   * its directory limit before checking every directory.
   */
  readonly hasMore: boolean;
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
  /** Home directory that bounds other-root discovery; defaults to the user's home directory. */
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

function findNearestLspRoot(
  rootMarkers: readonly string[] | undefined,
  ancestorDirectories: readonly LspAncestorDirectory[],
  cwd: string,
  requireRootMarker: boolean,
): string | undefined {
  if (rootMarkers === undefined || rootMarkers.length === 0) {
    return requireRootMarker ? undefined : resolve(cwd);
  }
  for (const directory of ancestorDirectories) {
    if (containsLspRootMarker(directory.entryNames, rootMarkers)) {
      return directory.path;
    }
  }
  return requireRootMarker ? undefined : resolve(cwd);
}

/** Route one file to every matching configured server in stable settings-map order. */
export function routeLspServersForFile(
  serverDefinitions: readonly LspServerRoutingDefinition[],
  filePath: string,
  cwd: string,
  ancestorDirectories: readonly LspAncestorDirectory[],
): readonly LspServerRoute[] {
  const normalizedFilePath = normalizeLspFilePath(filePath);
  const routes: LspServerRoute[] = [];

  for (const serverDefinition of serverDefinitions) {
    const language = serverDefinition.languages.find((candidate) =>
      languageMatchesFile(candidate, normalizedFilePath),
    );
    if (language === undefined) continue;
    const rootPath = findNearestLspRoot(
      serverDefinition.rootMarkers,
      ancestorDirectories,
      cwd,
      serverDefinition.requireRootMarker ?? false,
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

/**
 * List directories under `baseDirectory` (itself included) that contain a root marker, breadth
 * first in name order, skipping hidden and dependency directories and symbolic links. Discovery
 * stops once `maxRoots` roots other than `excludedRoot` are found or `directoryLimit` directories
 * were listed; `complete` reports whether every directory was checked.
 */
async function discoverLspMarkerRoots(
  baseDirectory: string,
  rootMarkers: readonly string[],
  excludedRoot: string,
  maxRoots: number,
  directoryLimit: number,
): Promise<{ readonly roots: readonly string[]; readonly complete: boolean }> {
  const roots: string[] = [];
  const queue = [baseDirectory];
  let listed = 0;
  while (queue.length > 0 && roots.length < maxRoots) {
    if (listed === directoryLimit) return { roots, complete: false };
    const directory = queue.shift();
    if (directory === undefined) break;
    listed++;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (
      directory !== excludedRoot &&
      containsLspRootMarker(
        entries.map(({ name }) => name),
        rootMarkers,
      )
    ) {
      roots.push(directory);
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !ROOT_DISCOVERY_SKIPPED_DIRECTORIES.has(entry.name)
      ) {
        queue.push(resolve(directory, entry.name));
      }
    }
  }
  return { roots, complete: true };
}

function isSameOrAncestorDirectory(ancestor: string, descendant: string): boolean {
  const relativePath = relative(ancestor, descendant);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

/**
 * Pick where marker-root discovery starts for `searchedRoot`: its outermost ancestor (itself
 * included) that holds a root marker, or the working directory when that is a higher ancestor.
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
    if (
      isSameOrAncestorDirectory(directory, homeDirectory) &&
      !isSameOrAncestorDirectory(cwd, directory)
    ) {
      return base;
    }
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
    // root markers to find. Marker-free candidates root at the working directory.
    const ancestors = candidates.some((definition) => definition.rootMarkers.length > 0)
      ? await readLspAncestorDirectories(absolutePath, this.input.readDirectory ?? readdir)
      : [];
    const definitions = candidates.map((definition) => ({
      languages: definition.languages,
      requireRootMarker: definition.requireRootMarker,
      rootMarkers: definition.rootMarkers,
      serverId: definition.id,
    }));
    return routeLspServersForFile(definitions, absolutePath, this.input.cwd, ancestors);
  }

  /** Report whether any Server Definition accepts the file language before activation gating. */
  hasConfiguredLanguageServerForFile(filePath: string): boolean {
    const absolutePath = resolve(this.input.cwd, normalizeLspFilePath(filePath));
    return [...this.input.settings.servers.values()].some((definition) =>
      definition.languages.some((language) => languageMatchesFile(language, absolutePath)),
    );
  }

  /**
   * Find workspace roots of one Server Definition other than `rootPath`: roots of its known Server
   * Instances, and directories that contain one of its root markers under the outermost ancestor
   * of `rootPath` that has one (or under the working directory, when that is higher). Files under
   * those roots route to other Server Instances, so a request to the instance at `rootPath` may
   * not consider them. Hidden and `node_modules` directories are not searched, and discovery
   * lists at most `rootDiscoveryDirectoryLimit` directories.
   */
  async findOtherWorkspaceRoots(
    serverId: string,
    rootPath: string,
  ): Promise<LspOtherWorkspaceRoots> {
    const searchedRoot = resolve(this.input.cwd, rootPath);
    const maxRoots = LSP_OTHER_WORKSPACE_ROOT_LIMIT + 1;
    const roots = new Set(
      [...this.knownRoutes.values()]
        .filter((route) => route.serverId === serverId && route.rootPath !== searchedRoot)
        .map((route) => route.rootPath),
    );
    const rootMarkers = this.input.settings.servers.get(serverId)?.rootMarkers ?? [];
    let complete = true;
    if (roots.size < maxRoots && rootMarkers.length > 0) {
      const discoveryBase = await findLspDiscoveryBase(
        searchedRoot,
        rootMarkers,
        resolve(this.input.cwd),
        resolve(this.input.homeDirectory ?? homedir()),
        this.input.readDirectory ?? readdir,
      );
      const discovery = await discoverLspMarkerRoots(
        discoveryBase,
        rootMarkers,
        searchedRoot,
        maxRoots,
        this.input.rootDiscoveryDirectoryLimit ?? LSP_ROOT_DISCOVERY_DIRECTORY_LIMIT,
      );
      for (const root of discovery.roots) roots.add(root);
      complete = discovery.complete;
    }
    const sorted = [...roots].sort((left, right) => left.localeCompare(right));
    return {
      rootPaths: sorted.slice(0, LSP_OTHER_WORKSPACE_ROOT_LIMIT),
      hasMore: sorted.length > LSP_OTHER_WORKSPACE_ROOT_LIMIT || !complete,
    };
  }

  /**
   * Query matching capable instances while retaining independent operational failures. An
   * `LspInputError` from `operation` rejects the whole read: it is the caller's to fix, not a
   * server failure.
   */
  async runRead<T>(
    filePath: string,
    serverId: string | undefined,
    capability: LspCapabilityRequirement<TClient>,
    operation: (client: TClient, route: LspServerRoute) => Promise<T>,
  ): Promise<LspServerReadResult<T>> {
    const routes = await this.selectRoutes(filePath, serverId);
    if (routes.length === 0) {
      return {
        failures: [this.noMatchingFailure(serverId, filePath)],
        successes: [],
      };
    }

    const outcomes = await Promise.all(
      routes.map(async (route): Promise<LspServerSuccess<T> | LspServerFailure | undefined> => {
        const resolution = await this.ensureClient(route);
        if (resolution.kind === "failure") return resolution.failure;
        if (!capability.isSupportedBy(resolution.instance.client)) {
          if (serverId === undefined) return undefined;
          return incapableServerFailure(route.serverId, capability);
        }
        try {
          return {
            rootPath: route.rootPath,
            serverId: route.serverId,
            value: await operation(resolution.instance.client, route),
          };
        } catch (error) {
          if (error instanceof LspInputError) throw error;
          return {
            code:
              error instanceof LspServerClientError && error.kind === "timeout"
                ? "request-timeout"
                : "request-failed",
            message: `Pi LSP: server ${route.serverId} request failed: ${describeLspError(error)}`,
            serverId: route.serverId,
          };
        }
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
  async resolveMutationClient(
    filePath: string,
    serverId: string | undefined,
    capability: LspCapabilityRequirement<TClient>,
  ): Promise<LspServerResolution<TClient>> {
    const routes = await this.selectRoutes(filePath, serverId);
    if (routes.length === 0) {
      return { kind: "failure", failure: this.noMatchingFailure(serverId, filePath) };
    }

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

  /** Start one exact Server Instance and return its negotiated capabilities. */
  async getCapabilities(serverId: string, filePath: string): Promise<LspServerResolution<TClient>> {
    const routes = await this.selectRoutes(filePath, serverId);
    const route = routes[0];
    if (route === undefined) {
      return { kind: "failure", failure: this.noMatchingFailure(serverId, filePath) };
    }
    return this.ensureClient(route);
  }

  /** Clear sticky failure state, stop the old process, and start the exact Server Instance again. */
  async restartServer(serverId: string, filePath: string): Promise<LspServerResolution<TClient>> {
    const routes = await this.selectRoutes(filePath, serverId);
    const route = routes[0];
    if (route === undefined) {
      return { kind: "failure", failure: this.noMatchingFailure(serverId, filePath) };
    }
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

  private async selectRoutes(
    filePath: string,
    serverId: string | undefined,
  ): Promise<readonly LspServerRoute[]> {
    const routes = await this.routeFile(filePath, serverId);
    return routes.filter((route) =>
      serverId === undefined
        ? this.getEnablement(route.serverId).enabled
        : route.serverId === serverId,
    );
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
