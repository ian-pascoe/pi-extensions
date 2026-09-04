import { setTimeout as sleep } from "node:timers/promises";
import {
  ProtocolError,
  RegistrationRejectedError,
  SdkError,
  SdkErrorCode,
  UnauthorizedError,
  type AuthProvider,
  type Client,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import type { McpClientLease, McpClientPool } from "./mcp-client-pool.js";
import {
  McpServerClient,
  type McpServerClientConnectOptions,
  type McpServerRunOptions,
} from "./mcp-server-client.js";
import type { McpSessionFiles } from "./mcp-session-files.js";
import type { McpServerDefinition, ResolvedMcpSettings } from "./pi-mcp-settings.js";

const MCP_CATALOG_CHANGE_DEBOUNCE_MS = 50;
const MCP_LOG_FLUSH_BYTES = 64 * 1024;
const MCP_LOG_FLUSH_INTERVAL_MS = 50;

const TERMINAL_MCP_SDK_ERROR_CODES: ReadonlySet<SdkErrorCode> = new Set([
  SdkErrorCode.CapabilityNotSupported,
  SdkErrorCode.InvalidResult,
  SdkErrorCode.UnsupportedResultType,
  SdkErrorCode.MethodNotSupportedByProtocolVersion,
  SdkErrorCode.EraNegotiationFailed,
  SdkErrorCode.ClientHttpNotImplemented,
  SdkErrorCode.ClientHttpUnexpectedContent,
]);

/** Clock boundary used for retry and first-request deadlines. */
export interface McpHostClock {
  readonly now: number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const systemClock: McpHostClock = {
  get now() {
    return Date.now();
  },
  sleep: (milliseconds, signal) => sleep(milliseconds, undefined, { signal }),
};

/** Core capabilities negotiated with one MCP Server. */
export interface McpHostClientCapabilities {
  readonly logging?: boolean;
  readonly prompts?: boolean;
  readonly resources?: boolean;
  readonly resourceSubscriptions?: boolean;
  readonly resourceTemplates?: boolean;
  readonly tools?: boolean;
}

/** Core capability names queried by Pi tool activation. */
export type McpHostCapabilityName = keyof McpHostClientCapabilities;

/** Structurally validated Server Tool retained without rewriting its JSON Schemas. */
export type McpHostServerTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** One advertised MCP Resource. */
export type McpHostResource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];

/** One advertised MCP Resource Template. */
export type McpHostResourceTemplate = Awaited<
  ReturnType<Client["listResourceTemplates"]>
>["resourceTemplates"][number];

/** One advertised MCP Prompt. */
export type McpHostPrompt = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number];

/** Arguments accepted by one Server Tool call. */
export type McpHostToolArguments = NonNullable<Parameters<Client["callTool"]>[0]["arguments"]>;

/** Result of calling one Server Tool. */
export type McpHostCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** Request-local Pi context and Host callbacks for an active MCP operation. */
export type McpHostRequestContext<PiContext> = McpServerRunOptions<PiContext>;

/** Result of reading one Resource. */
export type McpHostReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;

/** Role-faithful Prompt expansion returned by one MCP Server. */
export type McpHostGetPromptResult = Awaited<ReturnType<Client["getPrompt"]>>;

/** Prompt argument completion candidates. */
export type McpHostCompletionResult = Awaited<ReturnType<Client["complete"]>>["completion"];

/** Notifications and transport signals delivered to the owning Host. */
export interface McpHostClientEvents {
  onCatalogChanged(kind: McpHostCatalogKind, toolNames?: readonly string[]): Promise<void> | void;
  onClose(): void;
  onError(error: Error): void;
  onLog(message: string): Promise<void> | void;
  onResourceUpdated(uri: string): Promise<void> | void;
}

