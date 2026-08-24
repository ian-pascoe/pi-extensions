import {
  RegistrationRejectedError,
  UnauthorizedError,
  type AuthProvider,
  type Client,
  type LoggingLevel,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { McpServerClient, type McpServerRunOptions } from "./mcp-server-client.js";
import type { McpSessionFiles } from "./mcp-session-files.js";
import type { McpServerDefinition, ResolvedMcpSettings } from "./pi-mcp-settings.js";

const MCP_HOST_MAX_LIST_PAGES = 1_000;
const DEFAULT_INSTRUCTION_DEADLINE_MS = 10_000;

/** Clock boundary used for retry and first-request deadlines. */
export interface McpHostClock {
  readonly now: number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const systemClock: McpHostClock = {
  get now() {
    return Date.now();
  },
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolveSleep, rejectSleep) => {
      const timeout = setTimeout(resolveSleep, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          rejectSleep(signal.reason);
        },
        { once: true },
      );
    }),
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

/** One protocol list page consumed by the Host's bounded paginator. */
export interface McpHostListPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
}

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
  onCatalogChanged(kind: McpHostCatalogKind): Promise<void> | void;
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
  close(): Promise<void>;
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
  listPromptsPage(cursor: string | undefined): Promise<McpHostListPage<McpHostPrompt>>;
  listResourcesPage(cursor: string | undefined): Promise<McpHostListPage<McpHostResource>>;
  listResourceTemplatesPage(
    cursor: string | undefined,
  ): Promise<McpHostListPage<McpHostResourceTemplate>>;
  listToolsPage(cursor: string | undefined): Promise<McpHostListPage<McpHostServerTool>>;
  readResource<PiContext = undefined>(
    uri: string,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostReadResourceResult>;
  setLoggingLevel(level: LoggingLevel): Promise<void>;
  subscribeResource(uri: string): Promise<void>;
  unsubscribeResource(uri: string): Promise<void>;
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
  connect(options: McpHostClientConnectOptions): Promise<McpHostClient>;
}

/** Catalog whose cache can be invalidated by its matching MCP notification. */
export type McpHostCatalogKind = "prompts" | "resources" | "resourceTemplates" | "tools";

/** Live status of one configured MCP Server. */
export type McpServerStatus =
  | { readonly state: "disabled" }
  | { readonly attempt: number; readonly state: "connecting" }
  | { readonly state: "connected" }
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
  readonly serverId: string;
  readonly text: string;
}

/** Desired Resource subscription persisted in the Pi session branch. */
export interface McpHostResourceSubscription {
  readonly serverId: string;
  readonly uri: string;
}

/** Frozen Server Instructions and tool names used by the first model request. */
export interface McpInstructionSnapshot {
  readonly frozenAt: number;
  readonly text: string;
}

