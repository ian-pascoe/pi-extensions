import { UnauthorizedError } from "@modelcontextprotocol/client";
import { expect, test, vi } from "vitest";
import {
  McpClientPool,
  type McpClientPoolAcquireOptions,
  processMcpClientPool,
} from "../src/mcp-client-pool.js";
import type {
  McpHostCallToolResult,
  McpHostClientEvents,
  McpHostRequestContext,
  McpOwnedHostClient,
  McpHostServerTool,
  McpHostToolArguments,
} from "../src/mcp-host.js";
import type { McpServerDefinition } from "../src/pi-mcp-settings.js";

class RecordingPoolClient implements McpOwnedHostClient {
  readonly capabilities = { tools: true };
  readonly instructions = "Pooled instructions";
  readonly close = vi.fn(async () => undefined);
  callToolWithSignal:
    | ((signal: AbortSignal | undefined) => Promise<McpHostCallToolResult>)
    | undefined;
  readonly completePromptArgument = vi.fn(async () => ({ hasMore: false, values: [] }));
  readonly getPrompt = vi.fn(async () => ({ messages: [] }));
  readonly listPrompts = vi.fn(async () => []);
  readonly listResources = vi.fn(async () => []);
  readonly listResourceTemplates = vi.fn(async () => []);
  readonly listTools = vi.fn(async () => this.tools);
  readonly readResource = vi.fn(async () => ({ contents: [] }));
  readonly subscribeResource = vi.fn(async () => undefined);
  readonly unsubscribeResource = vi.fn(async () => undefined);
  tools: readonly McpHostServerTool[] = [{ inputSchema: { type: "object" }, name: "search" }];

  callTool<PiContext = undefined>(
    _name: string,
    _args: McpHostToolArguments,
    context?: McpHostRequestContext<PiContext>,
  ): Promise<McpHostCallToolResult> {
    return this.callToolWithSignal?.(context?.signal) ?? Promise.resolve({ content: [] });
  }
}

const definition: McpServerDefinition = {
  args: [],
  command: "server",
  enabled: true,
  environment: {},
  id: "docs",
  provenance: "project",
  transport: "stdio",
};

function events(): McpHostClientEvents {
  return {
    onCatalogChanged: () => undefined,
    onClose: () => undefined,
    onError: () => undefined,
    onLog: () => undefined,
    onResourceUpdated: () => undefined,
  };
}

function acquireOptions(
  client: RecordingPoolClient,
  connect: (connectionEvents: McpHostClientEvents) => void,
): McpClientPoolAcquireOptions {
  return {
    connect: async (connectionEvents: McpHostClientEvents) => {
      connect(connectionEvents);
      return client;
    },
    connectTimeoutMs: 10_000,
    definition,
    events: events(),
    projectRoot: "/project",
    projectTrusted: true,
    requestTimeoutMs: 60_000,
  };
}

test("reuses an unleased MCP Client across sequential session replacement", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  const connect = vi.fn<(connectionEvents: McpHostClientEvents) => void>();

  const first = pool.acquire(acquireOptions(client, connect));
  await first.connectedClient();
  await first.release("handoff");
  const second = pool.acquire(acquireOptions(client, connect));
  await second.connectedClient();

  expect(first.reused).toBe(false);
  expect(second.reused).toBe(true);
  expect(connect).toHaveBeenCalledOnce();
  expect(client.close).not.toHaveBeenCalled();

  await second.release("quit");
  expect(client.close).toHaveBeenCalledOnce();
});

test("reuses validated catalogs with the retained MCP Client", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  const first = pool.acquire(acquireOptions(client, vi.fn()));
  expect((await (await first.connectedClient()).listTools()).map((tool) => tool.name)).toEqual([
    "search",
  ]);
  await first.release("handoff");

  const second = pool.acquire(acquireOptions(client, vi.fn()));
  expect((await (await second.connectedClient()).listTools()).map((tool) => tool.name)).toEqual([
    "search",
  ]);

  expect(client.listTools).toHaveBeenCalledOnce();
  await second.release("quit");
});

test("does not retain a failed catalog read", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  client.listTools.mockRejectedValueOnce(new Error("temporary catalog failure"));
  const lease = pool.acquire(acquireOptions(client, vi.fn()));
  const leasedClient = await lease.connectedClient();

  await expect(leasedClient.listTools()).rejects.toThrow("temporary catalog failure");
  await expect(leasedClient.listTools()).resolves.toEqual(client.tools);

  expect(client.listTools).toHaveBeenCalledTimes(2);
  await lease.release("quit");
});

