import { expect, test, vi } from "vitest";
import {
  McpHost,
  type McpHostAuthProvider,
  type McpHostClient,
  type McpHostClientCapabilities,
  type McpHostClientConnectOptions,
  type McpHostClientEvents,
  type McpHostClientFactory,
  type McpHostClock,
  type McpHostServerTool,
} from "../src/mcp-host.js";
import type { McpSessionFiles } from "../src/mcp-session-files.js";
import {
  McpResolvedSecrets,
  type McpServerDefinition,
  type ResolvedMcpSettings,
} from "../src/pi-mcp-settings.js";

const flush = async () => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

class FakeClock implements McpHostClock {
  now = 1_000;
  readonly sleeps: Array<{
    readonly milliseconds: number;
    readonly signal: AbortSignal;
    readonly resolve: () => void;
    readonly reject: (cause: unknown) => void;
  }> = [];

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const sleeping = { milliseconds, reject, resolve, signal };
      this.sleeps.push(sleeping);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  wakeNext(): void {
    const sleeping = this.sleeps.shift();
    if (sleeping === undefined) throw new Error("No fake sleep is pending");
    this.now += sleeping.milliseconds;
    sleeping.resolve();
  }
}

interface FakePage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
}

class FakeClient implements McpHostClient {
  readonly callTool = vi.fn(async () => ({ content: [{ text: "called", type: "text" as const }] }));
  readonly close = vi.fn(async () => undefined);
  readonly getPrompt = vi.fn(async (name: string, args?: Readonly<Record<string, string>>) => ({
    description: `${name}:${JSON.stringify(args ?? {})}`,
    messages: [],
  }));
  readonly completePromptArgument = vi.fn(async () => ({ hasMore: false, values: ["one", "two"] }));
  readonly readResource = vi.fn(async (uri: string) => ({ contents: [{ uri, text: "body" }] }));
  readonly setLoggingLevel = vi.fn(async () => undefined);
  readonly subscribeResource = vi.fn(async () => undefined);
  readonly unsubscribeResource = vi.fn(async () => undefined);
  readonly pageCalls = { prompts: 0, resources: 0, templates: 0, tools: 0 };
  promptPages: FakePage<{ name: string; description?: string }>[] = [{ items: [] }];
  resourcePages: FakePage<{ name: string; uri: string }>[] = [{ items: [] }];
  templatePages: FakePage<{ name: string; uriTemplate: string }>[] = [{ items: [] }];
  toolPages: FakePage<McpHostServerTool>[] = [{ items: [] }];
  readonly instructions: string | undefined;

  constructor(
    readonly capabilities: McpHostClientCapabilities = {},
    instructions?: string,
  ) {
    this.instructions = instructions;
  }

  listPromptsPage(cursor: string | undefined) {
    return this.page(this.promptPages, "prompts", cursor);
  }

  listResourcesPage(cursor: string | undefined) {
    return this.page(this.resourcePages, "resources", cursor);
  }

  listResourceTemplatesPage(cursor: string | undefined) {
    return this.page(this.templatePages, "templates", cursor);
  }

  listToolsPage(cursor: string | undefined) {
    return this.page(this.toolPages, "tools", cursor);
  }

  private async page<Item>(
    pages: readonly FakePage<Item>[],
    kind: keyof FakeClient["pageCalls"],
    cursor: string | undefined,
  ): Promise<FakePage<Item>> {
    this.pageCalls[kind] += 1;
    const index = cursor === undefined ? 0 : Number(cursor);
    const page = pages[index];
    if (page === undefined) throw new Error(`missing fake ${kind} page ${String(cursor)}`);
    return page;
  }
}

class FakeFactory implements McpHostClientFactory {
  readonly attempts = new Map<string, number>();
  readonly authProviders = new Map<string, McpHostAuthProvider | undefined>();
  readonly events = new Map<string, McpHostClientEvents>();
  readonly outcomes = new Map<string, Array<McpHostClient | Error | Promise<McpHostClient>>>();

  queue(
    serverId: string,
    ...outcomes: Array<McpHostClient | Error | Promise<McpHostClient>>
  ): void {
    this.outcomes.set(serverId, outcomes);
  }

