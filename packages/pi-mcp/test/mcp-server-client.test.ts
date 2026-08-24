import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { McpServerClient } from "../src/mcp-server-client.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(testDirectory, "fixtures/mcp-server-client-stdio.mjs");
const httpFixturePath = join(testDirectory, "fixtures/mcp-server-client-http.mjs");
const clients: McpServerClient[] = [];
const fixtureProcesses: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

async function startHttpFixture(mode: "http" | "sse"): Promise<string> {
  const fixture = spawn(process.execPath, [httpFixturePath, mode], {
    cwd: join(testDirectory, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixtureProcesses.push(fixture);
  return new Promise((resolvePort, rejectPort) => {
    fixture.once("error", rejectPort);
    fixture.stdout?.once("data", (chunk: Buffer) => {
      const port = Number(chunk.toString("utf8").trim());
      if (!Number.isInteger(port)) rejectPort(new Error("HTTP fixture returned an invalid port"));
      else resolvePort(`http://127.0.0.1:${port}`);
    });
  });
}

async function closeFixtureProcess(fixture: ChildProcess): Promise<void> {
  if (fixture.exitCode !== null || fixture.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => fixture.once("exit", () => resolveExit()));
  fixture.kill("SIGTERM");
  await exited;
}

async function connectStdioClient(
  fixtureMode = "serve",
  options: {
    readonly connectTimeoutMs?: number;
    readonly onStderr?: (text: string) => void;
    readonly requestTimeoutMs?: number;
  } = {},
): Promise<McpServerClient> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-client-"));
  temporaryDirectories.push(cwd);
  const connectOptions = {
    clientInfo: { name: "pi-mcp-test", version: "1.0.0" },
    connectTimeoutMs: options.connectTimeoutMs ?? 1_000,
    definition: {
      args: [fixturePath, fixtureMode],
      command: process.execPath,
      cwd: ".",
      environment: { PI_MCP_CLIENT_FIXTURE: "configured" },
      transport: "stdio" as const,
    },
    piCwd: cwd,
    requestTimeoutMs: options.requestTimeoutMs ?? 200,
  };
  const client = await McpServerClient.connect(
    options.onStderr === undefined
      ? connectOptions
      : { ...connectOptions, onStderr: options.onStderr },
  );
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(fixtureProcesses.splice(0).map(closeFixtureProcess));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  delete process.env.PI_MCP_UNSAFE_INHERIT;
});

describe("McpServerClient", () => {
  test("owns one auto-negotiated stdio client with safe environment, cwd, stderr, and cleanup", async () => {
    process.env.PI_MCP_UNSAFE_INHERIT = "must-not-leak";
    const stderr: string[] = [];
    const client = await connectStdioClient("serve", {
      onStderr: (text) => stderr.push(text),
    });

    const result = await client.run((sdk, requestOptions) =>
      sdk.listTools(undefined, requestOptions),
    );
    const stateDescription = result.tools.find((tool) => tool.name === "state")?.description;
    if (stateDescription === undefined) throw new Error("Fixture state tool is missing");

    expect(client.protocolEra).toBe("legacy");
    expect(client.negotiatedProtocolVersion).toBe("2025-06-18");
    expect(client.instructions).toBe("fixture instructions");
    expect(JSON.parse(stateDescription)).toEqual({
      cwd: expect.stringContaining("pi-mcp-client-"),
      customEnvironment: "configured",
      hasPath: true,
    });
    expect(stderr.join("")).toContain("pid:");

    const processId = client.processId;
    expect(processId).toBeTypeOf("number");
    await client.close();
    await client.close();
    if (processId !== undefined) {
      expect(() => process.kill(processId, 0)).toThrow();
    }
  });

  test("resets the request timeout on progress and forwards AbortSignal cancellation", async () => {
    const client = await connectStdioClient("serve", { requestTimeoutMs: 70 });
    const progress: number[] = [];

    const completed = await client.run(
      (sdk, requestOptions) =>
        sdk.callTool({ name: "progress", arguments: { intervalMs: 40 } }, requestOptions),
      { onProgress: ({ progress: value }) => progress.push(value) },
    );
    expect(completed.content).toEqual([{ type: "text", text: "complete" }]);
    expect(progress.slice(0, 2)).toEqual([1, 2]);

    const abortController = new AbortController();
    const cancelled = client.run(
      (sdk, requestOptions) => sdk.callTool({ name: "never", arguments: {} }, requestOptions),
      { signal: abortController.signal },
    );
    setTimeout(() => abortController.abort(), 20);
    await expect(cancelled).rejects.toThrow(/abort/i);
  });

  test("enforces request and connect timeouts without retaining the stdio child", async () => {
    const client = await connectStdioClient("serve", { requestTimeoutMs: 30 });
    await expect(
      client.run((sdk, requestOptions) =>
        sdk.callTool({ name: "never", arguments: {} }, requestOptions),
      ),
    ).rejects.toThrow(/timed out/i);

    const stderr: string[] = [];
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-client-hang-"));
    temporaryDirectories.push(cwd);
    await expect(
      McpServerClient.connect({
        clientInfo: { name: "pi-mcp-test", version: "1.0.0" },
        connectTimeoutMs: 40,
        definition: {
          args: [fixturePath, "hang"],
          command: process.execPath,
          environment: {},
          transport: "stdio",
        },
        onStderr: (text) => stderr.push(text),
        piCwd: cwd,
        requestTimeoutMs: 100,
      }),
    ).rejects.toThrow(/timed out|abort/i);
    const processId = Number(/pid:(\d+)/.exec(stderr.join(""))?.[1]);
    if (Number.isInteger(processId)) expect(() => process.kill(processId, 0)).toThrow();
  });

  test("keeps parallel request callbacks and Pi contexts isolated", async () => {
    const client = await connectStdioClient();
    const serial = await client.run(
      (sdk, requestOptions) => sdk.callTool({ name: "sample", arguments: {} }, requestOptions),
      {
        callbacks: {
          onSampling: (_request, piContext) => ({
            content: { type: "text", text: piContext },
            model: "pi-context-fixture",
            role: "assistant",
            stopReason: "endTurn",
          }),
        },
        piContext: "serial-context",
      },
    );
    expect(serial.content).toEqual([{ type: "text", text: "serial-context" }]);

    const callbackContexts: string[] = [];
    const callWithContext = (piContext: string) =>
      client.run(
        (sdk, requestOptions) => sdk.callTool({ name: "sample", arguments: {} }, requestOptions),
        {
          callbacks: {
            onSampling: (_request, context) => {
              callbackContexts.push(context);
              return {
                content: { type: "text", text: context },
                model: "pi-context-fixture",
                role: "assistant",
                stopReason: "endTurn",
              };
            },
          },
          piContext,
        },
      );
    const parallel = await Promise.all([callWithContext("left"), callWithContext("right")]);
    expect(callbackContexts).toEqual(["left", "right"]);
    expect(parallel.map((result) => result.content[0])).toEqual([
      { type: "text", text: "left" },
      { type: "text", text: "right" },
    ]);
  });

  test("reports unexpected connection closure and rejects later operations", async () => {
    let notifyClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolveClosed) => {
      notifyClosed = resolveClosed;
    });
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-client-close-"));
    temporaryDirectories.push(cwd);
    const client = await McpServerClient.connect({
      clientInfo: { name: "pi-mcp-test", version: "1.0.0" },
      connectTimeoutMs: 1_000,
      definition: {
        args: [fixturePath, "close-after-initialize"],
        command: process.execPath,
        environment: {},
        transport: "stdio",
      },
      onConnectionClose: () => notifyClosed?.(),
      piCwd: cwd,
      requestTimeoutMs: 100,
    });
    clients.push(client);

    await closed;
    await expect(client.run((sdk, requestOptions) => sdk.ping(requestOptions))).rejects.toThrow(
      "Pi MCP Client is not connected",
    );
  });

  test("connects Streamable HTTP as modern and explicit SSE as legacy without fallback", async () => {
    const httpUrl = await startHttpFixture("http");
    const httpClient = await McpServerClient.connect({
      clientInfo: { name: "pi-mcp-test", version: "1.0.0" },
      connectTimeoutMs: 1_000,
      definition: { headers: { "x-fixture": "http-header" }, transport: "http", url: httpUrl },
      piCwd: process.cwd(),
      requestTimeoutMs: 1_000,
    });
    clients.push(httpClient);
    expect(httpClient.protocolEra).toBe("modern");
    const httpResult = await httpClient.run((sdk, requestOptions) =>
      sdk.callTool({ name: "state", arguments: {} }, requestOptions),
    );
    expect(httpResult.content).toEqual([{ type: "text", text: "http-ok:http-header" }]);

    const sseUrl = await startHttpFixture("sse");
    const sseClient = await McpServerClient.connect({
      clientInfo: { name: "pi-mcp-test", version: "1.0.0" },
      connectTimeoutMs: 1_000,
      definition: {
        headers: { "x-fixture": "sse-header" },
        transport: "sse",
        url: `${sseUrl}/sse`,
      },
      piCwd: process.cwd(),
      requestTimeoutMs: 1_000,
    });
    clients.push(sseClient);
    expect(sseClient.protocolEra).toBe("legacy");
    expect(sseClient.instructions).toBe("sse fixture instructions");
    const sseResult = await sseClient.run((sdk, requestOptions) =>
      sdk.callTool({ name: "state", arguments: {} }, requestOptions),
    );
    expect(sseResult.content).toEqual([{ type: "text", text: "sse-ok:sse-header" }]);

    await expect(
      McpServerClient.connect({
        clientInfo: { name: "pi-mcp-test", version: "1.0.0" },
        connectTimeoutMs: 100,
        definition: { headers: {}, transport: "http", url: `${sseUrl}/sse` },
        piCwd: process.cwd(),
        requestTimeoutMs: 100,
      }),
    ).rejects.toThrow();
  });
});