test("invalidates a client when a catalog read detects lost authentication", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  const onClose = vi.fn();
  client.listTools.mockRejectedValueOnce(new UnauthorizedError());
  const lease = pool.acquire({
    ...acquireOptions(client, vi.fn()),
    events: { ...events(), onClose },
  });

  await expect((await lease.connectedClient()).listTools()).rejects.toThrow("Unauthorized");
  await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

test("invalidates a retained catalog when its server announces a change", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  let connectionEvents: McpHostClientEvents | undefined;
  const connect = (events: McpHostClientEvents) => {
    connectionEvents = events;
  };
  const first = pool.acquire(acquireOptions(client, connect));
  await (await first.connectedClient()).listTools();
  await first.release("handoff");

  client.tools = [
    { inputSchema: { type: "object" }, name: "fetch" },
    { inputSchema: { type: "object" }, name: "search" },
  ];
  await connectionEvents?.onCatalogChanged(
    "tools",
    client.tools.map((tool) => tool.name),
  );
  const second = pool.acquire(acquireOptions(client, connect));

  await expect((await second.connectedClient()).listTools()).resolves.toEqual(client.tools);
  expect(client.listTools).toHaveBeenCalledTimes(2);
  await second.release("quit");
});

test("routes retained-client callbacks only to the current Session Lease", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  let connectionEvents: McpHostClientEvents | undefined;
  const firstLog = vi.fn();
  const secondLog = vi.fn();
  const connect = (events: McpHostClientEvents) => {
    connectionEvents = events;
  };
  const first = pool.acquire({
    ...acquireOptions(client, connect),
    events: { ...events(), onLog: firstLog },
  });
  await first.connectedClient();
  await first.release("handoff");
  const second = pool.acquire({
    ...acquireOptions(client, connect),
    events: { ...events(), onLog: secondLog },
  });
  await second.connectedClient();

  await connectionEvents?.onLog("replacement log");

  expect(firstLog).not.toHaveBeenCalled();
  expect(secondLog).toHaveBeenCalledWith("replacement log");
  await second.release("quit");
});

test("rejects operations from a released Session Lease", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  const lease = pool.acquire(acquireOptions(client, vi.fn()));
  const leasedClient = await lease.connectedClient();
  await leasedClient.listTools();
  await lease.release("handoff");

  await expect(leasedClient.listTools()).rejects.toThrow(
    "Pi MCP Session Lease is no longer active",
  );
});

test("aborts and drains active operations before releasing a Session Lease", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  let operationSignal: AbortSignal | undefined;
  client.callToolWithSignal = async (signal) => {
    operationSignal = signal;
    return new Promise((resolveOperation, rejectOperation) => {
      operationSignal?.addEventListener("abort", () => rejectOperation(operationSignal?.reason), {
        once: true,
      });
      if (operationSignal === undefined) resolveOperation({ content: [] });
    });
  };
  const lease = pool.acquire(acquireOptions(client, vi.fn()));
  const leasedClient = await lease.connectedClient();
  const operation = leasedClient.callTool("search", {});
  await Promise.resolve();

  const release = lease.release("handoff");
  await expect(operation).rejects.toThrow("Pi MCP Session Lease released");
  await release;

  expect(operationSignal?.aborted).toBe(true);
});

