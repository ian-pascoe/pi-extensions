import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { LspServerClient, LspServerClientError } from "../src/lsp-server-client.js";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { LspInputError } from "../src/lsp-input-error.js";
import {
  routeLspServersForFile,
  type LspAncestorDirectory,
  type LspCapabilityRequirement,
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

  describe("with workspace root markers", () => {
    const workspaceServer: LspServerRoutingDefinition = {
      serverId: "typescript",
      languages: [{ extensions: [".ts"], languageId: "typescript" }],
      rootMarkers: ["package.json"],
      workspaceRootMarkers: ["pnpm-workspace.yaml", ".git"],
    };
    const packageAncestors = (packageName: string): LspAncestorDirectory[] => [
      { entryNames: ["index.ts"], path: `/home/user/repo/packages/${packageName}/src` },
      { entryNames: ["package.json"], path: `/home/user/repo/packages/${packageName}` },
      { entryNames: [packageName], path: "/home/user/repo/packages" },
      { entryNames: ["package.json", "pnpm-workspace.yaml"], path: "/home/user/repo" },
      { entryNames: ["repo", ".git", "package.json"], path: "/home/user" },
      { entryNames: ["user"], path: "/home" },
      { entryNames: ["home", ".git"], path: "/" },
    ];
    const route = (
      definition: LspServerRoutingDefinition,
      ancestorDirectories: readonly LspAncestorDirectory[],
      cwd = "/home/user/repo/packages/a",
    ) =>
      routeLspServersForFile(
        [definition],
        `${ancestorDirectories[0]?.path ?? ""}/index.ts`,
        cwd,
        ancestorDirectories,
        "/home/user",
      ).map(({ rootPath }) => rootPath);

    test("routes files in different packages to the nearest workspace-marker ancestor", () => {
      expect(route(workspaceServer, packageAncestors("a"))).toEqual(["/home/user/repo"]);
      expect(route(workspaceServer, packageAncestors("b"))).toEqual(["/home/user/repo"]);
      // Without workspace root markers, each package keeps its own nearest root.
      const { workspaceRootMarkers: _unset, ...packageServer } = workspaceServer;
      expect(route(packageServer, packageAncestors("a"))).toEqual(["/home/user/repo/packages/a"]);
      expect(route(packageServer, packageAncestors("b"))).toEqual(["/home/user/repo/packages/b"]);
    });

    test("falls back to the nearest root-marker root, then the working directory", () => {
      const withoutWorkspace = packageAncestors("a").map((directory) => ({
        ...directory,
        entryNames: directory.entryNames.filter(
          (name) => name !== "pnpm-workspace.yaml" && name !== ".git",
        ),
      }));
      expect(route(workspaceServer, withoutWorkspace)).toEqual(["/home/user/repo/packages/a"]);
      const markerless = withoutWorkspace.map((directory) => ({ ...directory, entryNames: [] }));
      expect(route(workspaceServer, markerless, "/home/user/repo/../repo")).toEqual([
        "/home/user/repo",
      ]);
    });

    test("keeps the Activation Gate on root markers only", () => {
      const gated = { ...workspaceServer, requireRootMarker: true };
      expect(route(gated, packageAncestors("a"))).toEqual(["/home/user/repo"]);
      // A workspace marker alone does not pass the gate.
      const workspaceOnly = packageAncestors("a").map((directory) => ({
        ...directory,
        entryNames: directory.entryNames.filter((name) => name !== "package.json"),
      }));
      expect(route(gated, workspaceOnly)).toEqual([]);
      expect(route(workspaceServer, workspaceOnly)).toEqual(["/home/user/repo"]);
    });

    test("never selects the home directory or above unless the working directory is there", () => {
      const outsideRepository = packageAncestors("a").map((directory) =>
        directory.path === "/home/user/repo"
          ? { ...directory, entryNames: ["package.json"] }
          : directory,
      );
      // `/home/user` and `/` hold `.git`, but are out of scope: the root-marker root is used.
      expect(route(workspaceServer, outsideRepository)).toEqual(["/home/user/repo/packages/a"]);
      expect(route(workspaceServer, outsideRepository, "/home/user")).toEqual(["/home/user"]);
      expect(route(workspaceServer, outsideRepository, "/")).toEqual(["/home/user"]);
      // Outside the home directory, only the filesystem root is out of scope.
      const temporary: LspAncestorDirectory[] = [
        { entryNames: ["package.json"], path: "/tmp/repo/packages/a" },
        { entryNames: ["a"], path: "/tmp/repo/packages" },
        { entryNames: ["packages"], path: "/tmp/repo" },
        { entryNames: ["repo", ".git"], path: "/tmp" },
        { entryNames: ["tmp", ".git"], path: "/" },
      ];
      expect(route(workspaceServer, temporary, "/tmp/repo")).toEqual(["/tmp"]);
      expect(route(workspaceServer, temporary.slice(0, 3).concat(temporary[4] ?? []))).toEqual([
        "/tmp/repo/packages/a",
      ]);
    });
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

const anyCapability: LspCapabilityRequirement<RecordingLspClient> = {
  method: "test/any",
  isSupportedBy: () => true,
};
const hoverCapability: LspCapabilityRequirement<RecordingLspClient> = {
  method: "textDocument/hover",
  isSupportedBy: (client) => client.supported,
};

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

function workspaceServerDefinition(id: string): LspServerDefinition {
  return { ...serverDefinition(id), workspaceRootMarkers: ["pnpm-workspace.yaml"] };
}

/** A pnpm-style workspace whose packages `a` and `b` each hold a `package.json`. */
async function createMonorepoFixture(): Promise<{ cwd: string; filePath: string }> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-monorepo-"));
  temporaryDirectories.push(cwd);
  await writeFile(resolve(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(resolve(cwd, "package.json"), "{}\n");
  for (const name of ["a", "b"]) {
    await mkdir(resolve(cwd, "packages", name, "src"), { recursive: true });
    await writeFile(resolve(cwd, "packages", name, "package.json"), "{}\n");
    await writeFile(resolve(cwd, "packages", name, "src/index.ts"), "export {};\n");
  }
  return { cwd, filePath: resolve(cwd, "packages/a/src/index.ts") };
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
    expect(manager.getStatus().servers).toMatchObject([
      { serverId: "typescript", rootPath: otherRoot, state: "running" },
      { serverId: "typescript", rootPath: resolve(cwd, "packages/example"), state: "stopped" },
    ]);
    expect((await manager.getCapabilities("typescript", filePath)).kind).toBe("success");
    expect(factory.clients).toHaveLength(3);
    await manager.shutdown();
  });

  test("reads no ancestor directories for a file no server language handles", async () => {
    const { cwd } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const directoriesRead: string[] = [];
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
      readDirectory: async (directoryPath) => {
        directoriesRead.push(directoryPath);
        return readdir(directoryPath);
      },
    });

    const result = await manager.runRead(
      resolve(cwd, "notes.md"),
      undefined,
      anyCapability,
      async () => "ok",
    );
    expect(result.failures.map(({ code }) => code)).toEqual(["no-matching-server"]);
    expect(directoriesRead).toEqual([]);
    expect(factory.clients).toEqual([]);

    // A handled language still routes through its ancestor directories.
    await manager.getCapabilities("typescript", resolve(cwd, "root.ts"));
    expect(directoriesRead[0]).toBe(cwd);
    await manager.shutdown();
  });

  test("lists ancestor directories only when an enabled matching Server Definition has root markers", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const markerFree = (id: string) => ({ ...serverDefinition(id), rootMarkers: [] });
    const settings = (definitions: readonly LspServerDefinition[]): ResolvedLspSettings => ({
      ...resolvedSettings([]),
      servers: new Map(definitions.map((definition) => [definition.id, definition])),
    });
    const directoriesRead: string[] = [];
    const createManager = (definitions: readonly LspServerDefinition[]) =>
      new LspServerManager({
        cwd,
        settings: settings(definitions),
        startClient: createRecordingClientFactory().start,
        readDirectory: async (directoryPath) => {
          directoriesRead.push(directoryPath);
          return readdir(directoryPath);
        },
      });

    // Marker-free definitions root at the working directory without listing anything.
    const markerFreeManager = createManager([markerFree("lint"), markerFree("spell")]);
    const routed = await markerFreeManager.runRead(
      filePath,
      undefined,
      anyCapability,
      async (_client, route) => route.rootPath,
    );
    expect(routed.successes.map(({ serverId, value }) => [serverId, value])).toEqual([
      ["lint", cwd],
      ["spell", cwd],
    ]);
    expect(directoriesRead).toEqual([]);

    // A marker-bearing definition that is disabled or does not match the language is ignored.
    const disabledManager = createManager([markerFree("lint"), serverDefinition("typescript")]);
    await disabledManager.setEnablement(new Map(), new Map([["typescript", false]]));
    await disabledManager.runRead(filePath, undefined, anyCapability, async () => "ok");
    const otherLanguage = {
      ...serverDefinition("python"),
      languages: [{ extensions: [".py"], fileNames: [], languageId: "python" }],
    };
    await createManager([markerFree("lint"), otherLanguage]).runRead(
      filePath,
      undefined,
      anyCapability,
      async () => "ok",
    );
    expect(directoriesRead).toEqual([]);

    // A matching enabled marker-bearing definition lists, and marker-free peers keep the cwd root.
    const mixed = await createManager([markerFree("lint"), serverDefinition("typescript")]).runRead(
      filePath,
      undefined,
      anyCapability,
      async (_client, route) => route.rootPath,
    );
    expect(mixed.successes.map(({ serverId, value }) => [serverId, value])).toEqual([
      ["lint", cwd],
      ["typescript", resolve(cwd, "packages/example")],
    ]);
    expect(directoriesRead[0]).toBe(resolve(cwd, "packages/example/src"));

    // Explicitly requesting a disabled marker-bearing definition still resolves its marker root.
    directoriesRead.length = 0;
    const explicitManager = createManager([serverDefinition("typescript")]);
    await explicitManager.setEnablement(new Map(), new Map([["typescript", false]]));
    const disabled = await explicitManager.runRead(
      filePath,
      "typescript",
      anyCapability,
      async () => "ok",
    );
    expect(disabled.failures.map(({ code }) => code)).toEqual(["server-disabled"]);
    expect(explicitManager.getStatus().servers).toMatchObject([
      { serverId: "typescript", state: "disabled" },
    ]);
    expect(directoriesRead.length).toBeGreaterThan(0);

    // An explicit request decides on the requested definition alone: a marker-bearing peer is not
    // listed for.
    directoriesRead.length = 0;
    const peerManager = createManager([markerFree("lint"), serverDefinition("typescript")]);
    const explicitLint = await peerManager.runRead(
      filePath,
      "lint",
      anyCapability,
      async (_client, route) => route.rootPath,
    );
    expect(explicitLint.successes.map(({ value }) => value)).toEqual([cwd]);
    expect(directoriesRead).toEqual([]);
  });

  test("routes files in two packages to one Server Instance with workspace root markers", async () => {
    const { cwd, filePath } = await createMonorepoFixture();
    const otherFile = resolve(cwd, "packages/b/src/index.ts");
    const startedRoots = async (definition: LspServerDefinition) => {
      const factory = createRecordingClientFactory();
      const manager = new LspServerManager({
        cwd: resolve(cwd, "packages/a"),
        homeDirectory: dirname(cwd),
        settings: { ...resolvedSettings([]), servers: new Map([[definition.id, definition]]) },
        startClient: factory.start,
      });
      await manager.getCapabilities(definition.id, filePath);
      await manager.getCapabilities(definition.id, otherFile);
      await manager.shutdown();
      return factory.inputs.map(({ rootPath }) => rootPath);
    };

    expect(await startedRoots(workspaceServerDefinition("typescript"))).toEqual([cwd]);
    // Without workspace root markers, routing is unchanged: one Server Instance per package.
    expect(await startedRoots(serverDefinition("typescript"))).toEqual([
      resolve(cwd, "packages/a"),
      resolve(cwd, "packages/b"),
    ]);
  });

  test("lists ancestor directories for a definition with only workspace root markers", async () => {
    const { cwd, filePath } = await createMonorepoFixture();
    const directoriesRead: string[] = [];
    const manager = new LspServerManager({
      cwd,
      settings: {
        ...resolvedSettings([]),
        servers: new Map([
          ["typescript", { ...workspaceServerDefinition("typescript"), rootMarkers: [] }],
        ]),
      },
      startClient: createRecordingClientFactory().start,
      readDirectory: async (directoryPath) => {
        directoriesRead.push(directoryPath);
        return readdir(directoryPath);
      },
    });

    const routed = await manager.runRead(
      filePath,
      undefined,
      anyCapability,
      async (_client, route) => route.rootPath,
    );
    expect(routed.successes.map(({ value }) => value)).toEqual([cwd]);
    expect(directoriesRead[0]).toBe(dirname(filePath));
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
    expect(
      manager.getStatus().servers.filter(({ serverId }) => serverId === "typescript"),
    ).toMatchObject([
      { serverId: "typescript", rootPath: cwd, state: "disabled" },
      { serverId: "typescript", rootPath: resolve(cwd, "packages/example"), state: "disabled" },
    ]);
    expect(manager.getEnablement("typescript")).toEqual({ enabled: false, scope: "session" });
    const automatic = await manager.runRead(filePath, undefined, anyCapability, async () => "ok");
    expect(automatic.successes.map(({ serverId }) => serverId)).toEqual(["lint"]);
    expect(automatic.failures).toEqual([]);
    for (const request of [
      manager.getCapabilities("typescript", filePath),
      manager.restartServer("typescript", filePath),
      manager.runMutation(filePath, "typescript", anyCapability, async () => undefined),
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

  test("names the disabled servers when every Server Definition matching a file is disabled", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript", "lint"]),
      startClient: factory.start,
    });
    await manager.setEnablement(
      new Map([["lint", { enabled: false, scope: "global" }]]),
      new Map(),
    );

    // A mix of enabled and disabled servers skips the disabled ones without a warning.
    const mixedRead = await manager.runRead(filePath, undefined, anyCapability, async () => "ok");
    expect(mixedRead.successes.map(({ serverId }) => serverId)).toEqual(["typescript"]);
    expect(mixedRead.failures).toEqual([]);
    const mixedMutation = await manager.runMutation(
      filePath,
      undefined,
      anyCapability,
      async () => undefined,
    );
    expect(mixedMutation).toMatchObject({
      kind: "success",
      instance: { route: { serverId: "typescript" } },
    });

    await manager.setEnablement(
      new Map([["lint", { enabled: false, scope: "global" }]]),
      new Map([["typescript", false]]),
    );
    const failure = {
      code: "server-disabled",
      message: `Pi LSP: all servers matching ${filePath} are disabled: typescript, lint; enable one with /lsp enable <id>`,
      serverId: "*",
    };
    await expect(
      manager.runRead(filePath, undefined, anyCapability, async () => "ok"),
    ).resolves.toEqual({ failures: [failure], successes: [] });
    await expect(
      manager.runMutation(filePath, undefined, anyCapability, async () => undefined),
    ).resolves.toEqual({ kind: "failure", failure });
    // A file no Server Definition handles still reports that no configured server matches it.
    const unmatched = resolve(cwd, "notes.md");
    await expect(
      manager.runRead(unmatched, undefined, anyCapability, async () => "ok"),
    ).resolves.toMatchObject({
      failures: [
        {
          code: "no-matching-server",
          message: `Pi LSP: no configured server matches ${unmatched}`,
        },
      ],
    });
    expect(factory.clients).toHaveLength(1);
    await manager.shutdown();
  });

  test("reports no matching server when an enabled server fails its Activation Gate beside a disabled one", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const settings = resolvedSettings(["typescript", "gated"]);
    const manager = new LspServerManager({
      cwd,
      settings: {
        ...settings,
        servers: new Map([
          ["typescript", serverDefinition("typescript")],
          [
            "gated",
            { ...serverDefinition("gated"), requireRootMarker: true, rootMarkers: ["deno.json"] },
          ],
        ]),
      },
      startClient: factory.start,
    });
    await manager.setEnablement(new Map(), new Map([["typescript", false]]));

    await expect(
      manager.runRead(filePath, undefined, anyCapability, async () => "ok"),
    ).resolves.toEqual({
      failures: [
        {
          code: "no-matching-server",
          message: `Pi LSP: no configured server matches ${filePath}`,
          serverId: "*",
        },
      ],
      successes: [],
    });
    expect(factory.clients).toEqual([]);
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
    expect(manager.getStatus().servers).toEqual([
      {
        serverId: "typescript",
        state: "disabled",
        languages: [{ extensions: [".ts"], fileNames: [], languageId: "typescript" }],
      },
    ]);
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
    const read = manager.runRead(filePath, undefined, anyCapability, async (_client, route) => {
      if (route.serverId === "lint") healthyRead.resolve();
      return "retained";
    });
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
      anyCapability,
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

  test("classifies a request timeout by the client error kind, not by message text", async () => {
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
      anyCapability,
      async (_client, route) => {
        if (route.serverId === "lint") {
          throw new LspServerClientError(
            "timeout",
            "lint",
            "/tmp/lint.stderr",
            "textDocument/hover expired",
          );
        }
        throw new Error("server says: the build timed out");
      },
    );

    expect(result.failures).toEqual([
      {
        code: "request-timeout",
        message:
          "Pi LSP: server lint request failed: Pi LSP: textDocument/hover expired (server lint; stderr /tmp/lint.stderr)",
        serverId: "lint",
      },
      {
        code: "request-failed",
        message: "Pi LSP: server typescript request failed: server says: the build timed out",
        serverId: "typescript",
      },
    ]);
    await manager.shutdown();
  });

  test("labels a preview request's server failure and propagates input errors and cancellations", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: factory.start,
    });
    const timeout = new LspServerClientError(
      "timeout",
      "typescript",
      "/tmp/typescript.stderr",
      "textDocument/rename timed out",
    );

    await expect(
      manager.runMutation(filePath, undefined, anyCapability, async () => "edit"),
    ).resolves.toMatchObject({
      kind: "success",
      instance: { route: { rootPath: resolve(cwd, "packages/example"), serverId: "typescript" } },
      value: "edit",
    });
    await expect(
      manager.runMutation(filePath, undefined, anyCapability, async () => {
        throw timeout;
      }),
    ).resolves.toEqual({
      kind: "failure",
      failure: {
        code: "request-timeout",
        message: `Pi LSP: server typescript request failed: ${timeout.message}`,
        serverId: "typescript",
      },
    });
    await expect(
      manager.runMutation(filePath, undefined, anyCapability, async () => {
        throw new LspInputError("line 9 is past the end of the document");
      }),
    ).rejects.toBeInstanceOf(LspInputError);
    const cancelled = new LspServerClientError(
      "cancelled",
      "typescript",
      "/tmp/typescript.stderr",
      "request cancelled",
    );
    await expect(
      manager.runMutation(filePath, undefined, anyCapability, async () => {
        throw cancelled;
      }),
    ).rejects.toBe(cancelled);
    await expect(
      manager.runRead(filePath, undefined, anyCapability, async () => {
        throw cancelled;
      }),
    ).rejects.toBe(cancelled);
    await manager.shutdown();
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
      hoverCapability,
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
      hoverCapability,
      async () => "unused",
    );

    expect(result).toEqual({
      failures: [
        {
          code: "no-capable-server",
          message:
            "Pi LSP: no matching server supports textDocument/hover; matching servers without it: lint, typescript",
          serverId: "*",
        },
      ],
      successes: [],
    });
  });

  test("names the capability and the matching servers lacking it when no mutation server is capable", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(async () => new RecordingLspClient(false));
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["first", "second"]),
      startClient: factory.start,
    });

    await expect(
      manager.runMutation(filePath, undefined, hoverCapability, async () => undefined),
    ).resolves.toEqual({
      kind: "failure",
      failure: {
        code: "no-capable-server",
        message:
          "Pi LSP: no matching server supports textDocument/hover; matching servers without it: first, second",
        serverId: "*",
      },
    });
    await expect(
      manager.runMutation(filePath, "second", hoverCapability, async () => undefined),
    ).resolves.toEqual({
      kind: "failure",
      failure: {
        code: "no-capable-server",
        message: "Pi LSP: server second does not support textDocument/hover",
        serverId: "second",
      },
    });
    await manager.shutdown();
  });

  test("reports files no configured server matches and unknown server IDs", async () => {
    const { cwd } = await createRoutedFileFixture();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: createRecordingClientFactory().start,
    });
    const notes = resolve(cwd, "notes.md");

    await expect(
      manager.runRead(notes, undefined, anyCapability, async () => "unused"),
    ).resolves.toEqual({
      failures: [
        {
          code: "no-matching-server",
          message: `Pi LSP: no configured server matches ${notes}`,
          serverId: "*",
        },
      ],
      successes: [],
    });
    await expect(manager.getCapabilities("typescript", notes)).resolves.toMatchObject({
      failure: {
        code: "no-matching-server",
        message: `Pi LSP: server typescript does not match ${notes}`,
      },
    });
    await expect(
      manager.getCapabilities("missing", resolve(cwd, "root.ts")),
    ).resolves.toMatchObject({
      failure: {
        code: "no-matching-server",
        message: "Pi LSP: server missing is not configured",
        serverId: "missing",
      },
    });
    await manager.shutdown();
  });

  test("rejects a read with the input error an operation raises instead of a server failure", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: createRecordingClientFactory().start,
    });

    await expect(
      manager.runRead(filePath, undefined, anyCapability, async () => {
        throw new LspInputError("line 9 is past the end of the document");
      }),
    ).rejects.toThrow(new LspInputError("line 9 is past the end of the document"));
    await manager.shutdown();
  });

  test("waits for every server operation to settle before rejecting a read", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: createRecordingClientFactory().start,
    });
    const inputError = new LspInputError("line 9 is past the end of the document");
    const lateError = new LspInputError("a later input error");
    const settled: string[] = [];

    const read = manager.runRead(filePath, undefined, anyCapability, async (_client, route) => {
      if (route.serverId === "lint") throw inputError;
      // Still running when the other server has already rejected.
      await new Promise((done) => setTimeout(done, 20));
      settled.push(route.serverId);
      throw lateError;
    });

    // The first rejection in time is the one that propagates, once every operation has settled.
    await expect(read).rejects.toBe(inputError);
    expect(settled).toEqual(["typescript"]);
    await manager.shutdown();
  });

  test("waits for the other servers before rejecting a read with a cancellation", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: createRecordingClientFactory().start,
    });
    const cancelled = new LspServerClientError(
      "cancelled",
      "lint",
      "/tmp/lint.stderr",
      "request cancelled",
    );
    const settled: string[] = [];

    const read = manager.runRead(filePath, undefined, anyCapability, async (_client, route) => {
      if (route.serverId === "lint") throw cancelled;
      await new Promise((done) => setTimeout(done, 20));
      settled.push(route.serverId);
      return "late value";
    });

    await expect(read).rejects.toBe(cancelled);
    expect(settled).toEqual(["typescript"]);
    await manager.shutdown();
  });

  test("rejects a read without waiting for a server that is still starting", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    let releaseStart: () => void = () => undefined;
    const startGate = new Promise<void>((release) => {
      releaseStart = release;
    });
    const factory = createRecordingClientFactory(async ({ definition }) => {
      if (definition.id === "typescript") await startGate;
      return new RecordingLspClient();
    });
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: factory.start,
    });
    const started: string[] = [];
    const inputError = new LspInputError("line 9 is past the end of the document");

    // The typescript server never finishes starting while the read runs.
    await expect(
      manager.runRead(filePath, undefined, anyCapability, async (_client, route) => {
        started.push(route.serverId);
        throw inputError;
      }),
    ).rejects.toBe(inputError);

    releaseStart();
    await new Promise((done) => setTimeout(done, 10));
    // Once ready, the late server does not run an operation for the rejected read.
    expect(started).toEqual(["lint"]);
    await manager.shutdown();
  });

  test("reports an explicitly selected incapable read server", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const factory = createRecordingClientFactory(async () => new RecordingLspClient(false));
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["lint", "typescript"]),
      startClient: factory.start,
    });

    const result = await manager.runRead(filePath, "lint", hoverCapability, async () => "unused");

    expect(result).toEqual({
      failures: [
        {
          code: "no-capable-server",
          message: "Pi LSP: server lint does not support textDocument/hover",
          serverId: "lint",
        },
      ],
      successes: [],
    });
  });

  test("reports startup failures and the capability incapable servers lack when no read succeeds", async () => {
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
      hoverCapability,
      async () => "unused",
    );

    expect(result).toMatchObject({
      failures: [
        { code: "server-unavailable", serverId: "typescript" },
        {
          code: "no-capable-server",
          message:
            "Pi LSP: no matching server supports textDocument/hover; matching servers without it: lint",
          serverId: "*",
        },
      ],
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

    const ambiguous = await manager.runMutation(
      filePath,
      undefined,
      hoverCapability,
      async () => undefined,
    );
    expect(ambiguous).toMatchObject({
      failure: { code: "ambiguous-server" },
      kind: "failure",
    });

    const selected = await manager.runMutation(
      filePath,
      "second",
      hoverCapability,
      async () => undefined,
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
    expect(manager.getStatus().servers).toMatchObject([
      { serverId: "typescript", state: "configured" },
    ]);
  });
});

