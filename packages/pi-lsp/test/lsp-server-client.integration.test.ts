import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Definition,
  DefinitionLink,
  Location,
  LocationLink,
} from "vscode-languageserver-protocol";
import { DefinitionRequest } from "vscode-languageserver-protocol";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { LspServerClient } from "../src/lsp-server-client.js";
import { LspServerManager } from "../src/lsp-server-manager.js";
import type { LspServerDefinition } from "../src/pi-lsp-settings.js";
import { createLspSessionFiles } from "../src/lsp-session-files.js";
import { createLspToolDefinition, type LspToolServerClient } from "../src/lsp-tool.js";
import { LspWorkspaceEditStore } from "../src/lsp-workspace-edit.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const clients: LspServerClient[] = [];

function definitionStartLine(location: Location | LocationLink): number {
  return "targetRange" in location ? location.targetRange.start.line : location.range.start.line;
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

const typescriptTimeouts = {
  initializeMs: 45_000,
  requestMs: 5_000,
  diagnosticsMs: 8_000,
  shutdownMs: 5_000,
} as const;

function typescriptDefinition(rootMarkers: readonly string[]): LspServerDefinition {
  return {
    id: "typescript",
    command: resolve(repositoryRoot, "node_modules/.bin/tsc"),
    args: ["--lsp", "--stdio"],
    environment: {},
    languages: [{ extensions: [".ts"], fileNames: [], languageId: "typescript" }],
    requireRootMarker: false,
    rootMarkers,
  };
}

function createTypeScriptManager(
  cwd: string,
  definition: LspServerDefinition,
): LspServerManager<LspToolServerClient> {
  return new LspServerManager<LspToolServerClient>({
    cwd,
    homeDirectory: tmpdir(),
    settings: {
      enablement: new Map(),
      warnings: [],
      timeouts: typescriptTimeouts,
      servers: new Map([[definition.id, definition]]),
    },
    startClient: async ({ definition: started, onUnavailable, rootPath, timeouts, signal }) =>
      LspServerClient.start({
        serverId: started.id,
        rootPath,
        command: started.command,
        args: started.args,
        environment: { ...process.env },
        initializationOptions: {},
        settings: {},
        timeouts,
        signal,
        stderrPath: resolve(cwd, ".pi-lsp/typescript.stderr.log"),
        onUnavailable,
        onWorkspaceEdit: async () => {
          throw new Error("TypeScript integration test: unexpected server workspace edit");
        },
      }),
  });
}

/**
 * A pnpm-style workspace: packages `a` and `b` each have their own `package.json` and
 * `tsconfig.json`, and `b` imports `a`'s exported `helper` through a workspace link.
 */
async function createTypeScriptMonorepo(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "pi-lsp-typescript-monorepo-"));
  temporaryDirectories.push(root);
  await writeFile(resolve(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(resolve(root, "package.json"), JSON.stringify({ private: true }));
  for (const name of ["a", "b"]) {
    const packageDirectory = resolve(root, "packages", name);
    await mkdir(resolve(packageDirectory, "src"), { recursive: true });
    await writeFile(
      resolve(packageDirectory, "package.json"),
      JSON.stringify({ name: `@monorepo/${name}`, type: "module", exports: "./src/index.ts" }),
    );
    await writeFile(
      resolve(packageDirectory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "nodenext", noEmit: true, strict: true },
        include: ["src"],
      }),
    );
  }
  await writeFile(
    resolve(root, "packages/a/src/index.ts"),
    "export function helper(): number {\n  return 1;\n}\n",
  );
  await writeFile(
    resolve(root, "packages/b/src/index.ts"),
    'import { helper } from "@monorepo/a";\nexport const value = helper();\n',
  );
  await mkdir(resolve(root, "packages/b/node_modules/@monorepo"), { recursive: true });
  await symlink("../../../a", resolve(root, "packages/b/node_modules/@monorepo/a"));
  return root;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("real TypeScript 7 language server client", () => {
  test("initializes, synchronizes UTF-8, reports a semantic error, resolves a definition, and exits", async () => {
    const projectDirectory = await mkdtemp(resolve(tmpdir(), "pi-lsp-typescript-"));
    temporaryDirectories.push(projectDirectory);
    await mkdir(resolve(projectDirectory, ".pi-lsp"), { recursive: true });
    await writeFile(
      resolve(projectDirectory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true, strict: true } }),
    );
    const filePath = resolve(projectDirectory, "example.ts");
    await writeFile(filePath, "const café: string = 42;\nconsole.log(café);\n", "utf8");

    const client = await LspServerClient.start({
      serverId: "typescript",
      rootPath: projectDirectory,
      command: resolve(repositoryRoot, "node_modules/.bin/tsc"),
      args: ["--lsp", "--stdio"],
      environment: { ...process.env },
      initializationOptions: {},
      settings: {},
      stderrPath: resolve(projectDirectory, ".pi-lsp/typescript.stderr.log"),
      timeouts: {
        initializeMs: 45_000,
        requestMs: 5_000,
        diagnosticsMs: 8_000,
        shutdownMs: 5_000,
      },
    });
    clients.push(client);

    expect(client.serverInfo?.name).toBe("typescript-go");
    expect(client.isRunning).toBe(true);

    const diagnostics = await client.documentDiagnostics(filePath, "typescript");
    expect(diagnostics.status).toBe("fresh");
    expect(
      diagnostics.diagnostics.some((diagnostic) =>
        JSON.stringify(diagnostic.message).includes("number"),
      ),
    ).toBe(true);

    const definition = await client.request<Definition | DefinitionLink[] | null>(
      DefinitionRequest.method,
      {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line: 1, character: 14 },
      },
    );
    expect(Array.isArray(definition) ? definition.length : definition).not.toBeNull();
    const locations: readonly (Location | LocationLink)[] = Array.isArray(definition)
      ? definition
      : definition === null
        ? []
        : [definition];
    expect(locations.some((location) => definitionStartLine(location) === 0)).toBe(true);

    const processId = client.processId;
    expect(processId).toBeTypeOf("number");
    await client.shutdown();
    clients.splice(clients.indexOf(client), 1);
    expect(client.isRunning).toBe(false);
    if (processId !== undefined) expect(processExists(processId)).toBe(false);
  }, 60_000);

  test("returns a diagnostic-dependent quick fix as a Workspace Edit Preview", async () => {
    const projectDirectory = await mkdtemp(resolve(tmpdir(), "pi-lsp-typescript-"));
    temporaryDirectories.push(projectDirectory);
    await writeFile(
      resolve(projectDirectory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true, strict: true } }),
    );
    await writeFile(
      resolve(projectDirectory, "helper.ts"),
      "export function missingName(): number {\n  return 1;\n}\n",
    );
    const filePath = resolve(projectDirectory, "example.ts");
    await writeFile(filePath, "export const value: number = missingName();\n", "utf8");

    const sessionFiles = await createLspSessionFiles(projectDirectory);
    const workspaceEdits = new LspWorkspaceEditStore();
    const manager = new LspServerManager<LspToolServerClient>({
      cwd: projectDirectory,
      settings: {
        enablement: new Map(),
        warnings: [],
        timeouts: {
          initializeMs: 45_000,
          requestMs: 5_000,
          diagnosticsMs: 8_000,
          shutdownMs: 5_000,
        },
        servers: new Map([
          [
            "typescript",
            {
              id: "typescript",
              command: resolve(repositoryRoot, "node_modules/.bin/tsc"),
              args: ["--lsp", "--stdio"],
              environment: {},
              languages: [{ extensions: [".ts"], fileNames: [], languageId: "typescript" }],
              requireRootMarker: false,
              rootMarkers: ["tsconfig.json"],
            },
          ],
        ]),
      },
      startClient: async ({ definition, onUnavailable, rootPath, timeouts, signal }) =>
        LspServerClient.start({
          serverId: definition.id,
          rootPath,
          command: definition.command,
          args: definition.args,
          environment: { ...process.env },
          initializationOptions: {},
          settings: {},
          timeouts,
          signal,
          stderrPath: resolve(projectDirectory, ".pi-lsp/typescript.stderr.log"),
          onUnavailable,
          onWorkspaceEdit: async () => {
            throw new Error("TypeScript integration test: unexpected server workspace edit");
          },
        }),
    });
    try {
      const tool = createLspToolDefinition("code_actions", () => ({
        manager,
        workspaceEdits,
        sessionFiles,
      }));
      // SAFETY: Tool execution only reads cwd from ExtensionContext.
      const context = { cwd: projectDirectory } as ExtensionToolContext;

      // `missingName` spans one-based characters 30 through 40 on line 1; the end is exclusive.
      const result = await tool.execute(
        "tool-call",
        {
          file_path: filePath,
          range: { start: { line: 1, character: 30 }, end: { line: 1, character: 41 } },
          only_kinds: ["quickfix"],
        },
        undefined,
        undefined,
        context,
      );

      expect(result.structuredContent).toMatchObject({
        actions: expect.arrayContaining([
          expect.objectContaining({
            server_id: "typescript",
            applicable: true,
            kind: "quickfix",
            title: 'Add import from "./helper"',
            summary: expect.stringContaining('+import { missingName } from "./helper";'),
            preview_id: expect.any(String),
            mutation_manifest: [{ operation: "modify", path: filePath }],
          }),
        ]),
      });
    } finally {
      await manager.shutdown();
      await sessionFiles.close();
    }
  }, 60_000);

  test("finds and renames references across packages from one workspace-root Server Instance", async () => {
    const root = await createTypeScriptMonorepo();
    const helperFile = resolve(root, "packages/a/src/index.ts");
    const importerFile = resolve(root, "packages/b/src/index.ts");
    // SAFETY: Tool execution only reads cwd from ExtensionContext.
    const context = { cwd: root } as ExtensionToolContext;
    const search = async (definition: LspServerDefinition) => {
      const sessionFiles = await createLspSessionFiles(root);
      const manager = createTypeScriptManager(root, definition);
      const dependencies = () => ({
        manager,
        workspaceEdits: new LspWorkspaceEditStore(),
        sessionFiles,
      });
      // `helper` starts at one-based character 17 on line 1 of package `a`.
      const position = { file_path: helperFile, line: 1, character: 17 };
      const findReferences = async () => {
        const result = await createLspToolDefinition("find_references", dependencies).execute(
          "references",
          position,
          undefined,
          undefined,
          context,
        );
        return result.content.map((part) => ("text" in part ? part.text : "")).join("");
      };
      try {
        const beforeImporterOpened = await findReferences();
        // The TypeScript server searches the projects it has loaded; opening a file of `b`
        // loads `b`'s project into whichever Server Instance that file routes to.
        await createLspToolDefinition("hover", dependencies).execute(
          "hover",
          { file_path: importerFile, line: 2, character: 22 },
          undefined,
          undefined,
          context,
        );
        const references = await findReferences();
        const rename = await createLspToolDefinition("rename", dependencies).execute(
          "rename",
          { ...position, new_name: "renamed" },
          undefined,
          undefined,
          context,
        );
        return {
          beforeImporterOpened,
          references,
          rename: rename.structuredContent,
          startedRoots: manager.getStatus().servers.map(({ rootPath }) => rootPath),
        };
      } finally {
        await manager.shutdown();
        await sessionFiles.close();
      }
    };

    const workspace = await search({
      ...typescriptDefinition(["tsconfig.json"]),
      workspaceRootMarkers: ["pnpm-workspace.yaml"],
    });
    expect(workspace.startedRoots).toEqual([root]);
    // Before `b` is opened, the result warns that its references may be missing.
    expect(workspace.beforeImporterOpened).toContain(
      `Warning: typescript has not loaded files from packages/b under ${root}; their references may be missing.`,
    );
    expect(workspace.references).toContain("packages/b/src/index.ts:1:10");
    expect(workspace.references).toContain("packages/b/src/index.ts:2:22");
    expect(workspace.references).not.toContain("Warning");
    expect(workspace.rename).toMatchObject({
      root_path: root,
      warnings: [],
      mutation_manifest: [
        { operation: "modify", path: helperFile },
        { operation: "modify", path: importerFile },
      ],
    });

    // Without workspace root markers, each package has its own Server Instance, and the
    // instance for `a` misses `b`'s usage.
    const perPackage = await search(typescriptDefinition(["tsconfig.json"]));
    expect(perPackage.startedRoots).toEqual([
      resolve(root, "packages/a"),
      resolve(root, "packages/b"),
    ]);
    expect(perPackage.references).not.toContain("packages/b/src/index.ts");
    expect(perPackage.references).toContain("Warning");
  }, 60_000);
});