test("bounds Session Lease draining before closing a hung client", async () => {
  vi.useFakeTimers();
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  client.completePromptArgument.mockImplementation(async () => new Promise(() => undefined));
  const lease = pool.acquire(acquireOptions(client, vi.fn()));
  const leasedClient = await lease.connectedClient();
  void leasedClient.completePromptArgument("prompt", "argument", "value");

  try {
    const release = lease.release("handoff");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await release;
    expect(client.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("invalidates a retained client when project trust changes", async () => {
  const pool = new McpClientPool();
  const trustedClient = new RecordingPoolClient();
  const untrustedClient = new RecordingPoolClient();
  const connect = vi.fn<(connectionEvents: McpHostClientEvents) => void>();
  const trusted = pool.acquire(acquireOptions(trustedClient, connect));
  await trusted.connectedClient();
  await trusted.release("handoff");

  const untrusted = pool.acquire({
    ...acquireOptions(untrustedClient, connect),
    projectTrusted: false,
  });
  await untrusted.connectedClient();
  await Promise.resolve();

  expect(untrusted.reused).toBe(false);
  expect(trustedClient.close).toHaveBeenCalledOnce();
  await untrusted.release("quit");
});

test("keeps projects isolated even when their Server Definitions match", async () => {
  const pool = new McpClientPool();
  const firstClient = new RecordingPoolClient();
  const secondClient = new RecordingPoolClient();
  const connect = vi.fn<(connectionEvents: McpHostClientEvents) => void>();
  const first = pool.acquire(acquireOptions(firstClient, connect));
  await first.connectedClient();
  await first.release("handoff");

  const second = pool.acquire({
    ...acquireOptions(secondClient, connect),
    projectRoot: "/other-project",
  });
  await second.connectedClient();

  expect(second.reused).toBe(false);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(firstClient.close).not.toHaveBeenCalled();
  await second.release("quit");
});

test("allocates separate clients for concurrent Session Leases", async () => {
  const pool = new McpClientPool();
  const firstClient = new RecordingPoolClient();
  const secondClient = new RecordingPoolClient();
  const connect = vi.fn<(connectionEvents: McpHostClientEvents) => void>();

  const first = pool.acquire(acquireOptions(firstClient, connect));
  const second = pool.acquire(acquireOptions(secondClient, connect));
  await Promise.all([first.connectedClient(), second.connectedClient()]);

  expect(first.reused).toBe(false);
  expect(second.reused).toBe(false);
  expect(connect).toHaveBeenCalledTimes(2);
  await Promise.all([first.release("quit"), second.release("quit")]);
});

test("hands pending catalog work to the replacement Session Lease", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  const catalog = Promise.withResolvers<readonly McpHostServerTool[]>();
  client.listTools.mockImplementationOnce(() => catalog.promise);
  const first = pool.acquire(acquireOptions(client, vi.fn()));
  const firstCatalog = (await first.connectedClient()).listTools();

  await first.release("handoff");
  const replacement = pool.acquire(acquireOptions(client, vi.fn()));
  const replacementCatalog = (await replacement.connectedClient()).listTools();
  catalog.resolve(client.tools);

  await expect(firstCatalog).resolves.toEqual(client.tools);
  await expect(replacementCatalog).resolves.toEqual(client.tools);
  expect(replacement.reused).toBe(true);
  expect(client.listTools).toHaveBeenCalledOnce();
  await replacement.release("quit");
});

test("hands a pending connection to the replacement Session Lease", async () => {
  const pool = new McpClientPool();
  const connection = Promise.withResolvers<McpOwnedHostClient>();
  const connect = vi.fn(async () => connection.promise);
  const first = pool.acquire({
    ...acquireOptions(new RecordingPoolClient(), vi.fn()),
    connect,
  });
  await first.release("handoff");

  const replacementConnect = vi.fn(async () => new RecordingPoolClient());
  const replacement = pool.acquire({
    ...acquireOptions(new RecordingPoolClient(), vi.fn()),
    connect: replacementConnect,
  });
  const connected = new RecordingPoolClient();
  connection.resolve(connected);

  const replacementClient = await replacement.connectedClient();
  await expect(replacementClient.listTools()).resolves.toEqual(connected.tools);
  expect(replacement.reused).toBe(true);
  expect(connect).toHaveBeenCalledOnce();
  expect(replacementConnect).not.toHaveBeenCalled();
  await replacement.release("quit");
});

test("measures connection age from a successful handshake", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const pool = new McpClientPool();
  const connection = Promise.withResolvers<McpOwnedHostClient>();
  const lease = pool.acquire({
    ...acquireOptions(new RecordingPoolClient(), vi.fn()),
    connect: async () => connection.promise,
  });

  try {
    vi.setSystemTime(6_000);
    connection.resolve(new RecordingPoolClient());
    await lease.connectedClient();

    expect(lease.connectedAt).toBe(6_000);
    await lease.release("quit");
  } finally {
    vi.useRealTimers();
  }
});

test("expires an unleased client after the handoff grace period", async () => {
  vi.useFakeTimers();
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  const lease = pool.acquire(acquireOptions(client, vi.fn()));
  await lease.connectedClient();

  try {
    await lease.release("handoff");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("invalidates only clients sharing an authentication binding", async () => {
  const pool = new McpClientPool();
  const sharedClient = new RecordingPoolClient();
  const unrelatedClient = new RecordingPoolClient();
  const onClose = vi.fn();
  const sharedDefinition: McpServerDefinition = {
    auth: { scopes: [], type: "oauth" },
    enabled: true,
    headers: {},
    id: "docs",
    provenance: "project",
    transport: "http",
    url: "https://shared.example/mcp",
  };
  const unrelatedDefinition: McpServerDefinition = {
    ...sharedDefinition,
    url: "https://unrelated.example/mcp",
  };
  const sharedLease = pool.acquire({
    ...acquireOptions(sharedClient, vi.fn()),
    definition: sharedDefinition,
    events: { ...events(), onClose },
  });
  const unrelatedLease = pool.acquire({
    ...acquireOptions(unrelatedClient, vi.fn()),
    definition: unrelatedDefinition,
    projectRoot: "/other-project",
  });
  const sharedLeaseClient = await sharedLease.connectedClient();
  await unrelatedLease.connectedClient();

  await pool.invalidateAuthentication(sharedDefinition);

  expect(sharedClient.close).toHaveBeenCalledOnce();
  expect(unrelatedClient.close).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  await expect(sharedLeaseClient.listTools()).rejects.toThrow(
    "Pi MCP Session Lease is no longer active",
  );
  await unrelatedLease.release("quit");
});

test("invalidates a client after an externally detected authentication change", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  let connectionEvents: McpHostClientEvents | undefined;
  const onClose = vi.fn();
  const lease = pool.acquire({
    ...acquireOptions(client, (events) => {
      connectionEvents = events;
    }),
    events: { ...events(), onClose },
  });
  await lease.connectedClient();

  connectionEvents?.onError(new UnauthorizedError());
  await vi.waitFor(() => expect(client.close).toHaveBeenCalledOnce());

  expect(onClose).toHaveBeenCalledOnce();
});

test("reconciles removed Server Definitions before a replacement session", async () => {
  const pool = new McpClientPool();
  const client = new RecordingPoolClient();
  const lease = pool.acquire(acquireOptions(client, vi.fn()));
  await lease.connectedClient();
  await lease.release("handoff");

  await pool.reconcileProject({
    connectTimeoutMs: 10_000,
    definitions: [],
    projectRoot: "/project",
    projectTrusted: true,
    requestTimeoutMs: 60_000,
  });

  expect(client.close).toHaveBeenCalledOnce();
});

test("returns one ABI-compatible process MCP Client Pool", async () => {
  const first = await processMcpClientPool();
  const second = await processMcpClientPool();

  expect(second).toBe(first);
  await first.closeAll();
});

test("closes an incompatible process MCP Client Pool before replacing it", async () => {
  const previous = globalThis.piMcpClientPoolProcessSlot;
  const close = vi.fn(async () => undefined);
  const incompatible = new McpClientPool();
  globalThis.piMcpClientPoolProcessSlot = {
    abi: -1,
    close,
    isActive: () => true,
    pool: incompatible,
  };

  try {
    const replacement = await processMcpClientPool();
    expect(close).toHaveBeenCalledOnce();
    expect(replacement).not.toBe(incompatible);
    expect(globalThis.piMcpClientPoolProcessSlot?.pool).toBe(replacement);
    await replacement.closeAll();
  } finally {
    globalThis.piMcpClientPoolProcessSlot = previous;
  }
});

test("invalidates only the changed Server Definition fingerprint", async () => {
  const pool = new McpClientPool();
  const firstClient = new RecordingPoolClient();
  const secondClient = new RecordingPoolClient();
  const connect = vi.fn<(connectionEvents: McpHostClientEvents) => void>();
  const first = pool.acquire(acquireOptions(firstClient, connect));
  await first.connectedClient();
  await first.release("handoff");

  const second = pool.acquire({
    ...acquireOptions(secondClient, connect),
    definition: { ...definition, environment: { MODE: "changed" } },
  });
  await second.connectedClient();
  await Promise.resolve();

  expect(second.reused).toBe(false);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(firstClient.close).toHaveBeenCalledOnce();
  expect(secondClient.close).not.toHaveBeenCalled();

  await second.release("quit");
});