  async connect(options: McpHostClientConnectOptions): Promise<McpHostClient> {
    const attempts = (this.attempts.get(options.serverId) ?? 0) + 1;
    this.attempts.set(options.serverId, attempts);
    this.authProviders.set(options.serverId, options.authProvider);
    this.events.set(options.serverId, options.events);
    const outcome = this.outcomes.get(options.serverId)?.shift();
    if (outcome instanceof Error) throw outcome;
    if (outcome === undefined) throw new Error(`No fake outcome for ${options.serverId}`);
    return outcome;
  }
}

function stdioDefinition(id: string, enabled = true): McpServerDefinition {
  return {
    args: [],
    command: id,
    enabled,
    environment: {},
    id,
    provenance: "global",
    transport: "stdio",
  };
}

function remoteDefinition(id: string): McpServerDefinition {
  return {
    auth: { scopes: [], type: "oauth" },
    enabled: true,
    headers: {},
    id,
    provenance: "global",
    transport: "http",
    url: `https://${id}.example/mcp`,
  };
}

function settings(
  definitions: readonly McpServerDefinition[],
  retry: ResolvedMcpSettings["retry"] = {
    backoffFactor: 1.5,
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    maxRetries: 2,
  },
): ResolvedMcpSettings {
  return {
    connectTimeoutMs: 10_000,
    errors: [],
    masks: new Map(),
    requestTimeoutMs: 60_000,
    retry,
    secrets: new McpResolvedSecrets(),
    servers: new Map(definitions.map((definition) => [definition.id, definition])),
    valid: true,
  };
}

function sessionFiles(
  close: () => Promise<void> = vi.fn(async () => undefined),
  appendServerLog: (serverId: string, text: string) => Promise<void> = vi.fn(async () => undefined),
): McpSessionFiles {
  return {
    appendServerLog,
    close,
    directoryPath: "/tmp/pi-mcp-test",
    getServerLogPath: vi.fn(async () => "/tmp/pi-mcp-test/server.log"),
    readServerLog: vi.fn(async (serverId) => `${serverId} log`),
    writeResultSpill: vi.fn(async () => "/tmp/pi-mcp-test/spill"),
    writeUnsupportedContent: vi.fn(async () => "/tmp/pi-mcp-test/content"),
  };
}

test("starts without blocking, isolates failures, and retries with capped exponential delays", async () => {
  const clock = new FakeClock();
  const factory = new FakeFactory();
  const connected = new FakeClient({ tools: true });
  const recovered = new FakeClient({ tools: true });
  const appendServerLog = vi.fn(async () => undefined);
  const files = sessionFiles(undefined, appendServerLog);
  factory.queue("good", connected);
  factory.queue("flaky", new Error("first failure secret"), new Error("second failure"), recovered);
  const host = new McpHost({
    clientFactory: factory,
    clock,
    piCwd: "/project",
    sessionFiles: files,
    settings: {
      ...settings([stdioDefinition("good"), stdioDefinition("flaky")]),
      secrets: new McpResolvedSecrets(["private-token"]),
    },
  });

  host.start();
  expect(host.getStatus("good")?.state).toBe("connecting");
  await host.waitForInitialConnections();
  expect(host.getStatus("good")?.state).toBe("connected");
  expect(host.hasConnectedCapability("tools", "good")).toBe(true);
  await factory.events.get("good")?.onLog("server echoed private-token");
  expect(appendServerLog).toHaveBeenCalledWith("good", "server echoed [REDACTED]");
  expect(host.getStatus("flaky")).toMatchObject({ delayMs: 1_000, state: "retrying" });

  clock.wakeNext();
  await flush();
  expect(host.getStatus("flaky")).toMatchObject({ delayMs: 1_500, state: "retrying" });
  clock.wakeNext();
  await flush();
  expect(host.getStatus("flaky")?.state).toBe("connected");
  expect(factory.attempts.get("flaky")).toBe(3);
});

test("resolves and forwards an OAuth provider before connecting a remote Server", async () => {
  const factory = new FakeFactory();
  const definition = remoteDefinition("oauth");
  const authProvider: McpHostAuthProvider = { token: async () => "stored-access-token" };
  const resolveAuthProvider = vi.fn(async () => authProvider);
  factory.queue("oauth", new FakeClient());
  const host = new McpHost({
    clientFactory: factory,
    piCwd: "/project",
    resolveAuthProvider,
    sessionFiles: sessionFiles(),
    settings: settings([definition]),
  });

  host.start();
  await host.waitForInitialConnections();

  expect(resolveAuthProvider).toHaveBeenCalledWith(definition);
  expect(factory.authProviders.get("oauth")).toBe(authProvider);
  expect(host.getStatus("oauth")?.state).toBe("connected");
});

