import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { afterAll, beforeAll, expect, test } from "vitest";
import { LspServerClient } from "../src/lsp-server-client.js";
import { LspServerManager } from "../src/lsp-server-manager.js";
import { resolveLspPreset, withLspPresets } from "../src/lsp-presets.js";
import { pathToFileURL } from "node:url";
import { ESLINT_SERVER_SELECTOR, isOfficialEslintServer } from "../src/lsp-companions.js";

const enabled = process.env.PI_LSP_PRESETS_NATIVE === "1";
let store = "";
beforeAll(async () => {
  // Leave room for Biome's native Unix socket suffix under a disk-backed TMPDIR.
  if (enabled) store = await mkdtemp(join(tmpdir(), "lsp-"));
});
afterAll(async () => {
  if (!store) return;
  try {
    const installer = new ToolInstaller(store);
    for (const id of [
      "oxlint-probe",
      "lsp-oxlint",
      "biome-probe",
      "lsp-biome",
      "eslint-probe",
      "eslint-library-probe",
    ]) {
      const installation = await installer.installed(id);
      if (installation)
        console.info(
          JSON.stringify({
            installation: id,
            platform: process.platform,
            arch: process.arch,
            components: Object.fromEntries(
              Object.entries(installation.components).map(([name, component]) => [
                name,
                component.version,
              ]),
            ),
          }),
        );
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test.skipIf(!enabled)(
  "private Oxlint diagnoses configured projects without enabling type-aware lint implicitly",
  async () => {
    const installer = new ToolInstaller(store);
    const settings = withLspPresets({
      servers: new Map(),
      enablement: new Map(),
      warnings: [],
      timeouts: {
        initializeMs: 10_000,
        requestMs: 5_000,
        diagnosticsMs: 10_000,
        shutdownMs: 2_000,
      },
    });
    const root = await mkdtemp(join(tmpdir(), "pi-oxlint-"));
    let client: LspServerClient | undefined;
    try {
      await writeFile(
        join(root, ".oxlintrc.json"),
        JSON.stringify({ rules: { "no-debugger": "error" } }),
      );
      await writeFile(join(root, "main.js"), "debugger;\n");
      // Preset preparation starts Oxlint's worker during initialize, before the first pull.
      const definition = await resolveLspPreset(
        {
          ...settings.servers.get("oxlint")!,
          environment: { PATH: "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
        },
        root,
        installer,
        true,
        {
          signal: AbortSignal.timeout(120_000),
          onProgress: (message) => console.info(`Oxlint acquisition: ${message}`),
        },
      );
      expect(definition.protocol).toBe("oxlint");
      expect(definition.initializationOptions).toEqual([
        { workspaceUri: pathToFileURL(root).href, options: {} },
      ]);
      expect(definition.environment.OXLINT_TSGOLINT_PATH).toBeUndefined();
      client = await LspServerClient.start({
        ...definition,
        serverId: "oxlint",
        rootPath: root,
        settings: definition.settings,
        initializationOptions: definition.initializationOptions,
        stderrPath: join(root, "stderr"),
        timeouts: settings.timeouts,
      });
      expect(await client.documentDiagnostics(join(root, "main.js"), "javascript")).toMatchObject({
        status: "fresh",
        source: "document_pull",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(/debugger/i) }),
        ]),
      });
      await writeFile(join(root, "main.js"), "console.log(1);\n");
      expect(await client.documentDiagnostics(join(root, "main.js"), "javascript")).toMatchObject({
        status: "fresh",
        source: "document_pull",
        diagnostics: [],
      });
      expect((await installer.installed("lsp-oxlint"))?.components.helper).toBeUndefined();
      await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client?.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);

test.skipIf(!enabled)(
  "opt-in Oxlint privately acquires a compatible native helper without project installation",
  async () => {
    const installer = new ToolInstaller(store);
    const settings = withLspPresets({
      servers: new Map(),
      enablement: new Map(),
      warnings: [],
      timeouts: {
        initializeMs: 10_000,
        requestMs: 5_000,
        diagnosticsMs: 20_000,
        shutdownMs: 2_000,
      },
    });
    const root = await mkdtemp(join(tmpdir(), "pi-oxlint-types-"));
    let client: LspServerClient | undefined;
    try {
      await writeFile(
        join(root, ".oxlintrc.json"),
        JSON.stringify({
          options: { typeAware: true },
          plugins: ["typescript"],
          rules: { "typescript/no-floating-promises": "error" },
        }),
      );
      await writeFile(
        join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }),
      );
      await writeFile(
        join(root, "main.ts"),
        "async function work(): Promise<number> { return 1; }\nwork();\n",
      );
      const definition = await resolveLspPreset(
        {
          ...settings.servers.get("oxlint")!,
          environment: { PATH: "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
        },
        root,
        installer,
        true,
        { signal: AbortSignal.timeout(120_000) },
      );
      expect(definition.environment.OXLINT_TSGOLINT_PATH).toContain(store);
      client = await LspServerClient.start({
        ...definition,
        serverId: "oxlint",
        rootPath: root,
        settings: definition.settings,
        initializationOptions: definition.initializationOptions,
        stderrPath: join(root, "stderr"),
        timeouts: settings.timeouts,
      });
      expect(await client.documentDiagnostics(join(root, "main.ts"), "typescript")).toMatchObject({
        status: "fresh",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(/promise/i) }),
        ]),
      });
      expect((await installer.installed("lsp-oxlint"))?.components.helper).toBeDefined();
      await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "main.ts"), "utf8")).toBe(
        "async function work(): Promise<number> { return 1; }\nwork();\n",
      );
    } finally {
      await client?.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);