/** Construction boundaries for one session-owned MCP Host. */
export interface McpHostOptions {
  readonly clientFactory?: McpHostClientFactory;
  readonly clock?: McpHostClock;
  readonly initialSubscriptions?: readonly McpHostResourceSubscription[];
  readonly instructionDeadlineMs?: number;
  readonly onCatalogChanged?: (serverId: string, kind: McpHostCatalogKind) => void;
  readonly onResourceUpdated?: (update: McpHostResourceSubscription) => void;
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

interface McpHostCatalogCache {
  prompts?: readonly McpHostPrompt[];
  resources?: readonly McpHostResource[];
  resourceTemplates?: readonly McpHostResourceTemplate[];
  tools?: readonly McpHostServerTool[];
}

interface McpHostServerEntry {
  readonly catalog: McpHostCatalogCache;
  readonly catalogLoads: Partial<Record<McpHostCatalogKind, Promise<void>>>;
  definition: McpServerDefinition;
  client?: McpHostClient;
  failures: number;
  generation: number;
  pending?: Promise<void>;
  retryAbort?: AbortController;
  status: McpServerStatus;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function pageResult<Item>(
  items: readonly Item[],
  nextCursor: string | undefined,
): McpHostListPage<Item> {
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

class SdkMcpHostClient implements McpHostClient {
  private constructor(
    private readonly owner: McpServerClient,
    readonly capabilities: McpHostClientCapabilities,
    readonly instructions: string | undefined,
  ) {}

  static async connect(
    definition: McpServerDefinition,
    events: McpHostClientEvents,
    options: Pick<McpHostOptions, "piCwd" | "sessionFiles" | "settings">,
    authProvider: McpHostAuthProvider | undefined,
  ): Promise<SdkMcpHostClient> {
    const connectOptions = {
      clientInfo: { name: "@ian-pascoe/pi-mcp", version: "0.1.0" },
      connectTimeoutMs: options.settings.connectTimeoutMs,
      definition,
      onConnectionClose: () => events.onClose(),
      onError: (error: Error) => events.onError(error),
      onStderr: (text: string) => void events.onLog(text),
      piCwd: options.piCwd,
      requestTimeoutMs: options.settings.requestTimeoutMs,
      serverId: definition.id,
    };
    const owner = await McpServerClient.connect(
      authProvider === undefined ? connectOptions : { ...connectOptions, authProvider },
    );
    const capabilities = await owner.run(async (client) => {
      const advertised = client.getServerCapabilities();
      client.setNotificationHandler("notifications/tools/list_changed", () =>
        events.onCatalogChanged("tools"),
      );
      client.setNotificationHandler("notifications/resources/list_changed", () =>
        Promise.all([
          events.onCatalogChanged("resources"),
          events.onCatalogChanged("resourceTemplates"),
        ]).then(() => undefined),
      );
      client.setNotificationHandler("notifications/prompts/list_changed", () =>
        events.onCatalogChanged("prompts"),
      );
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

  listPromptsPage(cursor: string | undefined): Promise<McpHostListPage<McpHostPrompt>> {
    return this.listPage(cursor, (client, params, requestOptions) =>
      client
        .listPrompts(params, requestOptions)
        .then((result) => pageResult(result.prompts, result.nextCursor)),
    );
  }

  listResourcesPage(cursor: string | undefined): Promise<McpHostListPage<McpHostResource>> {
    return this.listPage(cursor, (client, params, requestOptions) =>
      client
        .listResources(params, requestOptions)
        .then((result) => pageResult(result.resources, result.nextCursor)),
    );
  }

  listResourceTemplatesPage(
    cursor: string | undefined,
  ): Promise<McpHostListPage<McpHostResourceTemplate>> {
    return this.listPage(cursor, (client, params, requestOptions) =>
      client
        .listResourceTemplates(params, requestOptions)
        .then((result) => pageResult(result.resourceTemplates, result.nextCursor)),
    );
  }

  listToolsPage(cursor: string | undefined): Promise<McpHostListPage<McpHostServerTool>> {
    return this.listPage(cursor, (client, params, requestOptions) =>
      client
        .listTools(params, requestOptions)
        .then((result) => pageResult(result.tools, result.nextCursor)),
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

  setLoggingLevel(level: LoggingLevel): Promise<void> {
    return this.owner.run(async (client, requestOptions) => {
      await client.setLoggingLevel(level, requestOptions);
    });
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

  private listPage<Item>(
    cursor: string | undefined,
    list: (
      client: Client,
      params: { cursor?: string },
      requestOptions: Parameters<Client["listTools"]>[1],
    ) => Promise<McpHostListPage<Item>>,
  ): Promise<McpHostListPage<Item>> {
    const params = cursor === undefined ? {} : { cursor };
    return this.owner.run((client, requestOptions) => list(client, params, requestOptions));
  }
}

class SdkMcpHostClientFactory implements McpHostClientFactory {
  constructor(
    private readonly options: Pick<McpHostOptions, "piCwd" | "sessionFiles" | "settings">,
  ) {}

  connect({
    authProvider,
    definition,
    events,
  }: McpHostClientConnectOptions): Promise<McpHostClient> {
    return SdkMcpHostClient.connect(definition, events, this.options, authProvider);
  }
}

/** Session-owned MCP server registry, catalogs, subscriptions, retries, and cleanup. */
export class McpHost {
  private readonly clock: McpHostClock;
  private readonly clientFactory: McpHostClientFactory;
  private readonly entries = new Map<string, McpHostServerEntry>();
  private readonly subscriptions = new Set<string>();
  private initialConnections: readonly Promise<void>[] = [];
  private instructionSnapshot: McpInstructionSnapshot | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private started = false;
  private shuttingDown = false;

  constructor(private readonly options: McpHostOptions) {
    this.clock = options.clock ?? systemClock;
    this.clientFactory = options.clientFactory ?? new SdkMcpHostClientFactory(options);
    for (const definition of options.settings.servers.values()) {
      this.entries.set(definition.id, {
        catalog: {},
        catalogLoads: {},
        definition,
        failures: 0,
        generation: 0,
        status: { state: "disabled" },
      });
    }
    for (const subscription of options.initialSubscriptions ?? []) {
      this.subscriptions.add(this.subscriptionKey(subscription.serverId, subscription.uri));
    }
  }

  /** Launch enabled Server connections without awaiting network or process startup. */
  start(): void {
    if (this.started || this.shuttingDown) return;
    this.started = true;
    this.initialConnections = [...this.entries.values()].flatMap((entry) => {
      if (!entry.definition.enabled) {
        entry.status = { state: "disabled" };
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
    const status = this.entries.get(serverId)?.status;
    return status === undefined ? undefined : { ...status };
  }

  /** Return every server status in deterministic Server Definition order. */
  listStatuses(): ReadonlyMap<string, McpServerStatus> {
    return new Map(
      [...this.entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([serverId, entry]) => [serverId, { ...entry.status }]),
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

  /** Return cached or freshly listed Server Tools with provenance. */
  async listTools(serverId?: string): Promise<readonly McpHostToolItem[]> {
    const entries = this.connectedEntries(serverId);
    await Promise.all(entries.map((entry) => this.ensureCatalog(entry, "tools")));
    return entries
      .flatMap((entry) =>
        (entry.catalog.tools ?? []).map((tool) => ({ serverId: entry.definition.id, tool })),
      )
      .sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) ||
          left.tool.name.localeCompare(right.tool.name),
      );
  }

  /** Return cached or freshly listed Resources with provenance. */
  async listResources(serverId?: string): Promise<readonly McpHostResourceItem[]> {
    return (await this.listCatalog("resources", serverId)).map(({ item, serverId: id }) => ({
      resource: item,
      serverId: id,
    }));
  }

  /** Return cached or freshly listed Resource Templates with provenance. */
  async listResourceTemplates(serverId?: string): Promise<readonly McpHostResourceTemplateItem[]> {
    return (await this.listCatalog("resourceTemplates", serverId)).map(
      ({ item, serverId: id }) => ({ resourceTemplate: item, serverId: id }),
    );
  }

  /** Return cached or freshly listed Prompts with provenance. */
  async listPrompts(serverId?: string): Promise<readonly McpHostPromptItem[]> {
    return (await this.listCatalog("prompts", serverId)).map(({ item, serverId: id }) => ({
      prompt: item,
      serverId: id,
    }));
  }

  /** Read bounded stderr and MCP logging tails without adding them to model context. */
  async readLogs(serverId?: string, level?: LoggingLevel): Promise<readonly McpHostLogTail[]> {
    const entries =
      serverId === undefined ? [...this.entries.values()] : [this.requireEntry(serverId)];
    if (level !== undefined) {
      const connected = entries.filter((entry) => entry.client !== undefined);
      if (serverId !== undefined && connected[0]?.client?.capabilities.logging !== true) {
        throw new Error(`MCP Server ${serverId} does not advertise logging`);
      }
      await Promise.all(
        connected.flatMap((entry) =>
          entry.client?.capabilities.logging === true ? [entry.client.setLoggingLevel(level)] : [],
        ),
      );
    }
    return Promise.all(
      entries
        .sort((left, right) => left.definition.id.localeCompare(right.definition.id))
        .map(async (entry) => ({
          serverId: entry.definition.id,
          text: await this.options.sessionFiles.readServerLog(entry.definition.id),
        })),
    );
  }

  /** Invalidate and eagerly refresh one catalog after a matching list-changed notification. */
  async invalidateCatalog(serverId: string, kind: McpHostCatalogKind): Promise<void> {
    const entry = this.requireEntry(serverId);
    delete entry.catalog[kind];
    await this.ensureCatalog(entry, kind);
    this.options.onCatalogChanged?.(serverId, kind);
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
      catalog: {},
      catalogLoads: {},
      definition,
      failures: 0,
      generation: 0,
      status: { state: "disabled" as const },
    };
    if (existing !== undefined) await this.stopEntry(existing, "MCP Server Definition replaced");
    entry.definition = definition;
    entry.failures = 0;
    this.entries.set(definition.id, entry);
    if (!this.started || !definition.enabled || this.shuttingDown) {
      entry.status = { state: "disabled" };
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
    entry.status = { state: "disabled" };
  }

  /** Remove one Server Definition and every ephemeral runtime value it owns. */
  async removeServer(serverId: string): Promise<void> {
    const entry = this.requireEntry(serverId);
    await this.stopEntry(entry, "MCP Server removed");
    this.entries.delete(serverId);
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
    if (!entry.definition.enabled) {
      entry.status = { state: "disabled" };
      return;
    }
    await this.connectEntry(entry);
  }

  /** Freeze Server Instructions and tool names after initial attempts or the first-request deadline. */
  async freezeInstructionSnapshot(): Promise<McpInstructionSnapshot> {
    if (this.instructionSnapshot !== undefined) return this.instructionSnapshot;
    const deadline = new AbortController();
    const timeout = this.clock
      .sleep(this.options.instructionDeadlineMs ?? DEFAULT_INSTRUCTION_DEADLINE_MS, deadline.signal)
      .catch(() => undefined);
    await Promise.race([this.waitForInitialConnections(), timeout]);
    deadline.abort(new Error("Instruction Snapshot frozen"));
    const sections = [...this.entries.values()]
      .filter((entry) => entry.client !== undefined && entry.status.state === "connected")
      .sort((left, right) => left.definition.id.localeCompare(right.definition.id))
      .flatMap((entry) => {
        const instructions = entry.client?.instructions?.trim();
        const toolNames = (entry.catalog.tools ?? []).map((tool) => tool.name).sort();
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
    this.instructionSnapshot = {
      frozenAt: this.clock.now,
      text: sections.join("\n\n"),
    };
    return this.instructionSnapshot;
  }

  /** Stop retries, close all acquired clients including late arrivals, then remove session files. */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOwnedResources();
    return this.shutdownPromise;
  }

  private connectEntry(entry: McpHostServerEntry): Promise<void> {
    const generation = ++entry.generation;
    entry.retryAbort?.abort(new Error("MCP connection attempt replaced"));
    delete entry.retryAbort;
    entry.status = { attempt: entry.failures + 1, state: "connecting" };
    const pending = Promise.resolve()
      .then(async () => {
        const authProvider =
          entry.definition.transport === "stdio"
            ? undefined
            : await this.options.resolveAuthProvider?.(entry.definition);
        const connectOptions: McpHostClientConnectOptions = {
          definition: entry.definition,
          events: {
            onCatalogChanged: async (kind) => {
              try {
                await this.invalidateCatalog(entry.definition.id, kind);
              } catch (cause) {
                await this.recordLog(entry.definition.id, errorMessage(cause));
              }
            },
            onClose: () => this.handleUnexpectedClose(entry, generation),
            onError: (error) => void this.recordLog(entry.definition.id, error.message),
            onLog: (message) => this.recordLog(entry.definition.id, message),
            onResourceUpdated: async (uri) => {
              try {
                this.options.onResourceUpdated?.({ serverId: entry.definition.id, uri });
              } catch (cause) {
                await this.recordLog(entry.definition.id, errorMessage(cause));
              }
            },
          },
          serverId: entry.definition.id,
        };
        return this.clientFactory.connect(
          authProvider === undefined ? connectOptions : { ...connectOptions, authProvider },
        );
      })
      .then(async (client) => {
        if (this.shuttingDown || generation !== entry.generation) {
          await client.close();
          return;
        }
        entry.client = client;
        entry.failures = 0;
        entry.status = { state: "connected" };
        const initialized = await Promise.allSettled([
          this.ensureCatalog(entry, "tools"),
          this.restoreSubscriptions(entry),
        ]);
        for (const result of initialized) {
          if (result.status === "rejected") {
            await this.recordLog(entry.definition.id, errorMessage(result.reason));
          }
        }
      })
      .catch((cause: unknown) => {
        if (this.shuttingDown || generation !== entry.generation) return;
        this.handleConnectionFailure(entry, cause);
      });
    entry.pending = pending;
    return pending;
  }

  private handleConnectionFailure(entry: McpHostServerEntry, cause: unknown): void {
    const message = this.options.settings.secrets.redact(errorMessage(cause));
    if (cause instanceof UnauthorizedError) {
      entry.status = { error: message, state: "needs_auth" };
      return;
    }
    if (cause instanceof RegistrationRejectedError) {
      entry.status = { error: message, state: "needs_client_registration" };
      return;
    }
    entry.failures += 1;
    if (entry.failures > this.options.settings.retry.maxRetries) {
      entry.status = { attempts: entry.failures, error: message, state: "failed" };
      return;
    }
    const delayMs = Math.min(
      this.options.settings.retry.maxDelayMs,
      Math.round(
        this.options.settings.retry.initialDelayMs *
          this.options.settings.retry.backoffFactor ** (entry.failures - 1),
      ),
    );
    const retryAbort = new AbortController();
    entry.retryAbort = retryAbort;
    entry.status = {
      attempt: entry.failures + 1,
      delayMs,
      error: message,
      retryAt: this.clock.now + delayMs,
      state: "retrying",
    };
    void this.clock.sleep(delayMs, retryAbort.signal).then(
      () => {
        if (!this.shuttingDown && entry.retryAbort === retryAbort) void this.connectEntry(entry);
      },
      () => undefined,
    );
  }

  private handleUnexpectedClose(entry: McpHostServerEntry, generation: number): void {
    if (this.shuttingDown || generation !== entry.generation) return;
    delete entry.client;
    this.clearCatalog(entry);
    this.handleConnectionFailure(entry, new Error("MCP connection closed unexpectedly"));
  }

  private async ensureCatalog(entry: McpHostServerEntry, kind: McpHostCatalogKind): Promise<void> {
    if (entry.catalog[kind] !== undefined) return;
    const activeLoad = entry.catalogLoads[kind];
    if (activeLoad !== undefined) return activeLoad;
    const client = entry.client;
    if (client === undefined || entry.status.state !== "connected") {
      throw new Error(`MCP Server ${entry.definition.id} is not connected`);
    }
    const load = this.loadCatalog(entry, client, kind);
    entry.catalogLoads[kind] = load;
    try {
      await load;
    } finally {
      delete entry.catalogLoads[kind];
    }
  }

  private async loadAllPages<Item>(
    serverId: string,
    loadPage: (cursor: string | undefined) => Promise<McpHostListPage<Item>>,
  ): Promise<readonly Item[]> {
    const items: Item[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MCP_HOST_MAX_LIST_PAGES; page += 1) {
      const result = await loadPage(cursor);
      items.push(...result.items);
      if (result.nextCursor === undefined) return items;
      if (seen.has(result.nextCursor)) {
        throw new Error(
          `MCP list pagination: ${serverId} returned duplicate cursor ${JSON.stringify(result.nextCursor)}`,
        );
      }
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error(`MCP list pagination: ${serverId} exceeded ${MCP_HOST_MAX_LIST_PAGES} pages`);
  }

  private async loadCatalog(
    entry: McpHostServerEntry,
    client: McpHostClient,
    kind: McpHostCatalogKind,
  ): Promise<void> {
    switch (kind) {
      case "prompts":
        entry.catalog.prompts =
          client.capabilities.prompts === true
            ? await this.loadAllPages(entry.definition.id, (cursor) =>
                client.listPromptsPage(cursor),
              )
            : [];
        return;
      case "resources":
        entry.catalog.resources =
          client.capabilities.resources === true
            ? await this.loadAllPages(entry.definition.id, (cursor) =>
                client.listResourcesPage(cursor),
              )
            : [];
        return;
      case "resourceTemplates":
        entry.catalog.resourceTemplates =
          client.capabilities.resourceTemplates === true
            ? await this.loadAllPages(entry.definition.id, (cursor) =>
                client.listResourceTemplatesPage(cursor),
              )
            : [];
        return;
      case "tools":
        entry.catalog.tools =
          client.capabilities.tools === true
            ? await this.loadAllPages(entry.definition.id, (cursor) => client.listToolsPage(cursor))
            : [];
    }
  }

  private async listCatalog(
    kind: "prompts",
    serverId?: string,
  ): Promise<readonly McpHostCatalogItem<McpHostPrompt>[]>;
  private async listCatalog(
    kind: "resources",
    serverId?: string,
  ): Promise<readonly McpHostCatalogItem<McpHostResource>[]>;
  private async listCatalog(
    kind: "resourceTemplates",
    serverId?: string,
  ): Promise<readonly McpHostCatalogItem<McpHostResourceTemplate>[]>;
  private async listCatalog(
    kind: "prompts" | "resources" | "resourceTemplates",
    serverId?: string,
  ): Promise<
    readonly McpHostCatalogItem<McpHostPrompt | McpHostResource | McpHostResourceTemplate>[]
  > {
    const entries = this.connectedEntries(serverId);
    await Promise.all(entries.map((entry) => this.ensureCatalog(entry, kind)));
    return entries
      .flatMap((entry) =>
        (entry.catalog[kind] ?? []).map((item) => ({ item, serverId: entry.definition.id })),
      )
      .sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) ||
          ("name" in left.item ? left.item.name : "").localeCompare(
            "name" in right.item ? right.item.name : "",
          ),
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
      throw new Error(`MCP Server ${serverId} is not connected`);
    }
    if (client.capabilities[capability] !== true) {
      throw new Error(`MCP Server ${serverId} does not support ${capability}`);
    }
    return client;
  }

  private requireEntry(serverId: string): McpHostServerEntry {
    const entry = this.entries.get(serverId);
    if (entry === undefined) throw new Error(`Unknown MCP Server ${serverId}`);
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
    const subscriptions = [...this.subscriptions]
      .map((key) => {
        const separator = key.indexOf("\0");
        return { serverId: key.slice(0, separator), uri: key.slice(separator + 1) };
      })
      .sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) || left.uri.localeCompare(right.uri),
      );
    await this.options.persistSubscriptions?.(subscriptions);
  }

  private async stopEntry(entry: McpHostServerEntry, reason: string): Promise<void> {
    entry.retryAbort?.abort(new Error(reason));
    delete entry.retryAbort;
    entry.generation += 1;
    this.clearCatalog(entry);
    const client = entry.client;
    delete entry.client;
    await client?.close();
  }

  private async recordLog(serverId: string, message: string): Promise<void> {
    try {
      await this.options.sessionFiles.appendServerLog(
        serverId,
        this.options.settings.secrets.redact(message),
      );
    } catch {
      // Logging must not change protocol lifecycle behavior.
    }
  }

  private clearCatalog(entry: McpHostServerEntry): void {
    delete entry.catalog.prompts;
    delete entry.catalog.resources;
    delete entry.catalog.resourceTemplates;
    delete entry.catalog.tools;
  }

  private async shutdownOwnedResources(): Promise<void> {
    this.shuttingDown = true;
    const clients: McpHostClient[] = [];
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.retryAbort?.abort(new Error("MCP Host shutting down"));
      delete entry.retryAbort;
      entry.generation += 1;
      if (entry.client !== undefined) {
        clients.push(entry.client);
        delete entry.client;
      }
      if (entry.pending !== undefined) pending.push(entry.pending);
    }
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled(pending);
    await this.options.sessionFiles.close();
  }
}