/** Narrow connected-client boundary used by the Host and fake wire fixtures. */
export interface McpHostClient {
  readonly capabilities: McpHostClientCapabilities;
  readonly instructions: string | undefined;
  callTool<PiContext = undefined>(
    name: string,
    args: McpHostToolArguments,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostCallToolResult>;
  completePromptArgument(
    promptName: string,
    argumentName: string,
    value: string,
  ): Promise<McpHostCompletionResult>;
  getPrompt<PiContext = undefined>(
    name: string,
    args?: Readonly<Record<string, string>>,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostGetPromptResult>;
  listPrompts(): Promise<readonly McpHostPrompt[]>;
  listResources(): Promise<readonly McpHostResource[]>;
  listResourceTemplates(): Promise<readonly McpHostResourceTemplate[]>;
  listTools(): Promise<readonly McpHostServerTool[]>;
  readResource<PiContext = undefined>(
    uri: string,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostReadResourceResult>;
  subscribeResource(uri: string): Promise<void>;
  unsubscribeResource(uri: string): Promise<void>;
}

/** Physical MCP Client owned only by a factory or the process MCP Client Pool. */
export interface McpOwnedHostClient extends McpHostClient {
  close(): Promise<void>;
}

/** Authentication provider resolved from stored credentials for one remote Server. */
export type McpHostAuthProvider = AuthProvider | OAuthClientProvider;

/** Inputs for acquiring one connected MCP Client. */
export interface McpHostClientConnectOptions {
  readonly authProvider?: McpHostAuthProvider;
  readonly definition: McpServerDefinition;
  readonly events: McpHostClientEvents;
  readonly serverId: string;
}

/** Acquires the single client owned by one Server Definition. */
export interface McpHostClientFactory {
  connect(options: McpHostClientConnectOptions): Promise<McpOwnedHostClient>;
}

/** Catalog refreshed by its matching MCP notification. */
export type McpHostCatalogKind = "prompts" | "resources" | "resourceTemplates" | "tools";

/** Why one session-owned MCP Host releases its acquired clients. */
export type McpHostShutdownReason = "handoff" | "quit";

/** Live status of one configured MCP Server. */
export type McpServerStatus =
  | { readonly state: "disabled" }
  | { readonly attempt: number; readonly state: "connecting" }
  | {
      readonly connectionAgeMs?: number;
      readonly reused?: boolean;
      readonly state: "connected";
    }
  | { readonly error: string; readonly state: "needs_auth" }
  | { readonly error: string; readonly state: "needs_client_registration" }
  | {
      readonly attempt: number;
      readonly delayMs: number;
      readonly error: string;
      readonly retryAt: number;
      readonly state: "retrying";
    }
  | { readonly attempts: number; readonly error: string; readonly state: "failed" };

/** Expected live MCP Host lookup or capability failure returned to command adapters. */
export class McpHostOperationError extends Error {}

interface McpHostCatalogItem<Item> {
  readonly item: Item;
  readonly serverId: string;
}

/** Provenance-labelled Resource. */
export interface McpHostResourceItem {
  readonly resource: McpHostResource;
  readonly serverId: string;
}

/** Provenance-labelled Resource Template. */
export interface McpHostResourceTemplateItem {
  readonly resourceTemplate: McpHostResourceTemplate;
  readonly serverId: string;
}

/** Provenance-labelled Prompt. */
export interface McpHostPromptItem {
  readonly prompt: McpHostPrompt;
  readonly serverId: string;
}

/** Provenance-labelled Server Tool. */
export interface McpHostToolItem {
  readonly serverId: string;
  readonly tool: McpHostServerTool;
}

/** One bounded human-facing stderr and MCP logging tail. */
export interface McpHostLogTail {
  /** Private session path containing the complete retained tail for this Server. */
  readonly path: string;
  readonly serverId: string;
  readonly text: string;
}

/** Desired Resource subscription persisted in the Pi session branch. */
export interface McpHostResourceSubscription {
  readonly serverId: string;
  readonly uri: string;
}

/** Immutable Server Instructions and tool names captured for one model request. */
export interface McpInstructionSnapshot {
  readonly capturedAt: number;
  readonly text: string;
}

interface McpHostBaseOptions {
  readonly clientFactory?: McpHostClientFactory;
  readonly clock?: McpHostClock;
  readonly initialSubscriptions?: readonly McpHostResourceSubscription[];
  readonly onCatalogChanged?: (serverId: string, kind: McpHostCatalogKind) => Promise<void> | void;
  readonly onResourceUpdated?: (update: McpHostResourceSubscription) => void;
  /** Observe copied, sorted status after each status or Server Definition change. */
  readonly onStatusChange?: (statuses: ReadonlyMap<string, McpServerStatus>) => void;
  readonly persistSubscriptions?: (
    subscriptions: readonly McpHostResourceSubscription[],
  ) => Promise<void> | void;
  readonly piCwd: string;
  readonly resolveAuthProvider?: (
    definition: Extract<McpServerDefinition, { readonly transport: "http" | "sse" }>,
  ) => McpHostAuthProvider | undefined | Promise<McpHostAuthProvider | undefined>;
  readonly sessionFiles: McpSessionFiles;
  readonly settings: ResolvedMcpSettings;
}

/** Construction boundaries for one session-owned MCP Host. */
export type McpHostOptions = McpHostBaseOptions &
  (
    | {
        readonly clientPool?: undefined;
        readonly projectRoot?: never;
        readonly projectTrusted?: never;
      }
    | {
        readonly clientPool: McpClientPool;
        readonly projectRoot: string;
        readonly projectTrusted: boolean;
      }
  );

interface PendingMcpCatalogChange {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type PendingMcpLogFlush = PendingMcpCatalogChange;

interface McpHostServerEntry {
  definition: McpServerDefinition;
  instructionToolNames: readonly string[];
  toolCatalog?: Promise<readonly McpHostServerTool[]>;
  client?: McpHostClient;
  ownedClient?: McpOwnedHostClient;
  connectionReused?: boolean;
  connectionStartedAt?: number;
  lease?: McpClientLease;
  failures: number;
  generation: number;
  toolCatalogReady: boolean;
  pending?: Promise<void>;
  retryAbort?: AbortController;
  status: McpServerStatus;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

class SdkMcpHostClient implements McpOwnedHostClient {
  private constructor(
    private readonly owner: McpServerClient,
    readonly capabilities: McpHostClientCapabilities,
    readonly instructions: string | undefined,
  ) {}

  static async connect(
    definition: McpServerDefinition,
    events: McpHostClientEvents,
    options: Pick<McpHostOptions, "piCwd" | "settings">,
    authProvider: McpHostAuthProvider | undefined,
  ): Promise<SdkMcpHostClient> {
    const notifyCatalogChanged = (
      error: Error | null,
      kind: McpHostCatalogKind,
      toolNames?: readonly string[],
    ): void => {
      if (error !== null) {
        events.onError(error);
        return;
      }
      void events.onCatalogChanged(kind, toolNames);
    };
    const listChanged = {
      prompts: {
        autoRefresh: true,
        debounceMs: MCP_CATALOG_CHANGE_DEBOUNCE_MS,
        onChanged: (error) => notifyCatalogChanged(error, "prompts"),
      },
      resources: {
        autoRefresh: true,
        debounceMs: MCP_CATALOG_CHANGE_DEBOUNCE_MS,
        onChanged: (error) => {
          notifyCatalogChanged(error, "resources");
          if (error === null) notifyCatalogChanged(null, "resourceTemplates");
        },
      },
      tools: {
        autoRefresh: true,
        debounceMs: MCP_CATALOG_CHANGE_DEBOUNCE_MS,
        onChanged: (error, tools) =>
          notifyCatalogChanged(
            error,
            "tools",
            tools?.map((tool) => tool.name),
          ),
      },
    } satisfies NonNullable<McpServerClientConnectOptions["listChanged"]>;
    const connectOptions = {
      clientInfo: { name: "@ian-pascoe/pi-mcp", version: "0.1.0" },
      connectTimeoutMs: options.settings.connectTimeoutMs,
      definition,
      listChanged,
      onConnectionClose: () => events.onClose(),
      onError: (error: Error) => events.onError(error),
      onStderr: (text: string) => void events.onLog(text),
      piCwd: options.piCwd,
      requestTimeoutMs: options.settings.requestTimeoutMs,
    };
    const owner = await McpServerClient.connect(
      authProvider === undefined ? connectOptions : { ...connectOptions, authProvider },
    );
    const capabilities = await owner.run(async (client) => {
      const advertised = client.getServerCapabilities();
      client.setNotificationHandler("notifications/resources/updated", (notification) =>
        events.onResourceUpdated(notification.params.uri),
      );
      client.setNotificationHandler("notifications/message", (notification) =>
        events.onLog(JSON.stringify(notification.params)),
      );
      return {
        logging: advertised?.logging !== undefined,
        prompts: advertised?.prompts !== undefined,
        resources: advertised?.resources !== undefined,
        resourceSubscriptions: advertised?.resources?.subscribe === true,
        resourceTemplates: advertised?.resources !== undefined,
        tools: advertised?.tools !== undefined,
      };
    });
    return new SdkMcpHostClient(owner, capabilities, owner.instructions);
  }

  callTool<PiContext = undefined>(
    name: string,
    args: McpHostToolArguments,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostCallToolResult> {
    return this.owner.run(
      (client, requestOptions) => client.callTool({ arguments: { ...args }, name }, requestOptions),
      context,
    );
  }

  close(): Promise<void> {
    return this.owner.close();
  }

  completePromptArgument(
    promptName: string,
    argumentName: string,
    value: string,
  ): Promise<McpHostCompletionResult> {
    return this.owner.run(async (client, requestOptions) => {
      const result = await client.complete(
        {
          argument: { name: argumentName, value },
          ref: { name: promptName, type: "ref/prompt" },
        },
        requestOptions,
      );
      return result.completion;
    });
  }

  getPrompt<PiContext = undefined>(
    name: string,
    args?: Readonly<Record<string, string>>,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostGetPromptResult> {
    return this.owner.run(async (client, requestOptions) => {
      const result = await client.getPrompt(
        args === undefined ? { name } : { arguments: { ...args }, name },
        requestOptions,
      );
      return result;
    }, context);
  }

  listPrompts(): Promise<readonly McpHostPrompt[]> {
    return this.owner.run((client, requestOptions) =>
      client.listPrompts(undefined, requestOptions).then((result) => result.prompts),
    );
  }

  listResources(): Promise<readonly McpHostResource[]> {
    return this.owner.run((client, requestOptions) =>
      client.listResources(undefined, requestOptions).then((result) => result.resources),
    );
  }

  listResourceTemplates(): Promise<readonly McpHostResourceTemplate[]> {
    return this.owner.run((client, requestOptions) =>
      client
        .listResourceTemplates(undefined, requestOptions)
        .then((result) => result.resourceTemplates),
    );
  }

  listTools(): Promise<readonly McpHostServerTool[]> {
    return this.owner.run((client, requestOptions) =>
      client.listTools(undefined, requestOptions).then((result) => result.tools),
    );
  }

  readResource<PiContext = undefined>(
    uri: string,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostReadResourceResult> {
    return this.owner.run(
      (client, requestOptions) => client.readResource({ uri }, requestOptions),
      context,
    );
  }

  subscribeResource(uri: string): Promise<void> {
    return this.owner.run(async (client, requestOptions) => {
      await client.subscribeResource({ uri }, requestOptions);
    });
  }

  unsubscribeResource(uri: string): Promise<void> {
    return this.owner.run(async (client, requestOptions) => {
      await client.unsubscribeResource({ uri }, requestOptions);
    });
  }
}

/** Session-owned MCP server registry, catalogs, subscriptions, retries, and cleanup. */
export class McpHost {
  private readonly clock: McpHostClock;
  private readonly clientFactory: McpHostClientFactory;
  private readonly entries = new Map<string, McpHostServerEntry>();
  private readonly pendingCatalogChanges = new Map<string, PendingMcpCatalogChange>();
  private readonly pendingLogs = new Map<string, string[]>();
  private readonly subscriptions = new Set<string>();
  private initialConnections: readonly Promise<void>[] = [];
  private pendingLogBytes = 0;
  private pendingLogFlush: PendingMcpLogFlush | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private started = false;
  private shuttingDown = false;

  constructor(private readonly options: McpHostOptions) {
    this.clock = options.clock ?? systemClock;
    this.clientFactory = options.clientFactory ?? {
      connect: ({ authProvider, definition, events }) =>
        SdkMcpHostClient.connect(definition, events, options, authProvider),
    };
    for (const definition of options.settings.servers.values()) {
      this.entries.set(definition.id, {
        definition,
        failures: 0,
        instructionToolNames: [],
        generation: 0,
        toolCatalogReady: false,
        status: { state: "disabled" },
      });
    }
    for (const subscription of options.initialSubscriptions ?? []) {
      this.subscriptions.add(this.subscriptionKey(subscription.serverId, subscription.uri));
    }
    this.publishStatuses();
  }

  /** Launch enabled Server connections without awaiting network or process startup. */
  start(): void {
    if (this.started || this.shuttingDown) return;
    this.started = true;
    this.initialConnections = [...this.entries.values()].flatMap((entry) => {
      if (!entry.definition.enabled) {
        this.setEntryStatus(entry, { state: "disabled" });
        return [];
      }
      return [this.connectEntry(entry)];
    });
  }

  /** Wait only for each initial connection attempt, not scheduled retries. */
  async waitForInitialConnections(): Promise<void> {
    await Promise.allSettled(this.initialConnections);
  }

  /** Return a snapshot of one server's current status. */
  getStatus(serverId: string): McpServerStatus | undefined {
    const entry = this.entries.get(serverId);
    return entry === undefined ? undefined : this.statusSnapshot(entry);
  }

  /** Return every server status in deterministic Server Definition order. */
  listStatuses(): ReadonlyMap<string, McpServerStatus> {
    return new Map(
      [...this.entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([serverId, entry]) => [serverId, this.statusSnapshot(entry)]),
    );
  }

  /** Return desired Resource subscriptions without sending an MCP request. */
  listSubscriptions(): readonly McpHostResourceSubscription[] {
    return [...this.subscriptions]
      .map((key) => {
        const separator = key.indexOf("\0");
        return { serverId: key.slice(0, separator), uri: key.slice(separator + 1) };
      })
      .sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) || left.uri.localeCompare(right.uri),
      );
  }

  /** Whether one or any connected MCP Server advertises a core capability. */
  hasConnectedCapability(capability: McpHostCapabilityName, serverId?: string): boolean {
    return this.connectedEntries(serverId).some(
      (entry) => entry.client?.capabilities[capability] === true,
    );
  }

  /** Call one Server Tool with request-scoped callbacks, cancellation, and progress. */
  callTool<PiContext = undefined>(
    serverId: string,
    name: string,
    args: McpHostToolArguments,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostCallToolResult> {
    const client = this.requireConnectedClient(serverId, "tools");
    return client.callTool(name, args, context);
  }

  /** Return native SDK-listed Server Tools with provenance. */
  async listTools(serverId?: string): Promise<readonly McpHostToolItem[]> {
    return (
      await this.listCatalog(
        "tools",
        (client, entry) => this.cachedServerTools(entry, client),
        serverId,
      )
    ).map(({ item, serverId: id }) => ({ serverId: id, tool: item }));
  }

  /** Return native SDK-listed Resources with provenance. */
  async listResources(serverId?: string): Promise<readonly McpHostResourceItem[]> {
    return (await this.listCatalog("resources", (client) => client.listResources(), serverId)).map(
      ({ item, serverId: id }) => ({ resource: item, serverId: id }),
    );
  }

  /** Return native SDK-listed Resource Templates with provenance. */
  async listResourceTemplates(serverId?: string): Promise<readonly McpHostResourceTemplateItem[]> {
    return (
      await this.listCatalog(
        "resourceTemplates",
        (client) => client.listResourceTemplates(),
        serverId,
      )
    ).map(({ item, serverId: id }) => ({ resourceTemplate: item, serverId: id }));
  }

  /** Return native SDK-listed Prompts with provenance. */
  async listPrompts(serverId?: string): Promise<readonly McpHostPromptItem[]> {
    return (await this.listCatalog("prompts", (client) => client.listPrompts(), serverId)).map(
      ({ item, serverId: id }) => ({ prompt: item, serverId: id }),
    );
  }

  /** Read bounded stderr and MCP logging tails without adding them to model context. */
  async readLogs(serverId?: string): Promise<readonly McpHostLogTail[]> {
    const entries =
      serverId === undefined ? [...this.entries.values()] : [this.requireEntry(serverId)];
    return Promise.all(
      entries
        .sort((left, right) => left.definition.id.localeCompare(right.definition.id))
        .map(async (entry) => ({
          ...(await this.options.sessionFiles.readServerLog(entry.definition.id)),
          serverId: entry.definition.id,
        })),
    );
  }

  /** Read one Resource without injecting it into the model through a background path. */
  readResource<PiContext = undefined>(
    serverId: string,
    uri: string,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostReadResourceResult> {
    return this.requireConnectedClient(serverId, "resources").readResource(uri, context);
  }

  /** Expand one MCP Prompt through the explicitly addressed server. */
  getPrompt<PiContext = undefined>(
    serverId: string,
    name: string,
    args?: Readonly<Record<string, string>>,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostGetPromptResult> {
    return this.requireConnectedClient(serverId, "prompts").getPrompt(name, args, context);
  }

  /** Complete one MCP Prompt argument through protocol completion. */
  completePromptArgument(
    serverId: string,
    promptName: string,
    argumentName: string,
    value: string,
  ): Promise<McpHostCompletionResult> {
    return this.requireConnectedClient(serverId, "prompts").completePromptArgument(
      promptName,
      argumentName,
      value,
    );
  }

  /** Persist and establish one desired Resource subscription. */
  async subscribeResource(serverId: string, uri: string): Promise<void> {
    const client = this.requireConnectedClient(serverId, "resourceSubscriptions");
    await client.subscribeResource(uri);
    this.subscriptions.add(this.subscriptionKey(serverId, uri));
    await this.persistSubscriptions();
  }

  /** Remove one desired Resource subscription after the server acknowledges it. */
  async unsubscribeResource(serverId: string, uri: string): Promise<void> {
    const client = this.requireConnectedClient(serverId, "resourceSubscriptions");
    await client.unsubscribeResource(uri);
    this.subscriptions.delete(this.subscriptionKey(serverId, uri));
    await this.persistSubscriptions();
  }

  /** Add or replace one Server Definition and apply it to the current session immediately. */
  async upsertServer(definition: McpServerDefinition): Promise<void> {
    const existing = this.entries.get(definition.id);
    const entry = existing ?? {
      definition,
      failures: 0,
      generation: 0,
      instructionToolNames: [],
      toolCatalogReady: false,
      status: { state: "disabled" as const },
    };
    if (existing !== undefined) await this.stopEntry(existing, "MCP Server Definition replaced");
    entry.definition = definition;
    entry.failures = 0;
    this.entries.set(definition.id, entry);
    if (!this.started || !definition.enabled || this.shuttingDown) {
      this.setEntryStatus(entry, { state: "disabled" });
      return;
    }
    await this.connectEntry(entry);
  }

  /** Disable one Server Definition and close its current or pending connection. */
  async disableServer(serverId: string): Promise<void> {
    const entry = this.requireEntry(serverId);
    await this.stopEntry(entry, "MCP Server disabled");
    entry.definition = { ...entry.definition, enabled: false };
    entry.failures = 0;
  }

  /** Remove one Server Definition and every ephemeral runtime value it owns. */
  async removeServer(serverId: string): Promise<void> {
    const entry = this.requireEntry(serverId);
    await this.stopEntry(entry, "MCP Server removed");
    this.entries.delete(serverId);
    this.publishStatuses();
    const prefix = `${serverId}\0`;
    for (const subscription of this.subscriptions) {
      if (subscription.startsWith(prefix)) this.subscriptions.delete(subscription);
    }
    await this.persistSubscriptions();
  }

  /** Reconnect one configured Server immediately, cancelling any pending retry. */
  async reconnect(serverId: string): Promise<void> {
    const entry = this.requireEntry(serverId);
    await this.stopEntry(entry, "MCP reconnect requested");
    entry.failures = 0;
    if (!entry.definition.enabled) return;
    await this.connectEntry(entry);
  }

  /** Snapshot Server Instructions for model-ready MCP Servers without waiting for startup. */
  instructionSnapshot(): McpInstructionSnapshot {
    const sections = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.toolCatalogReady &&
          entry.client !== undefined &&
          entry.status.state === "connected",
      )
      .sort((left, right) => left.definition.id.localeCompare(right.definition.id))
      .flatMap((entry) => {
        const instructions = entry.client?.instructions?.trim();
        const toolNames = [...entry.instructionToolNames].sort();
        if (instructions === undefined && toolNames.length === 0) return [];
        return [
          [
            `## MCP Server: ${entry.definition.id}`,
            instructions === undefined ? undefined : instructions,
            toolNames.length === 0 ? undefined : `Tools: ${toolNames.join(", ")}`,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n"),
        ];
      });
    return {
      capturedAt: this.clock.now,
      text: sections.join("\n\n"),
    };
  }

  /** Release or close acquired clients, stop retries, and remove session files. */
  shutdown(reason: McpHostShutdownReason = "quit"): Promise<void> {
    this.shutdownPromise ??= this.shutdownOwnedResources(reason);
    return this.shutdownPromise;
  }

  private connectEntry(entry: McpHostServerEntry): Promise<void> {
    const generation = ++entry.generation;
    let ownedClient: McpOwnedHostClient | undefined;
    entry.toolCatalogReady = false;
    entry.retryAbort?.abort(new Error("MCP connection attempt replaced"));
    delete entry.retryAbort;
    this.setEntryStatus(entry, { attempt: entry.failures + 1, state: "connecting" });
    const pending = Promise.resolve()
      .then(async () => {
        const authProvider =
          entry.definition.transport === "stdio"
            ? undefined
            : await this.options.resolveAuthProvider?.(entry.definition);
        if (this.shuttingDown || generation !== entry.generation) {
          throw new Error("MCP connection cancelled during shutdown");
        }
        const events: McpHostClientEvents = {
          onCatalogChanged: async (kind, toolNames) => {
            if (kind === "tools") delete entry.toolCatalog;
            await this.notifyCatalogChanged(entry, kind);
            if (
              kind === "tools" &&
              toolNames !== undefined &&
              !this.shuttingDown &&
              generation === entry.generation
            ) {
              entry.instructionToolNames = [...toolNames];
            }
          },
          onClose: () => this.handleUnexpectedClose(entry, generation),
          onError: (error) => this.handleClientError(entry, generation, error),
          onLog: (message) => this.recordLog(entry.definition.id, message),
          onResourceUpdated: async (uri) => {
            try {
              this.options.onResourceUpdated?.({ serverId: entry.definition.id, uri });
            } catch (cause) {
              await this.recordLog(entry.definition.id, errorMessage(cause));
            }
          },
        };
        const connect = (connectionEvents: McpHostClientEvents): Promise<McpOwnedHostClient> => {
          const connectOptions: McpHostClientConnectOptions = {
            definition: entry.definition,
            events: connectionEvents,
            serverId: entry.definition.id,
          };
          return this.clientFactory.connect(
            authProvider === undefined ? connectOptions : { ...connectOptions, authProvider },
          );
        };
        if (this.options.clientPool === undefined) {
          return connect(events).then((client) => {
            ownedClient = client;
            return client;
          });
        }
        const lease = this.options.clientPool.acquire({
          connect,
          connectTimeoutMs: this.options.settings.connectTimeoutMs,
          definition: entry.definition,
          events,
          projectRoot: this.options.projectRoot,
          projectTrusted: this.options.projectTrusted,
          requestTimeoutMs: this.options.settings.requestTimeoutMs,
        });
        entry.lease = lease;
        entry.connectionReused = lease.reused;
        return lease.connectedClient();
      })
      .then(async (client) => {
        if (this.shuttingDown || generation !== entry.generation) {
          await ownedClient?.close();
          return;
        }
        entry.client = client;
        if (ownedClient !== undefined) entry.ownedClient = ownedClient;
        else if (entry.lease !== undefined) entry.connectionStartedAt = entry.lease.connectedAt;
        entry.failures = 0;
        this.setEntryStatus(entry, { state: "connected" });
        const initialized = await Promise.allSettled([
          this.loadInstructionToolNames(entry, client),
          this.restoreSubscriptions(entry),
        ]);
        if (this.shuttingDown || generation !== entry.generation || entry.client !== client) {
          return;
        }
        for (const result of initialized) {
          if (result.status === "rejected") {
            await this.recordLog(entry.definition.id, errorMessage(result.reason));
          }
        }
        await this.notifyCatalogChanged(entry, "tools");
        if (!this.shuttingDown && generation === entry.generation && entry.client === client) {
          entry.toolCatalogReady = true;
        }
      })
      .catch((cause: unknown) => {
        const lease = entry.lease;
        delete entry.lease;
        if (lease !== undefined) void lease.release("quit");
        if (this.shuttingDown || generation !== entry.generation) return;
        this.handleConnectionFailure(entry, cause);
      });
    entry.pending = pending;
    return pending;
  }

  private handleConnectionFailure(entry: McpHostServerEntry, cause: unknown): void {
    const message = this.options.settings.secrets.redact(errorMessage(cause));
    if (cause instanceof UnauthorizedError) {
      this.setEntryStatus(entry, { error: message, state: "needs_auth" });
    } else if (cause instanceof RegistrationRejectedError) {
      this.setEntryStatus(entry, { error: message, state: "needs_client_registration" });
    } else {
      entry.failures += 1;
      const terminal =
        cause instanceof ProtocolError ||
        (cause instanceof SdkError && TERMINAL_MCP_SDK_ERROR_CODES.has(cause.code));
      if (terminal || entry.failures > this.options.settings.retry.maxRetries) {
        this.setEntryStatus(entry, {
          attempts: entry.failures,
          error: message,
          state: "failed",
        });
      } else {
        const delayMs = Math.min(
          this.options.settings.retry.maxDelayMs,
          Math.round(
            this.options.settings.retry.initialDelayMs *
              this.options.settings.retry.backoffFactor ** (entry.failures - 1),
          ),
        );
        const retryAbort = new AbortController();
        entry.retryAbort = retryAbort;
        this.setEntryStatus(entry, {
          attempt: entry.failures + 1,
          delayMs,
          error: message,
          retryAt: this.clock.now + delayMs,
          state: "retrying",
        });
        void this.clock.sleep(delayMs, retryAbort.signal).then(
          () => {
            if (!this.shuttingDown && entry.retryAbort === retryAbort)
              void this.connectEntry(entry);
          },
          () => undefined,
        );
      }
    }
    void this.notifyCatalogChanged(entry, "tools");
  }

  private handleClientError(entry: McpHostServerEntry, generation: number, error: Error): void {
    void this.recordLog(entry.definition.id, error.message);
    if (
      !(error instanceof UnauthorizedError) ||
      this.shuttingDown ||
      generation !== entry.generation
    ) {
      return;
    }
    entry.generation += 1;
    const lease = entry.lease;
    const ownedClient = entry.ownedClient;
    delete entry.client;
    delete entry.connectionReused;
    delete entry.connectionStartedAt;
    delete entry.lease;
    delete entry.ownedClient;
    delete entry.toolCatalog;
    entry.instructionToolNames = [];
    entry.toolCatalogReady = false;
    if (lease === undefined) void ownedClient?.close();
    else void lease.release("quit");
    this.handleConnectionFailure(entry, error);
  }

  private handleUnexpectedClose(entry: McpHostServerEntry, generation: number): void {
    if (this.shuttingDown || generation !== entry.generation) return;
    const lease = entry.lease;
    delete entry.lease;
    if (lease !== undefined) void lease.release("quit");
    delete entry.client;
    delete entry.ownedClient;
    delete entry.connectionReused;
    delete entry.connectionStartedAt;
    delete entry.toolCatalog;
    entry.instructionToolNames = [];
    entry.toolCatalogReady = false;
    this.handleConnectionFailure(entry, new Error("MCP connection closed unexpectedly"));
  }

  private cachedServerTools(
    entry: McpHostServerEntry,
    client: McpHostClient,
  ): Promise<readonly McpHostServerTool[]> {
    if (entry.toolCatalog !== undefined) return entry.toolCatalog;
    const pending = client.listTools();
    entry.toolCatalog = pending;
    void pending.catch(() => {
      if (entry.toolCatalog === pending) delete entry.toolCatalog;
    });
    return pending;
  }

  private async loadInstructionToolNames(
    entry: McpHostServerEntry,
    client: McpHostClient,
  ): Promise<void> {
    if (client.capabilities.tools !== true) {
      entry.instructionToolNames = [];
      return;
    }
    const pending = this.cachedServerTools(entry, client);
    const tools = await pending;
    if (this.shuttingDown || entry.client !== client) return;
    if (entry.toolCatalog !== pending) {
      if (!this.shuttingDown && entry.client === client) {
        await this.loadInstructionToolNames(entry, client);
      }
      return;
    }
    entry.instructionToolNames = tools.map((tool) => tool.name);
  }

  private async listCatalog<Item extends { readonly name: string }>(
    capability: McpHostCapabilityName,
    list: (client: McpHostClient, entry: McpHostServerEntry) => Promise<readonly Item[]>,
    serverId?: string,
  ): Promise<readonly McpHostCatalogItem<Item>[]> {
    const catalogs = await Promise.all(
      this.connectedEntries(serverId).map(async (entry) => {
        const client = entry.client;
        if (client === undefined || client.capabilities[capability] !== true) return [];
        return (await list(client, entry)).map((item) => ({ item, serverId: entry.definition.id }));
      }),
    );
    return catalogs
      .flat()
      .sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) ||
          left.item.name.localeCompare(right.item.name),
      );
  }

  private connectedEntries(serverId: string | undefined): McpHostServerEntry[] {
    if (serverId !== undefined) {
      const entry = this.requireEntry(serverId);
      if (entry.status.state !== "connected" || entry.client === undefined) {
        throw new Error(`MCP Server ${serverId} is not connected`);
      }
      return [entry];
    }
    return [...this.entries.values()].filter(
      (entry) => entry.status.state === "connected" && entry.client !== undefined,
    );
  }

  private requireConnectedClient(
    serverId: string,
    capability: keyof McpHostClientCapabilities,
  ): McpHostClient {
    const entry = this.requireEntry(serverId);
    const client = entry.client;
    if (client === undefined || entry.status.state !== "connected") {
      throw new McpHostOperationError(`MCP Server ${serverId} is not connected`);
    }
    if (client.capabilities[capability] !== true) {
      throw new McpHostOperationError(`MCP Server ${serverId} does not support ${capability}`);
    }
    return client;
  }

  private requireEntry(serverId: string): McpHostServerEntry {
    const entry = this.entries.get(serverId);
    if (entry === undefined) throw new McpHostOperationError(`Unknown MCP Server ${serverId}`);
    return entry;
  }

  private async restoreSubscriptions(entry: McpHostServerEntry): Promise<void> {
    const client = entry.client;
    if (client?.capabilities.resourceSubscriptions !== true) return;
    const prefix = `${entry.definition.id}\0`;
    const uris = [...this.subscriptions]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
    await Promise.all(uris.map((uri) => client.subscribeResource(uri)));
  }

  private subscriptionKey(serverId: string, uri: string): string {
    return `${serverId}\0${uri}`;
  }

  private async persistSubscriptions(): Promise<void> {
    await this.options.persistSubscriptions?.(this.listSubscriptions());
  }

  private async releaseSessionLease(
    entry: McpHostServerEntry,
    lease: McpClientLease,
    reason: McpHostShutdownReason,
  ): Promise<void> {
    const client = entry.client;
    if (reason !== "handoff" || client?.capabilities.resourceSubscriptions !== true) {
      await lease.release(reason);
      return;
    }
    const prefix = `${entry.definition.id}\0`;
    const uris = [...this.subscriptions]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    await lease.release(reason, async (retainedClient) => {
      const results = await Promise.allSettled(
        uris.map((uri) => retainedClient.unsubscribeResource(uri)),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
  }

  private async stopEntry(entry: McpHostServerEntry, reason: string): Promise<void> {
    entry.retryAbort?.abort(new Error(reason));
    delete entry.retryAbort;
    entry.generation += 1;
    entry.instructionToolNames = [];
    entry.toolCatalogReady = false;
    delete entry.toolCatalog;
    const ownedClient = entry.ownedClient;
    const lease = entry.lease;
    delete entry.client;
    delete entry.ownedClient;
    delete entry.connectionReused;
    delete entry.connectionStartedAt;
    delete entry.lease;
    this.setEntryStatus(entry, { state: "disabled" });
    await this.notifyCatalogChanged(entry, "tools");
    if (lease === undefined) await ownedClient?.close();
    else await lease.release("quit");
  }

  private notifyCatalogChanged(entry: McpHostServerEntry, kind: McpHostCatalogKind): Promise<void> {
    if (this.options.onCatalogChanged === undefined) return Promise.resolve();
    const key = `${entry.definition.id}\0${kind}`;
    const pending = this.pendingCatalogChanges.get(key);
    if (pending !== undefined) return pending.promise;

    const completion = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.pendingCatalogChanges.delete(key);
      void (async () => {
        try {
          await this.options.onCatalogChanged?.(entry.definition.id, kind);
        } catch (cause) {
          await this.recordLog(entry.definition.id, errorMessage(cause));
        } finally {
          completion.resolve();
        }
      })();
    }, MCP_CATALOG_CHANGE_DEBOUNCE_MS);
    timer.unref();
    this.pendingCatalogChanges.set(key, { ...completion, timer });
    return completion.promise;
  }

  private statusSnapshot(entry: McpHostServerEntry): McpServerStatus {
    if (entry.status.state !== "connected" || entry.connectionStartedAt === undefined) {
      return { ...entry.status };
    }
    return {
      connectionAgeMs: Math.max(0, Date.now() - entry.connectionStartedAt),
      reused: entry.connectionReused ?? false,
      state: "connected",
    };
  }

  private setEntryStatus(entry: McpHostServerEntry, status: McpServerStatus): void {
    entry.status = status;
    this.publishStatuses();
  }

  private publishStatuses(): void {
    try {
      this.options.onStatusChange?.(this.listStatuses());
    } catch {
      // Observer failures cannot change MCP Host lifecycle behavior.
    }
  }

  private recordLog(serverId: string, message: string): Promise<void> {
    const redacted = this.options.settings.secrets.redact(message);
    const chunks = this.pendingLogs.get(serverId) ?? [];
    chunks.push(redacted);
    this.pendingLogs.set(serverId, chunks);
    this.pendingLogBytes += Buffer.byteLength(redacted);

    if (this.pendingLogFlush === undefined) {
      const completion = Promise.withResolvers<void>();
      const timer = setTimeout(() => void this.flushPendingLogs(), MCP_LOG_FLUSH_INTERVAL_MS);
      timer.unref();
      this.pendingLogFlush = { ...completion, timer };
    }
    const pending = this.pendingLogFlush.promise;
    if (this.pendingLogBytes >= MCP_LOG_FLUSH_BYTES) void this.flushPendingLogs();
    return pending;
  }

  private flushPendingLogs(): Promise<void> {
    const pending = this.pendingLogFlush;
    if (pending === undefined) return Promise.resolve();
    clearTimeout(pending.timer);
    this.pendingLogFlush = undefined;
    this.pendingLogBytes = 0;
    const logs = [...this.pendingLogs].map(
      ([serverId, chunks]) => [serverId, chunks.join("")] as const,
    );
    this.pendingLogs.clear();
    void Promise.allSettled(
      logs.map(([serverId, message]) =>
        this.options.sessionFiles.appendServerLog(serverId, message),
      ),
    ).then(() => pending.resolve());
    return pending.promise;
  }

  private async shutdownOwnedResources(reason: McpHostShutdownReason): Promise<void> {
    this.shuttingDown = true;
    for (const pending of this.pendingCatalogChanges.values()) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pendingCatalogChanges.clear();
    const clients: McpOwnedHostClient[] = [];
    const leases: Promise<void>[] = [];
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.retryAbort?.abort(new Error("MCP Host shutting down"));
      delete entry.retryAbort;
      entry.generation += 1;
      const lease = entry.lease;
      if (lease !== undefined) {
        leases.push(this.releaseSessionLease(entry, lease, reason));
        delete entry.lease;
      } else {
        if (entry.ownedClient !== undefined) clients.push(entry.ownedClient);
        if (entry.pending !== undefined) pending.push(entry.pending);
      }
      delete entry.client;
      delete entry.ownedClient;
      delete entry.connectionReused;
      delete entry.connectionStartedAt;
    }
    await Promise.allSettled(leases);
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled(pending);
    await this.flushPendingLogs();
    await this.options.sessionFiles.close();
  }
}
