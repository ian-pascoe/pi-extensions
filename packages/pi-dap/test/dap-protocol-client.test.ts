import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import {
  DapProtocolClient,
  DapProtocolClientError,
  type DapProtocolClientOptions,
  type DapProtocolTransport,
} from "../src/dap-protocol-client.js";

const fixturePath = resolve(import.meta.dirname, "fixtures/fake-dap-adapter.mjs");
const temporaryDirectories: string[] = [];
const clients: DapProtocolClient[] = [];

async function createClient(
  overrides: Partial<DapProtocolClientOptions> = {},
): Promise<DapProtocolClient> {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-dap-protocol-"));
  temporaryDirectories.push(directory);
  const client = await DapProtocolClient.start({
    adapterId: "fixture",
    cwd: directory,
    command: process.execPath,
    args: [fixturePath],
    environment: {},
    transport: "stdio",
    timeouts: { startupMs: 500, requestMs: 1_000, shutdownMs: 500 },
    stderrPath: resolve(directory, "adapter.stderr.log"),
    ...overrides,
  });
  clients.push(client);
  return client;
}

async function unusedTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null) throw new Error("missing TCP address");
  // SAFETY: A TCP server listening on a numeric port returns AddressInfo rather than a pipe name.
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return port;
}

function tcpTransport(port = 0): DapProtocolTransport {
  return { type: "tcp", host: "127.0.0.1", port };
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number | undefined): Promise<void> {
  for (let attempt = 0; attempt < 50 && processExists(pid); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DapProtocolClient", () => {
  test("correlates successful and failed responses over stdio", async () => {
    const client = await createClient();

    await expect(client.request<{ value: number }>("echo", { value: 42 })).resolves.toEqual({
      value: 42,
    });
    await expect(client.request("fail")).rejects.toMatchObject({
      kind: "request",
      message: expect.stringContaining("fixture failure"),
    });
    await expect(client.request("echo", { afterFailure: true })).resolves.toEqual({
      afterFailure: true,
    });
  });

  test("parses coalesced event and response frames", async () => {
    const client = await createClient();
    const event = client.waitForEvent("fixture");

    await expect(client.request("coalesced")).resolves.toEqual({ coalesced: true });
    await expect(event).resolves.toMatchObject({ event: "fixture", body: { coalesced: true } });
  });

  test("parses response frames across arbitrary chunk boundaries", async () => {
    const client = await createClient();

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 1, maxLength: 12 }),
        fc.integer(),
        async (chunks, value) => {
          await expect(client.request("fragment", { chunks, value })).resolves.toEqual({ value });
        },
      ),
      { numRuns: 30 },
    );
  });

  test.each([
    ["malformed-header", "malformed"],
    ["missing-header", "Content-Length"],
    ["malformed-json", "malformed JSON"],
    ["invalid-envelope", "invalid protocol envelope"],
    ["oversize", "8 MiB"],
  ])("rejects %s input before it enters session logic", async (mode, message) => {
    const client = await createClient({ environment: { FAKE_MODE: mode } });

    await expect(client.request("echo", {})).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining(message),
    });
  });

  test("times out one request without losing the live client", async () => {
    const client = await createClient({
      timeouts: { startupMs: 500, requestMs: 30, shutdownMs: 500 },
    });

    await expect(client.request("hang")).rejects.toMatchObject({ kind: "timeout" });
    await expect(client.request("echo", { recovered: true }, { timeoutMs: 500 })).resolves.toEqual({
      recovered: true,
    });
  });

  test("cancels one request wait without losing the live client", async () => {
    const client = await createClient();
    const controller = new AbortController();
    const request = client.request("hang", {}, { signal: controller.signal });

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
    await expect(client.request("echo", { recovered: true })).resolves.toEqual({ recovered: true });
  });

  test("cancels an event wait without losing the live client", async () => {
    const client = await createClient();
    const controller = new AbortController();
    const event = client.waitForEvent("never", { signal: controller.signal });

    controller.abort();

    await expect(event).rejects.toMatchObject({ kind: "cancelled" });
    await expect(client.request("echo", { recovered: true })).resolves.toEqual({ recovered: true });
  });

  test("handles and rejects reverse requests through the configured callback", async () => {
    const client = await createClient({
      onReverseRequest: (request) =>
        request.command === "runInTerminal"
          ? { success: true, body: { processId: 1234 } }
          : { success: false, message: "child Debug Sessions are unsupported" },
    });

    await expect(client.request("reverse", { command: "runInTerminal" })).resolves.toEqual({
      reverseSuccess: true,
      reverseBody: { processId: 1234 },
    });
    await expect(client.request("reverse", { command: "startDebugging" })).resolves.toEqual({
      reverseSuccess: false,
      reverseMessage: "child Debug Sessions are unsupported",
    });
  });

  test("substitutes every dynamic TCP port token and injects PORT", async () => {
    process.env.DAP_FIXTURE_INHERITED = "inherited";
    process.env.DAP_FIXTURE_REMOVED = "remove-me";
    try {
      const client = await createClient({
        args: [fixturePath, "--tcp", "$PORT", "port=$PORT/$PORT"],
        environment: { DAP_FIXTURE_REMOVED: null },
        transport: tcpTransport(),
      });

      const result = await client.request<{
        argv: string[];
        inherited?: string;
        pid: number;
        port: string;
        removed?: string;
      }>("inspect");

      expect(client.selectedPort).toBeGreaterThan(0);
      expect(result.argv).toContain(
        `port=${String(client.selectedPort)}/${String(client.selectedPort)}`,
      );
      expect(result.port).toBe(String(client.selectedPort));
      expect(result.inherited).toBe("inherited");
      expect(result.removed).toBeUndefined();
    } finally {
      delete process.env.DAP_FIXTURE_INHERITED;
      delete process.env.DAP_FIXTURE_REMOVED;
    }
  });

  test("uses a configured fixed TCP port", async () => {
    const port = await unusedTcpPort();
    const client = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      transport: tcpTransport(port),
    });

    const result = await client.request<{ port: string }>("inspect");

    expect(client.selectedPort).toBe(port);
    expect(result.port).toBe(String(port));
  });

  test("retries a TCP connection until the Debug Adapter listens", async () => {
    const client = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_LISTEN_DELAY_MS: "80" },
      transport: tcpTransport(),
      timeouts: { startupMs: 500, requestMs: 200, shutdownMs: 500 },
    });

    await expect(client.request("echo", { connected: true })).resolves.toEqual({ connected: true });
  });

  test("rejects TCP startup timeout and terminates the spawned process", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-dap-protocol-timeout-"));
    temporaryDirectories.push(directory);

    await expect(
      DapProtocolClient.start({
        adapterId: "fixture",
        cwd: directory,
        command: process.execPath,
        args: [fixturePath, "--tcp", "$PORT"],
        environment: { FAKE_MODE: "no-listen" },
        transport: tcpTransport(),
        timeouts: { startupMs: 60, requestMs: 30, shutdownMs: 100 },
        stderrPath: resolve(directory, "adapter.stderr.log"),
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  test("cancels TCP startup and terminates the spawned process", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-dap-protocol-cancel-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    const startup = DapProtocolClient.start({
      adapterId: "fixture",
      cwd: directory,
      command: process.execPath,
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_MODE: "no-listen" },
      transport: tcpTransport(),
      timeouts: { startupMs: 1000, requestMs: 30, shutdownMs: 100 },
      stderrPath: resolve(directory, "adapter.stderr.log"),
      startupSignal: controller.signal,
    });

    setTimeout(() => controller.abort(), 30);

    await expect(startup).rejects.toMatchObject({ kind: "cancelled" });
  });

  test("rejects $PORT in stdio arguments before spawning", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-dap-protocol-port-"));
    temporaryDirectories.push(directory);

    await expect(
      DapProtocolClient.start({
        adapterId: "fixture",
        cwd: directory,
        command: process.execPath,
        args: [fixturePath, "$PORT"],
        environment: {},
        transport: "stdio",
        timeouts: { startupMs: 100, requestMs: 100, shutdownMs: 100 },
        stderrPath: resolve(directory, "adapter.stderr.log"),
      }),
    ).rejects.toMatchObject({ kind: "transport" });
  });

  test("reports spawn failures with the adapter stderr path", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-dap-protocol-spawn-"));
    temporaryDirectories.push(directory);
    const stderrPath = resolve(directory, "adapter.stderr.log");

    await expect(
      DapProtocolClient.start({
        adapterId: "missing",
        cwd: directory,
        command: resolve(directory, "missing-adapter"),
        args: [],
        environment: {},
        transport: "stdio",
        timeouts: { startupMs: 100, requestMs: 100, shutdownMs: 100 },
        stderrPath,
      }),
    ).rejects.toMatchObject({
      kind: "spawn",
      stderrPath,
      message: expect.stringContaining(stderrPath),
    });
  });

  test("reports unexpected process exit and captures stderr", async () => {
    const client = await createClient();

    const error = await client.request("crash").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DapProtocolClientError);
    expect(error).toMatchObject({ kind: expect.stringMatching(/exit|transport/) });
    await expect
      .poll(() => readFile(client.stderrPath, "utf8"), { timeout: 1_000 })
      .toContain("fixture adapter crashed");
  });

  test("rejects event waiters immediately after a fatal adapter failure", async () => {
    const client = await createClient();
    const event = client.waitForEvent("never", { timeoutMs: 5_000 });

    await expect(client.request("crash")).rejects.toMatchObject({
      kind: expect.stringMatching(/exit|transport/),
    });
    await expect(event).rejects.toMatchObject({
      kind: expect.stringMatching(/exit|transport/),
    });
  });

  test("retains only the latest 1 MiB of Debug Adapter stderr", async () => {
    const client = await createClient();

    await client.request("stderr-crash", { bytes: 1024 * 1024 + 128 }).catch(() => undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const stderr = await readFile(client.stderrPath);

    expect(stderr.length).toBe(1024 * 1024);
    expect(stderr.toString("utf8")).toMatch(/LATEST-STDERR$/);
  });

  test("awaits graceful DAP shutdown and process exit", async () => {
    const client = await createClient();
    const pid = client.adapterPid;

    await client.shutdown();
    await waitForProcessExit(pid);

    expect(processExists(pid)).toBe(false);
  });

  test("forces an uncooperative Debug Adapter process down within shutdownMs", async () => {
    const client = await createClient({
      environment: { FAKE_IGNORE_SHUTDOWN: "1", FAKE_IGNORE_SIGTERM: "1" },
      timeouts: { startupMs: 500, requestMs: 25, shutdownMs: 250 },
    });
    const pid = client.adapterPid;
    const startedAt = Date.now();

    await client.shutdown();
    await waitForProcessExit(pid);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(processExists(pid)).toBe(false);
  });
});