test.skipIf(!enabled)(
  "private Biome publishes fresh diagnostics and keeps another root alive",
  async () => {
    const installer = new ToolInstaller(store!);
    const installation = await installer.ensure(
      { id: "biome-probe", requirements: { node: "core:node", server: "npm:@biomejs/biome" } },
      { allowDownload: true, signal: AbortSignal.timeout(120_000) },
    );
    const directory = await mkdtemp(join(tmpdir(), "pi-biome-"));
    const clients: LspServerClient[] = [];
    try {
      const command = join(
        installation.components.node!.directory,
        process.platform === "win32" ? "node.exe" : "bin/node",
      );
      const script = join(
        installation.components.server!.directory,
        "node_modules/@biomejs/biome/bin/biome",
      );
      for (const rootName of ["one", "two"]) {
        const root = join(directory, rootName);
        await mkdir(root);
        await writeFile(
          join(root, "biome.json"),
          JSON.stringify({
            formatter: { enabled: false },
            linter: { enabled: true, rules: { recommended: true } },
          }),
        );
        await writeFile(join(root, "main.js"), "debugger;\n");
        const client = await LspServerClient.start({
          serverId: "biome",
          rootPath: root,
          command,
          args: [script, "lsp-proxy"],
          environment: {
            ...process.env,
            ...installation.environment,
            PATH: [...installation.binDirectories, process.env.PATH ?? ""].join(delimiter),
            HOME: directory,
            XDG_CACHE_HOME: join(directory, "cache"),
            BIOME_LOG_PATH: join(directory, "logs"),
          },
          settings: {},
          initializationOptions: {},
          diagnosticMode: "push",
          protocol: "biome",
          stderrPath: join(directory, `${rootName}.stderr`),
          timeouts: {
            initializeMs: 10_000,
            requestMs: 5_000,
            diagnosticsMs: 10_000,
            shutdownMs: 2_000,
          },
        });
        clients.push(client);
        const result = await client.documentDiagnostics(join(root, "main.js"), "javascript");
        expect(result).toMatchObject({
          status: "fresh",
          source: "push",
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringMatching(/debugger/i) }),
          ]),
        });
      }
      await clients[0]!.shutdown();
      await writeFile(join(directory, "two", "main.js"), "const valid = 1;\nconsole.log(valid);\n");
      expect(
        await clients[1]!.documentDiagnostics(join(directory, "two", "main.js"), "javascript"),
      ).toMatchObject({ status: "fresh", source: "push", diagnostics: [] });
    } finally {
      await Promise.all(clients.map((client) => client.shutdown()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

test.skipIf(!enabled)(
  "Biome native effective enablement honors overrides, language switches and restart refresh",
  async () => {
    const installer = new ToolInstaller(store);
    const root = await mkdtemp(join(tmpdir(), "pi-biome-eligibility-"));
    await mkdir(join(root, "src"));
    const source = join(root, "src", "a.ts");
    const outside = join(root, "outside.ts");
    const config = join(root, "biome.json");
    await writeFile(source, "debugger;\n");
    await writeFile(outside, "debugger;\n");
    await writeFile(
      config,
      JSON.stringify({
        linter: { enabled: false },
        overrides: [{ includes: ["src/**"], linter: { enabled: true } }],
      }),
    );
    const settings = withLspPresets({
      servers: new Map(),
      enablement: new Map(),
      warnings: [],
      timeouts: {
        initializeMs: 20_000,
        requestMs: 5_000,
        diagnosticsMs: 10_000,
        shutdownMs: 2_000,
      },
    });
    let allowDownload = true;
    const manager = new LspServerManager({
      cwd: root,
      settings: { ...settings, servers: new Map([["biome", settings.servers.get("biome")!]]) },
      startClient: async ({ definition, rootPath, timeouts, signal }) => {
        const selected = await resolveLspPreset(
          { ...definition, environment: { PATH: "" } },
          rootPath,
          installer,
          allowDownload,
          { signal },
        );
        return LspServerClient.start({
          ...selected,
          serverId: definition.id,
          rootPath,
          timeouts,
          signal,
          settings: selected.settings,
          initializationOptions: selected.initializationOptions,
          stderrPath: join(root, "biome.stderr"),
        });
      },
    });
    const diagnose = (file: string, serverId?: string) =>
      manager.runRead(
        file,
        serverId,
        (client) => client.hasCapability("textDocument/diagnostic"),
        (client, route) => client.documentDiagnostics(file, route.language.languageId),
      );
    try {
      const first = await diagnose(source);
      expect(first, await readFile(join(root, "biome.stderr"), "utf8")).toMatchObject({
        failures: [],
        successes: [
          {
            serverId: "biome",
            value: {
              status: "fresh",
              diagnostics: [expect.objectContaining({ code: "lint/suspicious/noDebugger" })],
            },
          },
        ],
      });
      expect(await diagnose(outside)).toMatchObject({
        successes: [],
        failures: [{ code: "no-capable-server" }],
      });
      expect(await diagnose(outside, "biome")).toMatchObject({
        successes: [],
        failures: [
          {
            code: "server-disabled",
            message: expect.stringContaining("native project configuration"),
          },
        ],
      });
      // Subsequent native config reloads retain the existing installation in Installed-only Mode.
      allowDownload = false;
      // Native settings reload belongs to the existing restart/reload lifecycle.
      await writeFile(
        config,
        JSON.stringify({ linter: { enabled: true }, javascript: { linter: { enabled: false } } }),
      );
      await manager.restartServer("biome", source);
      expect(await diagnose(source, "biome")).toMatchObject({
        successes: [],
        failures: [{ code: "server-disabled" }],
      });
      await writeFile(config, JSON.stringify({ linter: { enabled: true } }));
      await manager.restartServer("biome", source);
      expect(await diagnose(source)).toMatchObject({
        failures: [],
        successes: [
          {
            serverId: "biome",
            value: {
              status: "fresh",
              diagnostics: [expect.objectContaining({ code: "lint/suspicious/noDebugger" })],
            },
          },
        ],
      });
      await writeFile(source, "console.log(42);\n");
      expect(await diagnose(source)).toMatchObject({
        failures: [],
        successes: [{ value: { status: "fresh", diagnostics: [] } }],
      });
      await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);

test.skipIf(!enabled)(
  "official ESLint diagnoses prepared projects and reports missing project libraries",
  async () => {
    const installer = new ToolInstaller(store!);
    const server = await installer.ensure(
      { id: "eslint-probe", requirements: { node: "core:node", server: ESLINT_SERVER_SELECTOR } },
      { allowDownload: true, signal: AbortSignal.timeout(120_000) },
    );
    const corrupt = ESLINT_SERVER_SELECTOR.replace(
      /checksum_url=[^\]]+/,
      `checksum=sha256:${"0".repeat(64)}`,
    );
    await expect(
      installer.ensure(
        { id: "eslint-corrupt-probe", requirements: { server: corrupt } },
        { allowDownload: true, signal: AbortSignal.timeout(120_000) },
      ),
    ).rejects.toThrow(/checksum|sha256/i);
    expect(
      await isOfficialEslintServer(
        join(server.components.server!.directory, "extension/server/out/eslintServer.js"),
      ),
    ).toBe(true);
    const library = await installer.ensure(
      { id: "eslint-library-probe", requirements: { node: "core:node", library: "npm:eslint" } },
      { allowDownload: true, signal: AbortSignal.timeout(120_000) },
    );
    const directory = await mkdtemp(join(tmpdir(), "pi-eslint-"));
    const clients: LspServerClient[] = [];
    try {
      for (const prepared of [false, true]) {
        const root = join(directory, prepared ? "prepared" : "missing");
        await mkdir(root);
        await writeFile(
          join(root, "eslint.config.mjs"),
          'export default [{ rules: { "no-debugger": "error" } }];\n',
        );
        await writeFile(join(root, "main.js"), "debugger;\n");
        if (prepared)
          await symlink(
            join(library.components.library!.directory, "node_modules"),
            join(root, "node_modules"),
            process.platform === "win32" ? "junction" : "dir",
          );
        const client = await LspServerClient.start({
          serverId: "eslint",
          rootPath: root,
          command: join(
            library.components.node!.directory,
            process.platform === "win32" ? "node.exe" : "bin/node",
          ),
          args: [
            join(server.components.server!.directory, "extension/server/out/eslintServer.js"),
            "--stdio",
          ],
          environment: {
            ...process.env,
            PATH: [...library.binDirectories, process.env.PATH ?? ""].join(delimiter),
          },
          settings: {
            validate: "on",
            run: "onType",
            workspaceFolder: { uri: pathToFileURL(root).href, name: "test" },
            workingDirectory: { mode: "auto" },
          },
          initializationOptions: {},
          protocol: "eslint",
          stderrPath: join(root, "stderr"),
          timeouts: {
            initializeMs: 10_000,
            requestMs: 5_000,
            diagnosticsMs: 10_000,
            shutdownMs: 2_000,
          },
        });
        clients.push(client);
        if (!prepared)
          await expect(
            client.documentDiagnostics(join(root, "main.js"), "javascript"),
          ).rejects.toThrow(/ESLint.*library/i);
        else
          expect(
            await client.documentDiagnostics(join(root, "main.js"), "javascript"),
          ).toMatchObject({
            status: "fresh",
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ message: expect.stringMatching(/debugger/i) }),
            ]),
          });
      }
    } finally {
      await Promise.all(clients.map((client) => client.shutdown()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