test("aggregates bounded catalogs, rejects duplicate cursors, and refreshes invalidated caches", async () => {
  const factory = new FakeFactory();
  const client = new FakeClient({
    prompts: true,
    resources: true,
    resourceTemplates: true,
    tools: true,
  });
  client.toolPages = [
    { items: [{ inputSchema: { type: "object" }, name: "first" }], nextCursor: "1" },
    { items: [{ inputSchema: { type: "object" }, name: "second" }] },
  ];
  client.resourcePages = [
    { items: [{ name: "bad", uri: "file:///bad" }], nextCursor: "1" },
    { items: [], nextCursor: "1" },
  ];
  factory.queue("catalog", client);
  const catalogChanged = vi.fn();
  const host = new McpHost({
    clientFactory: factory,
    onCatalogChanged: catalogChanged,
    piCwd: "/project",
    sessionFiles: sessionFiles(),
    settings: settings([stdioDefinition("catalog")]),
  });

  host.start();
  await host.waitForInitialConnections();
  expect((await host.listTools()).map(({ tool }) => tool.name)).toEqual(["first", "second"]);
  expect(client.pageCalls.tools).toBe(2);
  await host.listTools();
  expect(client.pageCalls.tools).toBe(2);
  await expect(host.listResources("catalog")).rejects.toThrow("duplicate cursor");

  client.toolPages = [{ items: [{ inputSchema: { type: "object" }, name: "replacement" }] }];
  await host.invalidateCatalog("catalog", "tools");
  expect((await host.listTools()).map(({ tool }) => tool.name)).toEqual(["replacement"]);
  expect(catalogChanged).toHaveBeenCalledWith("catalog", "tools");
});

test("owns resources, prompts, desired subscriptions, and provenance-only update notices", async () => {
  const factory = new FakeFactory();
  const client = new FakeClient({
    logging: true,
    prompts: true,
    resources: true,
    resourceSubscriptions: true,
    resourceTemplates: true,
    tools: true,
  });
  client.promptPages = [{ items: [{ description: "A prompt", name: "review" }] }];
  client.resourcePages = [{ items: [{ name: "Guide", uri: "file:///guide" }] }];
  client.templatePages = [{ items: [{ name: "Issue", uriTemplate: "issue://{id}" }] }];
  factory.queue("docs", client);
  const persisted = vi.fn(async () => undefined);
  const resourceUpdated = vi.fn();
  const host = new McpHost({
    clientFactory: factory,
    initialSubscriptions: [{ serverId: "docs", uri: "file:///persisted" }],
    onResourceUpdated: resourceUpdated,
    persistSubscriptions: persisted,
    piCwd: "/project",
    sessionFiles: sessionFiles(),
    settings: settings([stdioDefinition("docs")]),
  });

  host.start();
  await host.waitForInitialConnections();
  expect(client.subscribeResource).toHaveBeenCalledWith("file:///persisted");
  const operationContext = { piContext: { requestId: "pi-request" } };
  await expect(
    host.callTool("docs", "search", { query: "MCP" }, operationContext),
  ).resolves.toEqual({
    content: [{ text: "called", type: "text" }],
  });
  expect(client.callTool).toHaveBeenCalledWith("search", { query: "MCP" }, operationContext);
  expect(await host.listResources()).toEqual([
    { resource: { name: "Guide", uri: "file:///guide" }, serverId: "docs" },
  ]);
  expect(await host.listResourceTemplates()).toHaveLength(1);
  expect(await host.listPrompts()).toHaveLength(1);
  await expect(host.readLogs("docs", "warning")).resolves.toEqual([
    { serverId: "docs", text: "docs log" },
  ]);
  expect(client.setLoggingLevel).toHaveBeenCalledWith("warning");
  await expect(host.readResource("docs", "file:///guide")).resolves.toMatchObject({
    contents: [{ text: "body" }],
  });
  await expect(host.getPrompt("docs", "review", { focus: "types" })).resolves.toMatchObject({
    description: expect.stringContaining("review"),
  });
  await expect(host.completePromptArgument("docs", "review", "focus", "ty")).resolves.toEqual({
    hasMore: false,
    values: ["one", "two"],
  });

  await host.subscribeResource("docs", "file:///new");
  expect(persisted).toHaveBeenLastCalledWith([
    { serverId: "docs", uri: "file:///new" },
    { serverId: "docs", uri: "file:///persisted" },
  ]);
  await factory.events.get("docs")?.onResourceUpdated("file:///new");
  expect(resourceUpdated).toHaveBeenCalledWith({ serverId: "docs", uri: "file:///new" });
  expect(client.readResource).toHaveBeenCalledTimes(1);
  await host.unsubscribeResource("docs", "file:///new");
  expect(client.unsubscribeResource).toHaveBeenCalledWith("file:///new");
});

