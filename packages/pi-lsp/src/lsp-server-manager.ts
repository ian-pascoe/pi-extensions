import { readdir } from "node:fs/promises";
import { basename, dirname, extname, matchesGlob, resolve } from "node:path";
import type { LspServerDefinition, LspTimeouts, ResolvedLspSettings } from "./pi-lsp-settings.js";

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
  /** Resolved request and lifecycle timeout policy. */
  readonly timeouts: LspTimeouts;
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
  | "server-unavailable";

/** Preserves one matching server's failure without discarding sibling successes. */
export interface LspServerFailure {
  /** Stable machine-readable failure class. */
  readonly code: LspServerFailureCode;
  /** Searchable caller-facing error prefixed with `Pi LSP:`. */
  readonly message: string;
  /** Selected workspace root when routing reached a concrete Server Instance. */
  readonly rootPath?: string;
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
  /** Labeled failures in deterministic route order. */
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
  /** Workspace root for a resolved instance; absent before any file routes to the server. */
  readonly rootPath?: string;
  /** Configured server ID. */
  readonly serverId: string;
  /** Session lifecycle state. */
  readonly state: "configured" | "running" | "starting" | "unavailable";
}

/** Reports configuration failures and session-scoped Server Instance states. */
export interface LspServerManagerStatus {
  /** False when either authored `lsp` settings layer was malformed. */
  readonly enabled: boolean;
  /** Server entries ordered by ID and then root. */
  readonly servers: readonly LspServerStatusEntry[];
  /** Strict settings failures kept visible until Pi `/reload`. */
  readonly warnings: readonly string[];
}

/** Construction inputs for one session-scoped language-server manager. */
export interface LspServerManagerInput<TClient extends LspManagedServerClient> {
  /** Pi session working directory used for relative paths and root fallback. */
  readonly cwd: string;
  /** Fully parsed trust-aware LSP settings. */
  readonly settings: ResolvedLspSettings;
  /** Concrete process/client constructor owned by the LSP client module. */
  readonly startClient: StartLspServerClient<TClient>;
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

function findNearestLspRoot(
  rootMarkers: readonly string[] | undefined,
  ancestorDirectories: readonly LspAncestorDirectory[],
  cwd: string,
): string {
  if (rootMarkers === undefined || rootMarkers.length === 0) return resolve(cwd);
  for (const directory of ancestorDirectories) {
    if (
      directory.entryNames.some((entryName) =>
        rootMarkers.some((rootMarker) => matchesGlob(entryName, rootMarker)),
      )
    ) {
      return directory.path;
    }
  }
  return resolve(cwd);
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
    routes.push({
      serverId: serverDefinition.serverId,
      language,
      rootPath: findNearestLspRoot(serverDefinition.rootMarkers, ancestorDirectories, cwd),
    });
  }

  return routes;
}

function describeLspError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function lspInstanceKey(serverId: string, rootPath: string): string {
  return JSON.stringify([serverId, rootPath]);
}

async function readLspAncestorDirectories(filePath: string): Promise<LspAncestorDirectory[]> {
  const directories: LspAncestorDirectory[] = [];
  let currentDirectory = dirname(filePath);
  for (;;) {
    let entryNames: string[] = [];
    try {
      entryNames = await readdir(currentDirectory);
    } catch {
      // A target can be newly created; continue upward until an existing ancestor is found.
    }
    directories.push({ entryNames, path: currentDirectory });
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return directories;
    currentDirectory = parentDirectory;
  }
}

function unavailableFailure(route: LspServerRoute, error: string): LspServerFailure {
  return {
    code: "server-unavailable",
    message: `Pi LSP: server ${route.serverId} is unavailable for ${route.rootPath}: ${error}`,
    rootPath: route.rootPath,
    serverId: route.serverId,
  };
}

/** Own lazy Server Instance creation, routing, failure state, restart, and session shutdown. */
export class LspServerManager<TClient extends LspManagedServerClient = LspManagedServerClient> {
  private readonly clients = new Map<string, TClient>();
  private readonly inFlightStarts = new Map<string, Promise<LspServerResolution<TClient>>>();
  private readonly knownRoutes = new Map<string, LspServerRoute>();
  private readonly unavailable = new Map<string, string>();

  /** Bind parsed settings and one concrete client constructor to the current Pi session. */
  constructor(private readonly input: LspServerManagerInput<TClient>) {}

  /** Return configuration and known instance state without starting a server. */
  getStatus(): LspServerManagerStatus {
    const servers: LspServerStatusEntry[] = [];
    for (const [serverId] of this.input.settings.servers) {
      const routes = [...this.knownRoutes.entries()]
        .filter(([, route]) => route.serverId === serverId)
        .sort(([, left], [, right]) => left.rootPath.localeCompare(right.rootPath));
      if (routes.length === 0) {
        servers.push({ serverId, state: "configured" });
        continue;
      }
      for (const [key, route] of routes) {
        const error = this.unavailable.get(key);
        if (error !== undefined) {
          servers.push({ error, rootPath: route.rootPath, serverId, state: "unavailable" });
        } else if (this.inFlightStarts.has(key)) {
          servers.push({ rootPath: route.rootPath, serverId, state: "starting" });
        } else if (this.clients.has(key)) {
          servers.push({ rootPath: route.rootPath, serverId, state: "running" });
        } else {
          servers.push({ rootPath: route.rootPath, serverId, state: "configured" });
        }
      }
    }
    return {
      enabled: this.input.settings.enabled,
      servers,
      warnings: this.input.settings.warnings,
    };
  }

