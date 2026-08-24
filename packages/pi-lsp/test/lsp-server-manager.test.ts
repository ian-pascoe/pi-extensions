import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  normalizeLspFilePath,
  routeLspServersForFile,
  type LspAncestorDirectory,
  type LspManagedServerClient,
  LspServerManager,
  type LspServerRoutingDefinition,
  type LspServerStartInput,
} from "../src/lsp-server-manager.js";
import type { LspServerDefinition, ResolvedLspSettings } from "../src/pi-lsp-settings.js";

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
  test("normalizes Pi's leading path sigil", () => {
    expect(normalizeLspFilePath("@src/example.ts")).toBe("src/example.ts");
    expect(normalizeLspFilePath("src/example.ts")).toBe("src/example.ts");
  });

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
  test("reports configured servers without starting them", async () => {
    const { cwd } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });

    expect(manager.getStatus()).toEqual({
      servers: [{ serverId: "typescript", state: "configured" }],
      warnings: [],
    });
    expect(factory.inputs).toEqual([]);
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