describe("other workspace roots of a Server Definition", () => {
  test("finds known Server Instance roots and root-marker directories beside the searched root", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const searchedRoot = resolve(cwd, "packages/example");
    for (const directory of ["packages/other", "packages/example/nested"]) {
      await mkdir(resolve(cwd, directory), { recursive: true });
      await writeFile(resolve(cwd, directory, "package.json"), "{}\n");
    }
    // Dependency and hidden directories are not workspace roots.
    for (const directory of ["node_modules/dependency", ".cache/copy"]) {
      await mkdir(resolve(cwd, directory), { recursive: true });
      await writeFile(resolve(cwd, directory, "package.json"), "{}\n");
    }
    const elsewhere = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-elsewhere-"));
    temporaryDirectories.push(elsewhere);
    await writeFile(resolve(elsewhere, "package.json"), "{}\n");
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript", "unrelated"]),
      startClient: createRecordingClientFactory().start,
    });
    await manager.getCapabilities("typescript", filePath);
    await manager.getCapabilities("typescript", resolve(elsewhere, "outside.ts"));
    // Another Server Definition's root at cwd is not a typescript root.
    await manager.getCapabilities("unrelated", resolve(cwd, "top.ts"));

    expect(await manager.findOtherWorkspaceRoots("typescript", searchedRoot)).toEqual({
      rootPaths: [
        elsewhere,
        resolve(cwd, "packages/example/nested"),
        resolve(cwd, "packages/other"),
      ].sort((left, right) => left.localeCompare(right)),
      hasMore: false,
    });
    await manager.shutdown();
  });

  test("finds sibling roots above a working directory inside a package before any Instance starts", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-repo-"));
    temporaryDirectories.push(parent);
    const repo = resolve(parent, "repo");
    const searchedRoot = resolve(repo, "packages/a");
    for (const directory of [repo, searchedRoot, resolve(repo, "packages/b")]) {
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "package.json"), "{}\n");
    }
    await mkdir(resolve(searchedRoot, "src"));
    // Beside the repository, above its outermost marker directory: never searched.
    await mkdir(resolve(parent, "unrelated"));
    await writeFile(resolve(parent, "unrelated/package.json"), "{}\n");

    for (const cwd of [searchedRoot, resolve(searchedRoot, "src"), repo]) {
      const manager = new LspServerManager({
        cwd,
        settings: resolvedSettings(["typescript"]),
        startClient: createRecordingClientFactory().start,
      });
      expect(await manager.findOtherWorkspaceRoots("typescript", searchedRoot), cwd).toEqual({
        rootPaths: [repo, resolve(repo, "packages/b")],
        hasMore: false,
      });
    }
  });

  test("does not start discovery at the home directory or above it", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-home-"));
    temporaryDirectories.push(home);
    const repo = resolve(home, "code/repo");
    const searchedRoot = resolve(repo, "packages/a");
    for (const directory of [
      home,
      repo,
      searchedRoot,
      resolve(repo, "packages/b"),
      resolve(home, "code/other"),
      resolve(home, "Downloads/x"),
    ]) {
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "package.json"), "{}\n");
    }
    const findFrom = (cwd: string) =>
      new LspServerManager({
        cwd,
        homeDirectory: home,
        settings: resolvedSettings(["typescript"]),
        startClient: createRecordingClientFactory().start,
      }).findOtherWorkspaceRoots("typescript", searchedRoot);

    // A marker in the home directory does not widen discovery beyond the repository.
    const repoOnly = { rootPaths: [repo, resolve(repo, "packages/b")], hasMore: false };
    expect(await findFrom(repo)).toEqual(repoOnly);
    expect(await findFrom(searchedRoot)).toEqual(repoOnly);
    // A working directory at the home directory chose that scope itself.
    expect((await findFrom(home)).rootPaths).toEqual(
      [
        home,
        repo,
        resolve(repo, "packages/b"),
        resolve(home, "code/other"),
        resolve(home, "Downloads/x"),
      ].sort((left, right) => left.localeCompare(right)),
    );
  });

  test("starts discovery at the outermost marker ancestor, not the nearest", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-nested-"));
    temporaryDirectories.push(parent);
    const repo = resolve(parent, "repo");
    const searchedRoot = resolve(repo, "packages/a/app");
    for (const directory of [
      repo,
      resolve(repo, "packages"),
      resolve(repo, "packages/a"),
      searchedRoot,
      resolve(repo, "tools/b"),
    ]) {
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "package.json"), "{}\n");
    }
    const manager = new LspServerManager({
      cwd: searchedRoot,
      settings: resolvedSettings(["typescript"]),
      startClient: createRecordingClientFactory().start,
    });

    expect(await manager.findOtherWorkspaceRoots("typescript", searchedRoot)).toEqual({
      rootPaths: [
        repo,
        resolve(repo, "packages"),
        resolve(repo, "packages/a"),
        resolve(repo, "tools/b"),
      ],
      hasMore: false,
    });
  });

  test("reports none from a working directory inside the only root", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const searchedRoot = resolve(cwd, "packages/example");
    const manager = new LspServerManager({
      cwd: dirname(filePath),
      settings: resolvedSettings(["typescript"]),
      startClient: createRecordingClientFactory().start,
    });

    expect(await manager.findOtherWorkspaceRoots("typescript", searchedRoot)).toEqual({
      rootPaths: [],
      hasMore: false,
    });
  });

  test("counts only directories that route to a different root under workspace root markers", async () => {
    const { cwd, filePath } = await createMonorepoFixture();
    // A nested, independent workspace routes its packages to its own root.
    const nested = resolve(cwd, "vendor/tool");
    await mkdir(resolve(nested, "packages/x"), { recursive: true });
    await writeFile(resolve(nested, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(resolve(nested, "packages/x/package.json"), "{}\n");
    const manager = new LspServerManager({
      cwd: resolve(cwd, "packages/a"),
      homeDirectory: dirname(cwd),
      settings: {
        ...resolvedSettings([]),
        servers: new Map([["typescript", workspaceServerDefinition("typescript")]]),
      },
      startClient: createRecordingClientFactory().start,
    });
    await manager.getCapabilities("typescript", filePath);
    await manager.getCapabilities("typescript", resolve(cwd, "packages/b/src/index.ts"));

    // Package directories inside the searched workspace root are not other roots.
    expect(await manager.findOtherWorkspaceRoots("typescript", cwd)).toEqual({
      rootPaths: [nested],
      hasMore: false,
    });
    await rm(nested, { force: true, recursive: true });
    expect(await manager.findOtherWorkspaceRoots("typescript", cwd)).toEqual({
      rootPaths: [],
      hasMore: false,
    });
    await manager.shutdown();
  });

  test("finds workspace packages whose files the Server Instance has not synchronized", async () => {
    const { cwd, filePath } = await createMonorepoFixture();
    for (const directory of ["packages/c", "packages/c/nested/d", "vendor/tool/packages/x"]) {
      await mkdir(resolve(cwd, directory), { recursive: true });
      await writeFile(resolve(cwd, directory, "package.json"), "{}\n");
    }
    // A nested workspace routes to its own Server Instance; its packages are not this root's.
    await writeFile(resolve(cwd, "vendor/tool/pnpm-workspace.yaml"), "packages: []\n");
    const synchronized: string[] = [];
    const createManager = (definition: LspServerDefinition) =>
      new LspServerManager({
        cwd,
        homeDirectory: dirname(cwd),
        settings: { ...resolvedSettings([]), servers: new Map([[definition.id, definition]]) },
        startClient: createRecordingClientFactory().start,
      });
    const manager = createManager(workspaceServerDefinition("typescript"));
    const loaded = { queriedFilePath: filePath, synchronizedFilePaths: () => synchronized };
    const find = (rootPath = cwd) => manager.findWorkspaceScope("typescript", rootPath, loaded);

    // Before the Server Instance starts, only the queried file's package counts as loaded.
    expect(await find()).toEqual({
      otherRoots: { rootPaths: [resolve(cwd, "vendor/tool")], hasMore: false },
      unloadedPackages: {
        packageRoots: [
          resolve(cwd, "packages/b"),
          resolve(cwd, "packages/c"),
          resolve(cwd, "packages/c/nested/d"),
        ],
        hasMore: false,
      },
    });
    await manager.getCapabilities("typescript", filePath);
    // A document belongs to its nearest package root only.
    synchronized.push(resolve(cwd, "packages/c/nested/d/x.ts"));
    expect((await find()).unloadedPackages?.packageRoots).toEqual([
      resolve(cwd, "packages/b"),
      resolve(cwd, "packages/c"),
    ]);
    synchronized.push(resolve(cwd, "packages/b/src/index.ts"), resolve(cwd, "packages/c/x.ts"));
    expect((await find()).unloadedPackages).toEqual({ packageRoots: [], hasMore: false });
    // Only a root selected by a workspace root marker is checked.
    expect((await find(resolve(cwd, "packages/a"))).unloadedPackages).toBeUndefined();
    await manager.shutdown();

    const packageScope = await createManager(serverDefinition("typescript")).findWorkspaceScope(
      "typescript",
      resolve(cwd, "packages/a"),
      loaded,
    );
    expect(packageScope.unloadedPackages).toBeUndefined();
    // Without root markers there are no package roots to search for.
    const markerFreeScope = await createManager({
      ...workspaceServerDefinition("typescript"),
      rootMarkers: [],
    }).findWorkspaceScope("typescript", cwd, loaded);
    expect(markerFreeScope).toEqual({
      otherRoots: { rootPaths: [resolve(cwd, "vendor/tool")], hasMore: false },
    });
  });

  test("keeps directories cut from a workspace walk out of the other-roots result", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-cut-"));
    temporaryDirectories.push(parent);
    // An outer marker directory puts discovery's base above the workspace root.
    await writeFile(resolve(parent, "package.json"), "{}\n");
    await mkdir(resolve(parent, "other"));
    const workspaceRoot = resolve(parent, "repo");
    await mkdir(workspaceRoot);
    await writeFile(resolve(workspaceRoot, "pnpm-workspace.yaml"), "packages: []\n");
    for (const name of ["a", "b"]) {
      await mkdir(resolve(workspaceRoot, "packages", name, "src"), { recursive: true });
      await writeFile(resolve(workspaceRoot, "packages", name, "package.json"), "{}\n");
    }
    const scope = (directoryLimit: number) =>
      new LspServerManager({
        cwd: workspaceRoot,
        homeDirectory: dirname(parent),
        settings: {
          ...resolvedSettings([]),
          servers: new Map([["typescript", workspaceServerDefinition("typescript")]]),
        },
        startClient: createRecordingClientFactory().start,
        rootDiscoveryDirectoryLimit: directoryLimit,
      }).findWorkspaceScope("typescript", workspaceRoot, {
        queriedFilePath: resolve(workspaceRoot, "packages/a/src/index.ts"),
        synchronizedFilePaths: () => [],
      });

    const packageB = resolve(workspaceRoot, "packages/b");
    // The workspace root's six directories are walked first, then the parent and `other`.
    expect(await scope(100)).toEqual({
      otherRoots: { rootPaths: [parent], hasMore: false },
      unloadedPackages: { packageRoots: [packageB], hasMore: false },
    });
    // The workspace root is complete; `other`, outside it, is unchecked.
    expect(await scope(7)).toEqual({
      otherRoots: { rootPaths: [parent], hasMore: true },
      unloadedPackages: { packageRoots: [packageB], hasMore: false },
    });
    // The parent, an ancestor of the workspace root, is unchecked: only other roots are incomplete.
    expect(await scope(6)).toEqual({
      otherRoots: { rootPaths: [], hasMore: true },
      unloadedPackages: { packageRoots: [packageB], hasMore: false },
    });
    // Directories inside the workspace root are unchecked too: both are incomplete.
    expect(await scope(5)).toEqual({
      otherRoots: { rootPaths: [], hasMore: true },
      unloadedPackages: { packageRoots: [packageB], hasMore: true },
    });
    expect(await scope(1)).toEqual({
      otherRoots: { rootPaths: [], hasMore: true },
      unloadedPackages: { packageRoots: [], hasMore: true },
    });
  });

  test.each([".worktrees", "node_modules", "linked"])(
    "walks a workspace root under a %s directory that discovery skips",
    async (skippedName) => {
      const repo = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-skipped-"));
      temporaryDirectories.push(repo);
      await mkdir(resolve(repo, ".git"));
      await writeFile(resolve(repo, "package.json"), "{}\n");
      let skippedParent = resolve(repo, skippedName);
      if (skippedName === "linked") {
        const target = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-link-target-"));
        temporaryDirectories.push(target);
        await symlink(target, skippedParent, "dir");
      } else {
        await mkdir(skippedParent);
      }
      // A git worktree checkout: its `.git` is a file.
      const workspaceRoot = resolve(skippedParent, "x");
      await mkdir(resolve(workspaceRoot, "packages/b"), { recursive: true });
      await writeFile(resolve(workspaceRoot, ".git"), "gitdir: elsewhere\n");
      await writeFile(resolve(workspaceRoot, "package.json"), "{}\n");
      await writeFile(resolve(workspaceRoot, "packages/b/package.json"), "{}\n");
      const manager = new LspServerManager({
        cwd: workspaceRoot,
        homeDirectory: dirname(repo),
        settings: {
          ...resolvedSettings([]),
          servers: new Map([
            ["typescript", { ...serverDefinition("typescript"), workspaceRootMarkers: [".git"] }],
          ]),
        },
        startClient: createRecordingClientFactory().start,
      });

      expect(
        await manager.findWorkspaceScope("typescript", workspaceRoot, {
          queriedFilePath: resolve(workspaceRoot, "index.ts"),
          synchronizedFilePaths: () => [],
        }),
      ).toEqual({
        otherRoots: { rootPaths: [repo], hasMore: false },
        unloadedPackages: {
          packageRoots: [resolve(workspaceRoot, "packages/b")],
          hasMore: false,
        },
      });
    },
  );

  test("walks a workspace root first when the working directory holds many repositories", async () => {
    const code = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-code-"));
    temporaryDirectories.push(code);
    for (let index = 0; index < 10; index++) {
      await mkdir(resolve(code, `repo-${index}/src`), { recursive: true });
    }
    const workspaceRoot = resolve(code, "repo-z");
    await mkdir(resolve(workspaceRoot, "packages/b"), { recursive: true });
    await writeFile(resolve(workspaceRoot, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(resolve(workspaceRoot, "packages/b/package.json"), "{}\n");
    const manager = new LspServerManager({
      cwd: code,
      homeDirectory: dirname(code),
      settings: {
        ...resolvedSettings([]),
        servers: new Map([["typescript", workspaceServerDefinition("typescript")]]),
      },
      startClient: createRecordingClientFactory().start,
      rootDiscoveryDirectoryLimit: 6,
    });

    // The working directory is the discovery base; its other repositories exhaust the limit.
    expect(
      await manager.findWorkspaceScope("typescript", workspaceRoot, {
        queriedFilePath: resolve(workspaceRoot, "index.ts"),
        synchronizedFilePaths: () => [],
      }),
    ).toEqual({
      otherRoots: { rootPaths: [], hasMore: true },
      unloadedPackages: { packageRoots: [resolve(workspaceRoot, "packages/b")], hasMore: false },
    });
  });

  test("stops other-root discovery inside a batch once enough roots are found", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-manager-batch-"));
    temporaryDirectories.push(cwd);
    const children = Array.from({ length: 40 }, (_, index) => `c${String(index).padStart(2, "0")}`);
    for (const child of children) await mkdir(resolve(cwd, child));
    for (const child of children.slice(34)) {
      await writeFile(resolve(cwd, child, "package.json"), "{}\n");
    }
    // Listed in the same batch as c32-c39, but after them in walk order.
    await mkdir(resolve(cwd, "c00/a"));
    await writeFile(resolve(cwd, "c00/a/package.json"), "{}\n");
    const manager = new LspServerManager({
      cwd,
      homeDirectory: dirname(cwd),
      settings: resolvedSettings(["typescript"]),
      startClient: createRecordingClientFactory().start,
    });

    expect(await manager.findOtherWorkspaceRoots("typescript", cwd)).toEqual({
      rootPaths: ["c34", "c35", "c36", "c37", "c38"].map((child) => resolve(cwd, child)),
      hasMore: true,
    });
  });

  test("reports none when the searched root is the only root", async () => {
    const { cwd, filePath } = await createRoutedFileFixture();
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: createRecordingClientFactory().start,
    });
    await manager.getCapabilities("typescript", filePath);

    expect(
      await manager.findOtherWorkspaceRoots("typescript", resolve(cwd, "packages/example")),
    ).toEqual({ rootPaths: [], hasMore: false });
    await manager.shutdown();
  });

  test("reports none for a Server Definition without root markers", async () => {
    const { cwd } = await createRoutedFileFixture();
    const settings = resolvedSettings(["typescript"]);
    const manager = new LspServerManager({
      cwd,
      settings: {
        ...settings,
        servers: new Map([["typescript", { ...serverDefinition("typescript"), rootMarkers: [] }]]),
      },
      startClient: createRecordingClientFactory().start,
    });

    expect(await manager.findOtherWorkspaceRoots("typescript", cwd)).toEqual({
      rootPaths: [],
      hasMore: false,
    });
  });

  test("lists a bounded number of other roots and reports that more exist", async () => {
    const { cwd } = await createRoutedFileFixture();
    for (let index = 0; index < 8; index++) {
      await mkdir(resolve(cwd, `packages/sibling-${index}`), { recursive: true });
      await writeFile(resolve(cwd, `packages/sibling-${index}/package.json`), "{}\n");
    }
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: createRecordingClientFactory().start,
    });

    const roots = await manager.findOtherWorkspaceRoots(
      "typescript",
      resolve(cwd, "packages/example"),
    );
    expect(roots.rootPaths).toHaveLength(5);
    expect(roots.rootPaths).not.toContain(resolve(cwd, "packages/example"));
    expect(roots.hasMore).toBe(true);
  });

  test("reports that more roots may exist when discovery stops at its directory limit", async () => {
    const { cwd } = await createRoutedFileFixture();
    // More directories than the lowered discovery limit, none holding a root marker.
    await Promise.all(
      ["wide/0", "wide/1", "wide/2", "wide/3"].map((directory) =>
        mkdir(resolve(cwd, directory), { recursive: true }),
      ),
    );
    const manager = new LspServerManager({
      cwd,
      settings: resolvedSettings(["typescript"]),
      startClient: createRecordingClientFactory().start,
      rootDiscoveryDirectoryLimit: 3,
    });

    expect(
      await manager.findOtherWorkspaceRoots("typescript", resolve(cwd, "packages/example")),
    ).toEqual({ rootPaths: [], hasMore: true });
  });
});
