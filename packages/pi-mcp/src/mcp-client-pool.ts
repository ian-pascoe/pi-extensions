import { createHmac, randomBytes } from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import type {
  McpHostClient,
  McpHostClientEvents,
  McpHostPrompt,
  McpHostRequestContext,
  McpOwnedHostClient,
  McpHostResource,
  McpHostResourceTemplate,
  McpHostServerTool,
} from "./mcp-host.js";
import { MCP_SHUTDOWN_TIMEOUT_MS, type McpServerDefinition } from "./pi-mcp-settings.js";

const DEFAULT_MCP_CLIENT_HANDOFF_MS = 30_000;
const MCP_CLIENT_POOL_ABI = 1;

/** Why one Pi session releases its exclusive pooled MCP Client lease. */
export type McpSessionLeaseReleaseReason = "handoff" | "quit";

interface McpClientPoolFingerprintOptions {
  readonly connectTimeoutMs: number;
  readonly definition: McpServerDefinition;
  readonly projectRoot: string;
  readonly projectTrusted: boolean;
  readonly requestTimeoutMs: number;
}

/** Effective project configuration reconciled before one session acquires clients. */
export interface McpClientPoolProjectOptions {
  readonly connectTimeoutMs: number;
  readonly definitions: readonly McpServerDefinition[];
  readonly projectRoot: string;
  readonly projectTrusted: boolean;
  readonly requestTimeoutMs: number;
}

/** Effective project and Server Definition values used to acquire one MCP Client lease. */
export interface McpClientPoolAcquireOptions extends McpClientPoolFingerprintOptions {
  /** Create the physical MCP Client with pool-owned event routing. */
  readonly connect: (events: McpHostClientEvents) => Promise<McpOwnedHostClient>;
  /** Session-owned callbacks active only while this lease is current. */
  readonly events: McpHostClientEvents;
}

/** Exclusive binding between one session-owned MCP Host and one pooled MCP Client. */
export interface McpClientLease {
  readonly connectedAt: number;
  readonly reused: boolean;
  /** Resolve a guarded client view only while this Session Lease remains current. */
  connectedClient(): Promise<McpHostClient>;
  /** Release this session, reconciling optional connection state before handoff. */
  release(
    reason: McpSessionLeaseReleaseReason,
    reconcile?: (client: McpHostClient) => Promise<void>,
  ): Promise<void>;
}

interface ActiveMcpClientLease {
  readonly abort: AbortController;
  readonly events: McpHostClientEvents;
  readonly operations: Set<Promise<unknown>>;
  readonly token: symbol;
  releasePromise?: Promise<void>;
  releasing: boolean;
}

interface PooledMcpClientEntry {
  readonly clientPromise: Promise<McpOwnedHostClient>;
  authenticationBindingKey?: string;
  readonly key: string;
  readonly projectRoot: string;
  readonly scopeKey: string;
  readonly serverId: string;
  promptCatalog?: Promise<readonly McpHostPrompt[]>;
  resourceCatalog?: Promise<readonly McpHostResource[]>;
  resourceTemplateCatalog?: Promise<readonly McpHostResourceTemplate[]>;
  toolCatalog?: Promise<readonly McpHostServerTool[]>;
  closed: boolean;
  closing: boolean;
  connectedAt?: number;
  expiry?: ReturnType<typeof setTimeout>;
  lease?: ActiveMcpClientLease;
}

function sortedMcpStringEntries(
  values: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
}

function mcpClientPoolScopeKey(options: McpClientPoolFingerprintOptions): string {
  return JSON.stringify([options.projectRoot, options.definition.id]);
}

function mcpClientPoolAuthFingerprint(definition: McpServerDefinition): object | null {
  if (definition.transport === "stdio" || definition.auth === undefined) return null;
  if (definition.auth.type === "bearer") {
    return { token: definition.auth.token, type: definition.auth.type };
  }
  if (definition.auth.type === "none") return { type: definition.auth.type };
  return {
    clientId: definition.auth.clientId ?? null,
    clientSecret: definition.auth.clientSecret ?? null,
    redirectUri: definition.auth.redirectUri ?? null,
    scopes: definition.auth.scopes,
    type: definition.auth.type,
  };
}

