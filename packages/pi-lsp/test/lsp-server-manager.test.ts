import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { LspServerClient } from "../src/lsp-server-client.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  routeLspServersForFile,
  type LspAncestorDirectory,
  type LspManagedServerClient,
  LspServerManager,
  type LspServerRoutingDefinition,
  type LspServerStartInput,
} from "../src/lsp-server-manager.js";
import type {
  LspServerDefinition,
  LspServerEnablement,
  ResolvedLspSettings,
} from "../src/pi-lsp-settings.js";

const configuredServers: readonly LspServerRoutingDefinition[] = [
  {
    serverId: "typescript",
    languages: [
      { extensions: [".ts", ".mts", ".cts"], languageId: "typescript" },
      { extensions: [".tsx"], languageId: "typescriptreact" },
    ],
    rootMarkers: ["tsconfig*.json", "package.json", ".git"],
  },
  {
    serverId: "linting",
    languages: [{ fileNames: ["eslint.config.js"], languageId: "javascript" }],
    rootMarkers: ["package.json"],
  },
  {
    serverId: "shared-typescript",
    languages: [{ extensions: [".ts"], languageId: "typescript" }],
  },
];

const ancestors: readonly LspAncestorDirectory[] = [
  { entryNames: ["source.ts"], path: "/workspace/packages/app/src" },
  { entryNames: ["package.json"], path: "/workspace/packages/app" },
  { entryNames: ["tsconfig.base.json", ".git"], path: "/workspace" },
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LSP server file routing", () => {
  test("matches file extensions and exact filenames", () => {
    expect(
      routeLspServersForFile(
        configuredServers,
        "@/workspace/packages/app/src/source.ts",
        "/fallback",
        ancestors,
      ).map(({ language, serverId }) => [serverId, language.languageId]),
    ).toEqual([
      ["typescript", "typescript"],
      ["shared-typescript", "typescript"],
    ]);
    expect(
      routeLspServersForFile(
        configuredServers,
        "/workspace/eslint.config.js",
        "/fallback",
        ancestors,
      ).map(({ serverId }) => serverId),
    ).toEqual(["linting"]);
  });

  test("selects the nearest ancestor whose basename matches a root-marker glob", () => {
    const routes = routeLspServersForFile(
      configuredServers,
      "/workspace/packages/app/src/source.ts",
      "/fallback",
      ancestors,
    );
    expect(routes[0]?.rootPath).toBe("/workspace/packages/app");
  });

  test("uses cwd when no root marker matches or the server has no markers", () => {
    const routes = routeLspServersForFile(
      configuredServers,
      "/workspace/packages/app/src/source.ts",
      "/fallback/relative/..",
      [{ entryNames: [], path: "/workspace/packages/app/src" }],
    );
    expect(routes.map(({ rootPath }) => rootPath)).toEqual(["/fallback", "/fallback"]);
  });

  test("excludes only definitions that require a missing root marker", () => {
    const routes = routeLspServersForFile(
      [
        {
          languages: [{ extensions: [".ts"], languageId: "typescript" }],
          requireRootMarker: true,
          rootMarkers: ["tsconfig.json"],
          serverId: "gated",
        },
        {
          languages: [{ extensions: [".ts"], languageId: "typescript" }],
          rootMarkers: ["tsconfig.json"],
          serverId: "fallback",
        },
      ],
      "/workspace/source.ts",
      "/workspace",
      [{ entryNames: ["source.ts"], path: "/workspace" }],
    );

    expect(routes).toEqual([
      {
        language: { extensions: [".ts"], languageId: "typescript" },
        rootPath: "/workspace",
        serverId: "fallback",
      },
    ]);
  });

  test("keeps all matching servers in deterministic definition order", () => {
    const routes = routeLspServersForFile(
      [...configuredServers].reverse(),
      "/workspace/packages/app/src/source.ts",
      "/fallback",
      ancestors,
    );
    expect(routes.map(({ serverId }) => serverId)).toEqual(["shared-typescript", "typescript"]);
  });

  test("uses only the first matching language mapping from one Server Definition", () => {
    const routes = routeLspServersForFile(
      [
        {
          languages: [
            { extensions: [".ts"], languageId: "typescript" },
            { extensions: [".ts"], languageId: "duplicate" },
          ],
          serverId: "typescript",
        },
      ],
      "/workspace/source.ts",
      "/workspace",
      ancestors,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.language.languageId).toBe("typescript");
  });
});