test("updates, disables, reconnects, and removes Server Definitions without disturbing peers", async () => {
  const factory = new FakeFactory();
  const first = new FakeClient();
  const second = new FakeClient();
  factory.queue("mutable", first, second);
  const host = new McpHost({
    clientFactory: factory,
    piCwd: "/project",
    sessionFiles: sessionFiles(),
    settings: settings([stdioDefinition("mutable")]),
  });

  host.start();
  await host.waitForInitialConnections();
  await host.disableServer("mutable");
  expect(host.getStatus("mutable")?.state).toBe("disabled");
  expect(first.close).toHaveBeenCalledTimes(1);

  await host.upsertServer(stdioDefinition("mutable"));
  expect(host.getStatus("mutable")?.state).toBe("connected");
  expect(factory.attempts.get("mutable")).toBe(2);
  await host.removeServer("mutable");
  expect(host.getStatus("mutable")).toBeUndefined();
  expect(second.close).toHaveBeenCalledTimes(1);
});

test("freezes the first-request Instruction Snapshot after the bounded deadline", async () => {
  const clock = new FakeClock();
  const factory = new FakeFactory();
  const fast = new FakeClient({ tools: true }, "Fast instructions");
  fast.toolPages = [{ items: [{ inputSchema: { type: "object" }, name: "fast_tool" }] }];
  let resolveSlow: ((client: McpHostClient) => void) | undefined;
  const slowConnection = new Promise<McpHostClient>((resolve) => {
    resolveSlow = resolve;
  });
  const slow = new FakeClient({ tools: true }, "Late instructions");
  slow.toolPages = [{ items: [{ inputSchema: { type: "object" }, name: "late_tool" }] }];
  factory.queue("fast", fast);
  factory.queue("slow", slowConnection);
  const host = new McpHost({
    clientFactory: factory,
    clock,
    instructionDeadlineMs: 500,
    piCwd: "/project",
    sessionFiles: sessionFiles(),
    settings: settings([stdioDefinition("fast"), stdioDefinition("slow")]),
  });

  host.start();
  await flush();
  const freezing = host.freezeInstructionSnapshot();
  expect(clock.sleeps[0]?.milliseconds).toBe(500);
  clock.wakeNext();
  const snapshot = await freezing;
  expect(snapshot.text).toContain("Fast instructions");
  expect(snapshot.text).toContain("fast_tool");
  expect(snapshot.text).not.toContain("Late instructions");

  resolveSlow?.(slow);
  await flush();
  expect(await host.freezeInstructionSnapshot()).toBe(snapshot);
});

test("shuts down connected, retrying, and late clients exactly once", async () => {
  const clock = new FakeClock();
  const factory = new FakeFactory();
  const closeSessionFiles = vi.fn(async () => undefined);
  const files = sessionFiles(closeSessionFiles);
  const connected = new FakeClient();
  const late = new FakeClient();
  let resolveLate: ((client: McpHostClient) => void) | undefined;
  const lateConnection = new Promise<McpHostClient>((resolve) => {
    resolveLate = resolve;
  });
  factory.queue("connected", connected);
  factory.queue("retrying", new Error("offline"));
  factory.queue("late", lateConnection);
  const host = new McpHost({
    clientFactory: factory,
    clock,
    piCwd: "/project",
    sessionFiles: files,
    settings: settings([
      stdioDefinition("connected"),
      stdioDefinition("retrying"),
      stdioDefinition("late"),
      stdioDefinition("disabled", false),
    ]),
  });

  host.start();
  await flush();
  expect(host.getStatus("disabled")?.state).toBe("disabled");
  const shuttingDown = host.shutdown();
  resolveLate?.(late);
  await shuttingDown;
  await host.shutdown();

  expect(connected.close).toHaveBeenCalledTimes(1);
  expect(late.close).toHaveBeenCalledTimes(1);
  expect(closeSessionFiles).toHaveBeenCalledTimes(1);
  expect(clock.sleeps[0]?.signal.aborted).toBe(true);
});