function mcpAuthenticationBinding(definition: McpServerDefinition): string | undefined {
  if (
    definition.transport === "stdio" ||
    definition.auth?.type === "none" ||
    definition.auth?.type === "bearer"
  ) {
    return undefined;
  }
  return JSON.stringify([
    new URL(definition.url).href,
    definition.auth?.clientId ?? "@ian-pascoe/pi-mcp",
  ]);
}

function mcpClientPoolFingerprint(options: McpClientPoolFingerprintOptions): string {
  const definition =
    options.definition.transport === "stdio"
      ? {
          args: options.definition.args,
          command: options.definition.command,
          cwd: options.definition.cwd ?? null,
          enabled: options.definition.enabled,
          environment: sortedMcpStringEntries(options.definition.environment),
          id: options.definition.id,
          provenance: options.definition.provenance,
          transport: options.definition.transport,
        }
      : {
          auth: mcpClientPoolAuthFingerprint(options.definition),
          enabled: options.definition.enabled,
          headers: sortedMcpStringEntries(options.definition.headers),
          id: options.definition.id,
          provenance: options.definition.provenance,
          transport: options.definition.transport,
          url: options.definition.url,
        };
  return JSON.stringify({
    abi: MCP_CLIENT_POOL_ABI,
    connectTimeoutMs: options.connectTimeoutMs,
    definition,
    projectRoot: options.projectRoot,
    projectTrusted: options.projectTrusted,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}

/** Owns reusable physical MCP Clients while keeping every Pi Session Lease exclusive. */
export class McpClientPool {
  private readonly entries = new Map<string, Set<PooledMcpClientEntry>>();
  private disposed = false;
  private readonly handoffGraceMs: number;
  private readonly salt: Uint8Array;

  /** Create a process-local pool with a bounded session handoff grace period. */
  constructor(options: { readonly handoffGraceMs?: number; readonly salt?: Uint8Array } = {}) {
    this.handoffGraceMs = options.handoffGraceMs ?? DEFAULT_MCP_CLIENT_HANDOFF_MS;
    this.salt = options.salt ?? randomBytes(32);
  }

  /** Whether this pool still accepts acquisitions after process-registry replacement. */
  get isActive(): boolean {
    return !this.disposed;
  }

  /** Close every physical client retained by this process-local pool. */
  async closeAll(): Promise<void> {
    this.disposed = true;
    const entries = [...this.entries.values()].flatMap((group) => [...group]);
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry, true)));
  }

  /** Close clients that use one persisted OAuth URL/client-identity binding. */
  async invalidateAuthentication(definition: McpServerDefinition): Promise<void> {
    const key = this.authenticationBindingKey(definition);
    if (key === undefined) return;
    const entries = [...this.entries.values()]
      .flatMap((group) => [...group])
      .filter((entry) => entry.authenticationBindingKey === key);
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry, true)));
  }

  /** Close every client backed by persisted OAuth authentication. */
  async invalidateAllAuthentication(): Promise<void> {
    const entries = [...this.entries.values()]
      .flatMap((group) => [...group])
      .filter((entry) => entry.authenticationBindingKey !== undefined);
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry, true)));
  }

  /** Close clients for one project and optional Server Definition. */
  async invalidate(projectRoot: string, serverId?: string): Promise<void> {
    const entries = [...this.entries.values()]
      .flatMap((group) => [...group])
      .filter(
        (entry) =>
          entry.projectRoot === projectRoot &&
          (serverId === undefined || entry.serverId === serverId),
      );
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry, true)));
  }

  /** Close project clients absent from or changed in the next session configuration. */
  async reconcileProject(options: McpClientPoolProjectOptions): Promise<void> {
    if (this.disposed) return;
    const desired = new Map(
      options.definitions
        .filter((definition) => definition.enabled)
        .map((definition) => {
          const fingerprintOptions: McpClientPoolFingerprintOptions = {
            connectTimeoutMs: options.connectTimeoutMs,
            definition,
            projectRoot: options.projectRoot,
            projectTrusted: options.projectTrusted,
            requestTimeoutMs: options.requestTimeoutMs,
          };
          return [
            mcpClientPoolScopeKey(fingerprintOptions),
            this.fingerprint(fingerprintOptions),
          ] as const;
        }),
    );
    const stale = [...this.entries.values()]
      .flatMap((group) => [...group])
      .filter(
        (entry) =>
          entry.projectRoot === options.projectRoot && desired.get(entry.scopeKey) !== entry.key,
      );
    await Promise.allSettled(stale.map((entry) => this.closeEntry(entry, true)));
  }

  /** Acquire an unleased matching client or start one new physical connection. */
  acquire(options: McpClientPoolAcquireOptions): McpClientLease {
    if (this.disposed) throw new Error("Pi MCP Client Pool is closed");
    const scopeKey = mcpClientPoolScopeKey(options);
    const key = this.fingerprint(options);
    const staleEntries = [...this.entries.values()]
      .flatMap((entries) => [...entries])
      .filter((entry) => entry.scopeKey === scopeKey && entry.key !== key);
    for (const entry of staleEntries) void this.closeEntry(entry, true);

    const entries = this.entries.get(key) ?? new Set<PooledMcpClientEntry>();
    this.entries.set(key, entries);
    const reusable = [...entries].find((entry) => !entry.closed && entry.lease === undefined);
    const entry = reusable ?? this.createEntry(key, scopeKey, options);
    if (reusable === undefined) entries.add(entry);
    if (entry.expiry !== undefined) {
      clearTimeout(entry.expiry);
      delete entry.expiry;
    }
    const active: ActiveMcpClientLease = {
      abort: new AbortController(),
      events: options.events,
      operations: new Set(),
      releasing: false,
      token: Symbol("MCP Session Lease"),
    };
    entry.lease = active;
    return {
      get connectedAt() {
        return entry.connectedAt ?? Date.now();
      },
      reused: reusable !== undefined,
      connectedClient: async () => {
        const client = await entry.clientPromise;
        if (entry.lease?.token !== active.token) {
          throw new Error("Pi MCP Session Lease was released before connection completed");
        }
        return this.createLeaseClient(entry, active.token, client);
      },
      release: (reason, reconcile) => this.releaseEntry(entry, active.token, reason, reconcile),
    };
  }

  private authenticationBindingKey(definition: McpServerDefinition): string | undefined {
    const binding = mcpAuthenticationBinding(definition);
    if (binding === undefined) return undefined;
    return createHmac("sha256", this.salt).update(`auth\0${binding}`).digest("hex");
  }

  private fingerprint(options: McpClientPoolFingerprintOptions): string {
    return createHmac("sha256", this.salt).update(mcpClientPoolFingerprint(options)).digest("hex");
  }

  private createEntry(
    key: string,
    scopeKey: string,
    options: McpClientPoolAcquireOptions,
  ): PooledMcpClientEntry {
    const connection = Promise.withResolvers<McpOwnedHostClient>();
    const authenticationBindingKey = this.authenticationBindingKey(options.definition);
    const entry: PooledMcpClientEntry = {
      clientPromise: connection.promise,
      closed: false,
      closing: false,
      key,
      projectRoot: options.projectRoot,
      scopeKey,
      serverId: options.definition.id,
    };
    if (authenticationBindingKey !== undefined) {
      entry.authenticationBindingKey = authenticationBindingKey;
    }
    const currentEvents = (): McpHostClientEvents | undefined => {
      const active = entry.lease;
      return active?.releasing === false ? active.events : undefined;
    };
    const events: McpHostClientEvents = {
      onCatalogChanged: (kind, toolNames) => {
        if (kind === "prompts") delete entry.promptCatalog;
        else if (kind === "resources") delete entry.resourceCatalog;
        else if (kind === "resourceTemplates") delete entry.resourceTemplateCatalog;
        else delete entry.toolCatalog;
        return currentEvents()?.onCatalogChanged(kind, toolNames);
      },
      onClose: () => {
        const expected = entry.closing;
        entry.closed = true;
        entry.closing = true;
        this.removeEntry(entry);
        if (!expected) currentEvents()?.onClose();
      },
      onError: (error) => {
        currentEvents()?.onError(error);
        if (error instanceof UnauthorizedError) void this.closeEntry(entry, true);
      },
      onLog: (message) => currentEvents()?.onLog(message),
      onResourceUpdated: (uri) => currentEvents()?.onResourceUpdated(uri),
    };
    void Promise.resolve()
      .then(() => options.connect(events))
      .then(
        (client) => {
          entry.connectedAt = Date.now();
          connection.resolve(client);
        },
        (cause: unknown) => {
          entry.closed = true;
          this.removeEntry(entry);
          connection.reject(cause);
        },
      );
    return entry;
  }

  private createLeaseClient(
    entry: PooledMcpClientEntry,
    token: symbol,
    client: McpHostClient,
  ): McpHostClient {
    const activeLease = (): ActiveMcpClientLease => {
      const active = entry.lease;
      if (active?.token !== token || active.releasing) {
        throw new Error("Pi MCP Session Lease is no longer active");
      }
      return active;
    };
    const track = <Result>(
      operation: () => Promise<Result>,
      drainOnRelease = true,
    ): Promise<Result> => {
      let active: ActiveMcpClientLease;
      try {
        active = activeLease();
      } catch (cause) {
        return Promise.reject(cause);
      }
      let result: Promise<Result>;
      try {
        result = operation();
      } catch (cause) {
        return Promise.reject(cause);
      }
      if (drainOnRelease) active.operations.add(result);
      void result.then(
        () => {
          if (drainOnRelease) active.operations.delete(result);
        },
        (cause: unknown) => {
          if (drainOnRelease) active.operations.delete(result);
          if (cause instanceof UnauthorizedError) {
            try {
              active.events.onError(cause);
            } catch {
              // Session-owned callback failures cannot retain an unauthorized client.
            }
            void this.closeEntry(entry, true);
          }
        },
      );
      return result;
    };
    const cachedCatalog = <Item>(
      read: () => Promise<readonly Item[]> | undefined,
      write: (catalog: Promise<readonly Item[]>) => void,
      clear: () => void,
      load: () => Promise<readonly Item[]>,
    ): Promise<readonly Item[]> => {
      const cached = read();
      if (cached !== undefined) return cached;
      const pending = load();
      write(pending);
      void pending.catch(() => {
        if (read() === pending) clear();
      });
      return pending;
    };
    const requestContext = <PiContext>(
      context: McpHostRequestContext<PiContext> | undefined,
    ): McpHostRequestContext<PiContext> => {
      const leaseSignal = activeLease().abort.signal;
      const signal =
        context?.signal === undefined
          ? leaseSignal
          : AbortSignal.any([context.signal, leaseSignal]);
      return context === undefined ? { signal } : { ...context, signal };
    };
    return {
      capabilities: client.capabilities,
      instructions: client.instructions,
      callTool: (name, args, context) =>
        track(() => client.callTool(name, args, requestContext(context))),
      completePromptArgument: (promptName, argumentName, value) =>
        track(() => client.completePromptArgument(promptName, argumentName, value)),
      getPrompt: (name, args, context) =>
        track(() => client.getPrompt(name, args, requestContext(context))),
      listPrompts: () =>
        track(
          () =>
            cachedCatalog(
              () => entry.promptCatalog,
              (catalog) => {
                entry.promptCatalog = catalog;
              },
              () => delete entry.promptCatalog,
              () => client.listPrompts(),
            ),
          false,
        ),
      listResources: () =>
        track(
          () =>
            cachedCatalog(
              () => entry.resourceCatalog,
              (catalog) => {
                entry.resourceCatalog = catalog;
              },
              () => delete entry.resourceCatalog,
              () => client.listResources(),
            ),
          false,
        ),
      listResourceTemplates: () =>
        track(
          () =>
            cachedCatalog(
              () => entry.resourceTemplateCatalog,
              (catalog) => {
                entry.resourceTemplateCatalog = catalog;
              },
              () => delete entry.resourceTemplateCatalog,
              () => client.listResourceTemplates(),
            ),
          false,
        ),
      listTools: () =>
        track(
          () =>
            cachedCatalog(
              () => entry.toolCatalog,
              (catalog) => {
                entry.toolCatalog = catalog;
              },
              () => delete entry.toolCatalog,
              () => client.listTools(),
            ),
          false,
        ),
      readResource: (uri, context) =>
        track(() => client.readResource(uri, requestContext(context))),
      subscribeResource: (uri) => track(() => client.subscribeResource(uri)),
      unsubscribeResource: (uri) => track(() => client.unsubscribeResource(uri)),
    };
  }

  private releaseEntry(
    entry: PooledMcpClientEntry,
    token: symbol,
    reason: McpSessionLeaseReleaseReason,
    reconcile?: (client: McpHostClient) => Promise<void>,
  ): Promise<void> {
    const active = entry.lease;
    if (active?.token !== token) return Promise.resolve();
    if (active.releasePromise !== undefined) return active.releasePromise;
    active.releasing = true;
    active.abort.abort(new Error("Pi MCP Session Lease released"));
    const deadline = Date.now() + MCP_SHUTDOWN_TIMEOUT_MS;
    active.releasePromise = (async () => {
      const operationResults = Promise.allSettled(active.operations);
      const drained = await this.settleBefore(operationResults, deadline);
      let canRetain =
        drained && (await operationResults).every((result) => result.status === "fulfilled");
      if (canRetain && reason === "handoff" && reconcile !== undefined) {
        const reconciliation = entry.clientPromise.then(reconcile).then(
          () => true,
          () => false,
        );
        const reconciled = await this.settleBefore(reconciliation, deadline);
        canRetain = reconciled && (await reconciliation);
      }
      if (entry.lease?.token !== token) return;
      delete entry.lease;
      if (entry.closing) return;
      if (!canRetain) {
        void this.closeEntry(entry);
        return;
      }
      if (reason === "quit") {
        await this.settleBefore(this.closeEntry(entry), deadline);
        return;
      }
      entry.expiry = setTimeout(() => void this.closeEntry(entry), this.handoffGraceMs);
      entry.expiry.unref();
    })();
    return active.releasePromise;
  }

  private async closeEntry(entry: PooledMcpClientEntry, notifyLease = false): Promise<void> {
    if (entry.closing) return;
    entry.closing = true;
    entry.closed = true;
    const deadline = Date.now() + MCP_SHUTDOWN_TIMEOUT_MS;
    const active = entry.lease;
    const notifyClose =
      notifyLease && active !== undefined ? () => active.events.onClose() : undefined;
    if (active !== undefined) {
      active.releasing = true;
      active.abort.abort(new Error("Pi MCP Client invalidated"));
      await this.settleBefore(Promise.allSettled(active.operations), deadline);
      if (entry.lease === active) delete entry.lease;
    }
    if (entry.expiry !== undefined) clearTimeout(entry.expiry);
    this.removeEntry(entry);
    const closing = entry.clientPromise.then((client) => client.close()).catch(() => undefined);
    await this.settleBefore(closing, deadline);
    try {
      notifyClose?.();
    } catch {
      // Session-owned callback failures cannot retain an invalid client.
    }
  }

  private async settleBefore(work: Promise<unknown>, deadline: number): Promise<boolean> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const timeout = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => timeout.resolve(false), remainingMs);
    timer.unref();
    try {
      return await Promise.race([
        work.then(
          () => true,
          () => true,
        ),
        timeout.promise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private removeEntry(entry: PooledMcpClientEntry): void {
    const entries = this.entries.get(entry.key);
    entries?.delete(entry);
    if (entries?.size === 0) this.entries.delete(entry.key);
  }
}

interface ProcessMcpClientPoolSlot {
  readonly abi: number;
  readonly close: () => Promise<void>;
  readonly isActive: () => boolean;
  readonly pool: McpClientPool;
}

declare global {
  // eslint-disable-next-line no-var -- Replacement Pi extension instances need one process-wide MCP Client Pool.
  var piMcpClientPoolProcessSlot: ProcessMcpClientPoolSlot | undefined;
}

/** Return the ABI-compatible MCP Client Pool shared by Pi instances in this process. */
export async function processMcpClientPool(): Promise<McpClientPool> {
  const current = globalThis.piMcpClientPoolProcessSlot;
  if (current?.abi === MCP_CLIENT_POOL_ABI && current.isActive()) return current.pool;
  const pool = new McpClientPool();
  globalThis.piMcpClientPoolProcessSlot = {
    abi: MCP_CLIENT_POOL_ABI,
    close: () => pool.closeAll(),
    isActive: () => pool.isActive,
    pool,
  };
  void current?.close().catch(() => undefined);
  return pool;
}