class RecordingLspClient implements LspManagedServerClient {
  readonly capabilities: { readonly hoverProvider: boolean };
  shutdownCount = 0;

  constructor(readonly supported = true) {
    this.capabilities = { hoverProvider: supported };
  }

  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }
}

interface RecordingClientFactory {
  readonly clients: RecordingLspClient[];
  readonly inputs: LspServerStartInput[];
  readonly start: (input: LspServerStartInput) => Promise<RecordingLspClient>;
}

function createRecordingClientFactory(
  startBehavior: (
    input: LspServerStartInput,
    startIndex: number,
  ) => Promise<RecordingLspClient> = async () => new RecordingLspClient(),
): RecordingClientFactory {
  const clients: RecordingLspClient[] = [];
  const inputs: LspServerStartInput[] = [];
  return {
    clients,
    inputs,
    start: async (input) => {
      const startIndex = inputs.length;
      inputs.push(input);
      const client = await startBehavior(input, startIndex);
      clients.push(client);
      return client;
    },
  };
}

function serverDefinition(id: string): LspServerDefinition {
  return {
    args: ["--stdio"],
    command: `${id}-server`,
    environment: {},
    id,
    languages: [{ extensions: [".ts"], fileNames: [], languageId: "typescript" }],
    requireRootMarker: false,
    rootMarkers: ["package.json"],
  };
}

function resolvedSettings(serverIds: readonly string[]): ResolvedLspSettings {
  return {
    enablement: new Map(),
    servers: new Map(serverIds.map((serverId) => [serverId, serverDefinition(serverId)])),
    timeouts: {
      diagnosticsMs: 3000,
      initializeMs: 45000,
      requestMs: 3000,
      shutdownMs: 5000,
    },
    warnings: [],
  };
}

async function createRoutedFileFixture(): Promise<{ cwd: string; filePath: string }> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-"));
  temporaryDirectories.push(cwd);
  const sourceDirectory = resolve(cwd, "packages/example/src");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(resolve(cwd, "packages/example/package.json"), "{}\n");
  const filePath = resolve(sourceDirectory, "example.ts");
  await writeFile(filePath, "export const value = 1;\n");
  return { cwd, filePath };
}

