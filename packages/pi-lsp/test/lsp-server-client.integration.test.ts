import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  Definition,
  DefinitionLink,
  Location,
  LocationLink,
} from "vscode-languageserver-protocol";
import { DefinitionRequest } from "vscode-languageserver-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { LspServerClient } from "../src/lsp-server-client.js";
import { resolveLspSettings } from "../src/pi-lsp-settings.js";

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

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("real TypeScript 7 language server client", () => {
  test("starts the tracked TypeScript server from a workspace package root", async () => {
    const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-lsp-settings-agent-"));
    temporaryDirectories.push(agentDirectory);
    const settingsManager = SettingsManager.create(repositoryRoot, agentDirectory, {
      projectTrusted: true,
    });
    const settings = resolveLspSettings(settingsManager);
    const definition = settings.servers.get("typescript");
    if (definition === undefined) {
      throw new Error("Pi LSP integration test: missing tracked TypeScript server definition");
    }

    const client = await LspServerClient.start({
      serverId: definition.id,
      rootPath: resolve(repositoryRoot, "packages/pi-codemode"),
      command: definition.command,
      args: definition.args,
      environment: { ...definition.environment },
      initializationOptions: definition.initializationOptions ?? null,
      settings: definition.settings ?? null,
      stderrPath: resolve(agentDirectory, "typescript.stderr.log"),
      timeouts: settings.timeouts,
    });
    clients.push(client);

    expect(client.serverInfo?.name).toBe("typescript-go");
  }, 60_000);

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
});
