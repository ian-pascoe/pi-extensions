import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  DapProtocolClient,
  DapProtocolClientError,
  type DapProtocolClientOptions,
  type DapProtocolObject,
  type DapProtocolTransport,
} from "../src/dap-protocol-client.js";

const fixturePath = resolve(import.meta.dirname, "fixtures/fake-dap-adapter.mjs");
const temporaryDirectories: string[] = [];
const clients: DapProtocolClient[] = [];

// Successful starts return once the adapter listens; a generous budget keeps them reliable under
// parallel `turbo run` load. Startup-timeout tests pass their own short budgets.
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
    timeouts: { startupMs: 5_000, requestMs: 5_000, shutdownMs: 500 },
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

    const response = client.request("echo", { value: 42 });
    expectTypeOf(response).toEqualTypeOf<Promise<DapProtocolObject | undefined>>();
    await expect(response).resolves.toEqual({ value: 42 });
    await expect(client.request("fail")).rejects.toMatchObject({
      kind: "request",
      message: expect.stringContaining("fixture failure"),
    });
    await expect(client.request("echo", { afterFailure: true })).resolves.toEqual({
      afterFailure: true,
    });
  });

  test("builds failed request text from the adapter error format", async () => {
    const client = await createClient();

    await expect(client.request("fail-error-format")).rejects.toMatchObject({
      kind: "request",
      message:
        "DAP Protocol Client: fail-error-format request failed: ReferenceError: nope is not defined (nope, {missing}) (adapter fixture)",
    });
  });

  test("omits the adapter stderr path from failed requests while stderr is empty", async () => {
    const client = await createClient();

    await expect(client.request("fail")).rejects.toMatchObject({
      message: expect.not.stringContaining("stderr"),
    });
  });

  test("names the adapter stderr path on failed requests once stderr has content", async () => {
    const client = await createClient();

    await expect(client.request("fail-with-stderr")).rejects.toMatchObject({
      kind: "request",
      message: expect.stringContaining(`stderr ${client.stderrPath}`),
    });
  });

  test("tracks the shared adapter stderr on failures from a target channel", async () => {
    const port = await unusedTcpPort();
    const root = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_MULTI_CONNECT: "1" },
      transport: tcpTransport(port),
    });
    const target = await root.connectTargetChannel();

    await expect(target.request("fail")).rejects.toMatchObject({
      message: expect.not.stringContaining("stderr"),
    });
    await expect(target.request("fail-with-stderr")).rejects.toMatchObject({
      message: expect.stringContaining(`stderr ${root.stderrPath}`),
    });
    await target.shutdown();
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
      timeouts: { startupMs: 5_000, requestMs: 30, shutdownMs: 500 },
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

      const result = await client.request("inspect");

      expect(client.selectedPort).toBeGreaterThan(0);
      expect(result).toMatchObject({
        argv: expect.arrayContaining([
          `port=${String(client.selectedPort)}/${String(client.selectedPort)}`,
        ]),
        port: String(client.selectedPort),
        inherited: "inherited",
      });
      expect(result).not.toHaveProperty("removed");
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

    const result = await client.request("inspect");

    expect(client.selectedPort).toBe(port);
    expect(result).toMatchObject({ port: String(port) });
  });

  test("retries a TCP connection until the Debug Adapter listens", async () => {
    const client = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_LISTEN_DELAY_MS: "80" },
      transport: tcpTransport(),
      timeouts: { startupMs: 5_000, requestMs: 200, shutdownMs: 500 },
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
      .poll(() => readFile(client.stderrPath, "utf8"), { timeout: 10_000 })
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
    // The tail is written asynchronously; wait for the adapter's last bytes rather than a fixed delay.
    await expect
      .poll(
        async () => (await readFile(client.stderrPath)).toString("utf8").endsWith("LATEST-STDERR"),
        {
          timeout: 10_000,
        },
      )
      .toBe(true);
    const stderr = await readFile(client.stderrPath);

    expect(stderr.length).toBe(1024 * 1024);
  });

  test("awaits graceful DAP shutdown and process exit", async () => {
    const client = await createClient();
    const pid = client.adapterPid;

    await client.shutdown();
    await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
  });

  test("forces an uncooperative Debug Adapter process down within shutdownMs", async () => {
    const client = await createClient({
      environment: { FAKE_IGNORE_SHUTDOWN: "1", FAKE_IGNORE_SIGTERM: "1" },
      timeouts: { startupMs: 5_000, requestMs: 25, shutdownMs: 250 },
    });
    const pid = client.adapterPid;
    // A response means the fixture has installed its SIGTERM handler; a signal sent before that
    // would end it by default and hide a missing SIGKILL.
    await client.request("echo", { value: "ready" }, { timeoutMs: 10_000 });
    // Every wait in shutdown is a timer bounded by shutdownMs, so on a fake clock it resolves at the
    // same clock time however slowly the runner handles the real process I/O in between.
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const startedAt = Date.now();
      let settled = false;
      const shutdown = client.shutdown().finally(() => {
        settled = true;
      });
      while (!settled) {
        // Move the clock only while shutdown waits on a timer; otherwise let real I/O finish.
        if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1);
        else await new Promise((resolveDelay) => realSetTimeout(resolveDelay, 1));
      }
      await shutdown;
      expect(Date.now() - startedAt).toBeLessThanOrEqual(250);
    } finally {
      vi.useRealTimers();
    }

    // The fixture ignores DAP shutdown, SIGTERM, and stdin closing, so only SIGKILL ends it.
    await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
  });
});