describe("session-scoped LSP server manager", () => {
  test("stops only the selected root and starts it lazily on the next request", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const otherRoot = resolve(cwd, "other");
    await mkdir(otherRoot);
    await writeFile(resolve(otherRoot, "package.json"), "{}");
    const otherFile = resolve(otherRoot, "other.ts");
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });
    await manager.getCapabilities("typescript", filePath);
    await manager.getCapabilities("typescript", otherFile);

    await manager.stopServer("typescript", resolve(cwd, "packages/example"));
    expect(factory.clients.map((client) => client.shutdownCount)).toEqual([1, 0]);
    expect(manager.getStatus().servers).toEqual([
      { serverId: "typescript", rootPath: otherRoot, state: "running" },
      { serverId: "typescript", rootPath: resolve(cwd, "packages/example"), state: "stopped" },
    ]);
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("success");
    expect(factory.clients).toHaveLength(3);
    await manager.shutdown();
  });

  test("disables every root, excludes automatic routing, and blocks explicit startup until enabled", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript", "lint"]),
      startClient: factory.start,
    });
    await manager.getCapabilities("typescript", filePath);
    await manager.getCapabilities("typescript", resolve(cwd, "root.ts"));

    await manager.setEnablement(new Map(), new Map([["typescript", false]]));
    expect(factory.clients.map((client) => client.shutdownCount)).toEqual([1, 1]);
    expect(manager.getStatus().servers.filter(({ serverId }) => serverId === "typescript")).toEqual(
      [
        { serverId: "typescript", rootPath: cwd, state: "disabled" },
        { serverId: "typescript", rootPath: resolve(cwd, "packages/example"), state: "disabled" },
      ],
    );
    expect(manager.getEnablement("typescript")).toEqual({ enabled: false, scope: "session" });
    const automatic = await manager.runRead(
      filePath,
      undefined,
      () => true,
      async () => "ok",
    );
    expect(automatic.successes.map(({ serverId }) => serverId)).toEqual(["lint"]);
    expect(automatic.failures).toEqual([]);
    for (const request of [
      manager.getCapabilities("typescript", filePath),
      manager.restartServer("typescript", filePath),
      manager.resolveMutationClient(filePath, "typescript", () => true),
    ]) {
      await expect(request).resolves.toMatchObject({
        kind: "failure",
        failure: { code: "server-disabled" },
      });
    }
    expect(factory.clients).toHaveLength(3);

    await manager.setEnablement(new Map(), new Map([["typescript", true]]));
    expect(factory.clients).toHaveLength(3);
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("success");
    expect(factory.clients).toHaveLength(4);
    await manager.shutdown();
  });

  test("ignores late failures from a stopped process after a fresh lazy startup", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });
    await manager.getCapabilities("typescript", filePath);
    await manager.stopServer("typescript", resolve(cwd, "packages/example"));
    await manager.getCapabilities("typescript", filePath);
    factory.inputs[0]?.onUnavailable(new Error("old process exited"));

    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("success");
    expect(manager.getStatus().servers[0]?.state).toBe("running");
    expect(factory.clients).toHaveLength(2);
    await manager.shutdown();
  });

  test("a disable during startup retires that process before a re-enabled request can start afresh", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const pendingStart = Promise.withResolvers<RecordingLspClient>();
    const factory = createRecordingClientFactory(async (_input, index) =>
      index === 0 ? pendingStart.promise : new RecordingLspClient(),
    );
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });
    const firstRequest = manager.getCapabilities("typescript", filePath);
    await expect.poll(() => factory.inputs.length).toBe(1);

    const disabling = manager.setEnablement(new Map(), new Map([["typescript", false]]));
    await expect(manager.getCapabilities("typescript", filePath)).resolves.toMatchObject({
      kind: "failure",
      failure: { code: "server-disabled" },
    });
    await manager.setEnablement(new Map(), new Map([["typescript", true]]));
    const nextRequest = manager.getCapabilities("typescript", filePath);
    pendingStart.resolve(new RecordingLspClient());

    expect((await firstRequest).kind).toBe("failure");
    await disabling;
    expect((await nextRequest).kind).toBe("success");
    expect(factory.clients.map((client) => client.shutdownCount)).toEqual([1, 0]);
    expect(manager.getStatus().servers[0]?.state).toBe("running");
    await manager.shutdown();
  });

  test("the existing restart tool ignores teardown failures from the old process", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(
      async (input) =>
        new (class extends RecordingLspClient {
          override async shutdown(): Promise<void> {
            await super.shutdown();
            input.onUnavailable(new Error("old transport closed"));
          }
        })(),
    );
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });
    await manager.getCapabilities("typescript", filePath);

    expect((await manager.restartServer("typescript", filePath)).kind).toBe("success");
    expect(factory.clients.map((client) => client.shutdownCount)).toEqual([1, 0]);
    await manager.shutdown();
  });

  test("shutdown retires pending startup and prevents late requests from starting another process", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const pendingStart = Promise.withResolvers<RecordingLspClient>();
    const factory = createRecordingClientFactory(async () => pendingStart.promise);
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });
    const firstRequest = manager.getCapabilities("typescript", filePath);
    await expect.poll(() => factory.inputs.length).toBe(1);
    const shuttingDown = manager.shutdown();
    pendingStart.resolve(new RecordingLspClient());

    expect((await firstRequest).kind).toBe("failure");
    await shuttingDown;
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("failure");
    expect(factory.clients.map((client) => client.shutdownCount)).toEqual([1]);
  });

  test("removing a branch override restores configured eligibility without eager startup", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const configured = new Map<string, LspServerEnablement>([
      ["typescript", { enabled: false, scope: "project" }],
    ]);
    const manager = new LspServerManager({
      cwd,
      settings: { ...resolvedSettings(["typescript"]), enablement: configured },
      startClient: factory.start,
    });
    expect(manager.getStatus().servers).toEqual([{ serverId: "typescript", state: "disabled" }]);
    await manager.setEnablement(configured, new Map([["typescript", true]]));
    expect(manager.getEnablement("typescript")).toEqual({ enabled: true, scope: "session" });
    expect(factory.clients).toHaveLength(0);
    await manager.getCapabilities("typescript", filePath);

    await manager.setEnablement(configured, new Map());
    expect(manager.getEnablement("typescript")).toEqual({ enabled: false, scope: "project" });
    expect(factory.clients[0]?.shutdownCount).toBe(1);
    await manager.setEnablement(new Map(), new Map());
    expect(manager.getEnablement("typescript")).toEqual({ enabled: true, scope: "default" });
    expect(factory.clients).toHaveLength(1);
    await manager.shutdown();
  });

  test("disabling clears a failed startup so enabling allows a fresh lazy attempt", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(async (_input, index) => {
      if (index === 0) throw new Error("first startup failed");
      return new RecordingLspClient();
    });
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("failure");
    await manager.setEnablement(new Map(), new Map([["typescript", false]]));
    expect(manager.getStatus().servers[0]).toMatchObject({ state: "disabled" });
    expect(manager.getStatus().servers[0]?.error).toBeUndefined();
    await manager.setEnablement(new Map(), new Map([["typescript", true]]));
    expect(factory.inputs).toHaveLength(1);
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("success");
    expect(factory.inputs).toHaveLength(2);
    await manager.shutdown();
  });

  test("disabling cancels a real process still waiting for initialize", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const stderrPath = resolve(cwd, "startup.stderr");
    const settings = resolvedSettings(["typescript"]);
    const manager = new LspServerManager({
      cwd,
      settings,
      startClient: ({ definition, rootPath, timeouts, onUnavailable, signal }) =>
        LspServerClient.start({
          serverId: definition.id,
          rootPath,
          command: process.execPath,
          args: ["-e", "process.stderr.write(String(process.pid)); process.stdin.resume();"],
          environment: process.env,
          initializationOptions: null,
          settings: null,
          timeouts: { ...timeouts, initializeMs: 2_000 },
          stderrPath,
          onUnavailable,
          signal,
        }),
    });
    const request = manager.getCapabilities("typescript", filePath);
    try {
      await expect.poll(async () => readFile(stderrPath, "utf8").catch(() => "")).not.toBe("");
      await manager.setEnablement(new Map(), new Map([["typescript", false]]));
      await expect(request).resolves.toMatchObject({
        kind: "failure",
        failure: { message: expect.stringContaining("request cancelled") },
      });
      const pid = Number(await readFile(stderrPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(manager.getStatus().servers[0]?.state).toBe("disabled");
    } finally {
      await manager.shutdown();
      await request;
    }
  });

  test("disable cancels a backpressured configuration notification after initialize has replied", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const stderrPath = resolve(cwd, "configuration.stderr");
    const fixturePath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: ({ definition, rootPath, timeouts, onUnavailable, signal }) =>
        LspServerClient.start({
          serverId: definition.id,
          rootPath,
          command: process.execPath,
          args: [fixturePath],
          environment: { ...process.env, FAKE_BLOCK_CONFIGURATION: "1" },
          initializationOptions: null,
          settings: { large: "x".repeat(1024 * 1024) },
          timeouts: { ...timeouts, initializeMs: 10_000, shutdownMs: 100 },
          stderrPath,
          onUnavailable,
          signal,
        }),
    });
    const request = manager.getCapabilities("typescript", filePath);
    let pid: number | undefined;
    try {
      await expect.poll(async () => readFile(stderrPath, "utf8").catch(() => "")).not.toBe("");
      const processId = Number(await readFile(stderrPath, "utf8"));
      pid = processId;
      let stopped = false;
      const disabling = manager
        .setEnablement(new Map(), new Map([["typescript", false]]))
        .then(() => {
          stopped = true;
        });
      await expect.poll(() => stopped, { timeout: 2_000 }).toBe(true);
      await disabling;
      await expect(request).resolves.toMatchObject({
        kind: "failure",
        failure: { message: expect.stringContaining("request cancelled") },
      });
      expect(() => process.kill(processId, 0)).toThrow();
      pid = undefined;
    } finally {
      // Also reap the deliberately blocked fixture when the cancellation regression fails.
      if (pid !== undefined) {
        try {
          process.kill(pid);
        } catch {
          /* Already reaped by startup cancellation. */
        }
      }
      await manager.shutdown();
      await request;
    }
  });

  test("retains healthy read results when a concurrent stop fails", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const shutdown = Promise.withResolvers<void>();
    const healthyRead = Promise.withResolvers<void>();
    const factory = createRecordingClientFactory(
      async ({ definition }) =>
        new (class extends RecordingLspClient {
          override async shutdown(): Promise<void> {
            if (definition.id === "typescript") await shutdown.promise;
            await super.shutdown();
          }
        })(),
    );
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript", "lint"]),
      startClient: factory.start,
    });
    await manager.getCapabilities("typescript", filePath);
    const stopped = expect(
      manager.stopServer("typescript", resolve(cwd, "packages/example")),
    ).rejects.toThrow("teardown failed");
    const read = manager.runRead(
      filePath,
      undefined,
      () => true,
      async (_client, route) => {
        if (route.serverId === "lint") healthyRead.resolve();
        return "retained";
      },
    );
    await healthyRead.promise;
    shutdown.reject(new Error("teardown failed"));
    await stopped;
    await expect(read).resolves.toMatchObject({
      successes: [{ serverId: "lint", value: "retained" }],
      failures: [
        {
          serverId: "typescript",
          code: "server-unavailable",
          message: expect.stringContaining("teardown failed"),
        },
      ],
    });
    await manager.shutdown();
  });

  test("re-evaluates required root markers and explains explicit activation failures", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const definition = {
      ...serverDefinition("typescript"),
      requireRootMarker: true,
      rootMarkers: ["tsconfig.json"],
    };
    const settings = {
      ...resolvedSettings([]),
      servers: new Map([[definition.id, definition]]),
    };
    const manager = new LspServerManager({ cwd, settings, startClient: factory.start });

    await expect(manager.getCapabilities("typescript", filePath)).resolves.toMatchObject({
      failure: {
        code: "root-marker-not-found",
        message: expect.stringContaining("required root marker not found"),
      },
      kind: "failure",
    });
    expect(factory.inputs).toEqual([]);

    await writeFile(resolve(cwd, "packages/example/tsconfig.json"), "{}");
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("success");
    expect(factory.inputs).toHaveLength(1);

    await rm(resolve(cwd, "packages/example/tsconfig.json"));
    await expect(manager.getCapabilities("typescript", filePath)).resolves.toMatchObject({
      failure: { code: "root-marker-not-found" },
      kind: "failure",
    });
    expect(factory.clients[0]?.shutdownCount).toBe(0);
  });

  test("deduplicates concurrent startup for one server ID and root", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    let releaseStart: ((client: RecordingLspClient) => void) | undefined;
    const factory = createRecordingClientFactory(
      async () =>
        new Promise<RecordingLspClient>((resolveClient) => {
          releaseStart = resolveClient;
        }),
    );
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });

    const first = manager.getCapabilities("typescript", filePath);
    const second = manager.getCapabilities("typescript", filePath);
    for (let attempt = 0; attempt < 100 && factory.inputs.length === 0; attempt++) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 1));
    }
    expect(factory.inputs).toHaveLength(1);
    releaseStart?.(new RecordingLspClient());
    expect((await first).kind).toBe("success");
    expect((await second).kind).toBe("success");
  });

  test("keeps startup failure unavailable until an explicit restart", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    let failStartup = true;
    const factory = createRecordingClientFactory(async () => {
      if (failStartup) throw new Error("fixture startup failed");
      return new RecordingLspClient();
    });
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });

    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("failure");
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("failure");
    expect(factory.inputs).toHaveLength(1);
    expect(manager.getStatus().servers[0]).toMatchObject({
      error: "fixture startup failed",
      state: "unavailable",
    });

    failStartup = false;
    expect((await manager.restartServer("typescript", filePath)).kind).toBe("success");
    expect(factory.inputs).toHaveLength(2);
    expect(manager.getStatus().servers[0]?.state).toBe("running");
  });

  test("retains successful multi-server reads when a sibling request fails", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: factory.start,
    });

    const result = await manager.runRead(
      filePath,
      undefined,
      () => true,
      async (_client, route) => {
        if (route.serverId === "lint") throw new Error("fixture request failed");
        return "definition.ts:1:1";
      },
    );

    expect(result.successes).toEqual([
      {
        rootPath: resolve(cwd, "packages/example"),
        serverId: "typescript",
        value: "definition.ts:1:1",
      },
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({ code: "request-failed", serverId: "lint" }),
    ]);
  });

  test("omits incapable servers from automatic reads", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(
      async ({ definition }) => new RecordingLspClient(definition.id === "typescript"),
    );
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: factory.start,
    });

    const result = await manager.runRead(
      filePath,
      undefined,
      (client) => client.supported,
      async (_client, route) => route.serverId,
    );

    expect(result).toEqual({
      failures: [],
      successes: [
        {
          rootPath: resolve(cwd, "packages/example"),
          serverId: "typescript",
          value: "typescript",
        },
      ],
    });
  });

  test("reports one failure when no automatic read server is capable", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(async () => new RecordingLspClient(false));
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: factory.start,
    });

    const result = await manager.runRead(
      filePath,
      undefined,
      (client) => client.supported,
      async () => "unused",
    );

    expect(result).toEqual({
      failures: [
        {
          code: "no-capable-server",
          message: "Pi LSP: no matching server supports the requested read operation",
          serverId: "*",
        },
      ],
      successes: [],
    });
  });

  test("reports an explicitly selected incapable read server", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(async () => new RecordingLspClient(false));
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: factory.start,
    });

    const result = await manager.runRead(
      filePath,
      "lint",
      (client) => client.supported,
      async () => "unused",
    );

    expect(result).toMatchObject({
      failures: [{ code: "no-capable-server", serverId: "lint" }],
      successes: [],
    });
  });

  test("preserves startup failures while omitting incapable automatic read servers", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(async ({ definition }) => {
      if (definition.id === "typescript") throw new Error("fixture startup failed");
      return new RecordingLspClient(false);
    });
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: factory.start,
    });

    const result = await manager.runRead(
      filePath,
      undefined,
      (client) => client.supported,
      async () => "unused",
    );

    expect(result).toMatchObject({
      failures: [{ code: "server-unavailable", serverId: "typescript" }],
      successes: [],
    });
  });

  test("requires exactly one capable instance when mutation server_id is omitted", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(async () => new RecordingLspClient(true));
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["first", "second"]),
      startClient: factory.start,
    });

    const ambiguous = await manager.resolveMutationClient(
      filePath,
      undefined,
      (client) => client.supported,
    );
    expect(ambiguous).toMatchObject({
      failure: { code: "ambiguous-server" },
      kind: "failure",
    });

    const selected = await manager.resolveMutationClient(
      filePath,
      "second",
      (client) => client.supported,
    );
    expect(selected).toMatchObject({
      instance: { route: { serverId: "second" } },
      kind: "success",
    });
  });

  test("marks later process failure sticky and shuts down every tracked client", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });

    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("success");
    factory.inputs[0]?.onUnavailable(new Error("fixture process exited"));
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("failure");
    expect(manager.getStatus().servers[0]).toMatchObject({
      error: "fixture process exited",
      state: "unavailable",
    });

    await manager.shutdown();
    expect(factory.clients[0]?.shutdownCount).toBe(1);
    expect(manager.getStatus().servers).toEqual([{ serverId: "typescript", state: "configured" }]);
  });
});