  /** Resolve all matching Server Definitions and nearest roots without starting clients. */
  async routeFile(filePath: string): Promise<readonly LspServerRoute[]> {
    if (!this.input.settings.enabled) return [];
    const absolutePath = resolve(this.input.cwd, normalizeLspFilePath(filePath));
    const ancestors = await readLspAncestorDirectories(absolutePath);
    const definitions = [...this.input.settings.servers.values()].map((definition) => ({
      languages: definition.languages,
      rootMarkers: definition.rootMarkers,
      serverId: definition.id,
    }));
    return routeLspServersForFile(definitions, absolutePath, this.input.cwd, ancestors);
  }

  /** Query every matching capable instance while retaining independent successes and failures. */
  async runRead<T>(
    filePath: string,
    serverId: string | undefined,
    isCapable: (client: TClient) => boolean,
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
      routes.map(async (route): Promise<LspServerSuccess<T> | LspServerFailure> => {
        const resolution = await this.ensureClient(route);
        if (resolution.kind === "failure") return resolution.failure;
        if (!isCapable(resolution.instance.client)) {
          return {
            code: "no-capable-server",
            message: `Pi LSP: server ${route.serverId} does not support the requested operation`,
            rootPath: route.rootPath,
            serverId: route.serverId,
          };
        }
        try {
          return {
            rootPath: route.rootPath,
            serverId: route.serverId,
            value: await operation(resolution.instance.client, route),
          };
        } catch (error) {
          return {
            code: "request-failed",
            message: `Pi LSP: server ${route.serverId} request failed: ${describeLspError(error)}`,
            rootPath: route.rootPath,
            serverId: route.serverId,
          };
        }
      }),
    );

    const failures: LspServerFailure[] = [];
    const successes: LspServerSuccess<T>[] = [];
    for (const outcome of outcomes) {
      if ("code" in outcome) failures.push(outcome);
      else successes.push(outcome);
    }
    return { failures, successes };
  }

  /** Resolve exactly one capable matching instance before a preview-producing mutation request. */
  async resolveMutationClient(
    filePath: string,
    serverId: string | undefined,
    isCapable: (client: TClient) => boolean,
  ): Promise<LspServerResolution<TClient>> {
    const routes = await this.selectRoutes(filePath, serverId);
    if (routes.length === 0) {
      return { kind: "failure", failure: this.noMatchingFailure(serverId, filePath) };
    }

    const resolutions = await Promise.all(routes.map((route) => this.ensureClient(route)));
    const capable = resolutions.filter(
      (resolution): resolution is Extract<LspServerResolution<TClient>, { kind: "success" }> =>
        resolution.kind === "success" && isCapable(resolution.instance.client),
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
      failure: {
        code: "no-capable-server",
        message: "Pi LSP: no matching server supports the requested mutation",
        serverId: serverId ?? "*",
      },
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
    const key = lspInstanceKey(route.serverId, route.rootPath);
    const inFlight = this.inFlightStarts.get(key);
    if (inFlight !== undefined) await inFlight;
    const client = this.clients.get(key);
    this.clients.delete(key);
    this.unavailable.delete(key);
    if (client !== undefined) {
      try {
        await client.shutdown();
      } catch {
        // Restart still attempts a fresh process after an old failed client's cleanup error.
      }
    }
    return this.ensureClient(route);
  }

  /** Gracefully stop every client once and clear all session-scoped instance state. */
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.inFlightStarts.values());
    const clients = [...new Set(this.clients.values())];
    this.clients.clear();
    this.inFlightStarts.clear();
    this.unavailable.clear();
    this.knownRoutes.clear();
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }

  private async selectRoutes(
    filePath: string,
    serverId: string | undefined,
  ): Promise<readonly LspServerRoute[]> {
    const routes = await this.routeFile(filePath);
    return serverId === undefined ? routes : routes.filter((route) => route.serverId === serverId);
  }

  private noMatchingFailure(serverId: string | undefined, filePath: string): LspServerFailure {
    const requestedServer = serverId === undefined ? "any configured server" : `server ${serverId}`;
    return {
      code: "no-matching-server",
      message: `Pi LSP: ${requestedServer} does not match ${normalizeLspFilePath(filePath)}`,
      serverId: serverId ?? "*",
    };
  }

  private ensureClient(route: LspServerRoute): Promise<LspServerResolution<TClient>> {
    const key = lspInstanceKey(route.serverId, route.rootPath);
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

    const start = this.startClient(key, route, definition);
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
  ): Promise<LspServerResolution<TClient>> {
    try {
      const client = await this.input.startClient({
        definition,
        onUnavailable: (error) => {
          this.unavailable.set(key, describeLspError(error));
        },
        rootPath: route.rootPath,
        timeouts: this.input.settings.timeouts,
      });
      const failure = this.unavailable.get(key);
      if (failure !== undefined) {
        await client.shutdown().catch(() => {});
        return { kind: "failure", failure: unavailableFailure(route, failure) };
      }
      this.clients.set(key, client);
      return { kind: "success", instance: { client, definition, route } };
    } catch (error) {
      const message = describeLspError(error);
      this.unavailable.set(key, message);
      return { kind: "failure", failure: unavailableFailure(route, message) };
    }
  }
}
