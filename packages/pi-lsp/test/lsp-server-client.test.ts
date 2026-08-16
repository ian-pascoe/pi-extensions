import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  LspServerClient,
  LspServerClientError,
  type LspServerClientOptions,
} from "../src/lsp-server-client.js";

const fixturePath = resolve(import.meta.dirname, "fixtures/fake-lsp-server.mjs");
const temporaryDirectories: string[] = [];
const clients: LspServerClient[] = [];

interface FakeServerState {
  readonly initializationOptions: unknown;
  readonly settingsNotifications: readonly unknown[];
  readonly opened: readonly {
    readonly uri: string;
    readonly version: number;
    readonly text: string;
  }[];
  readonly changed: readonly unknown[];
  readonly saved: readonly unknown[];
  readonly closed: readonly unknown[];
  readonly cancellations: number;
  readonly configuration: readonly unknown[];
  readonly workspaceFolders: readonly { readonly name: string; readonly uri: string }[];
  readonly progressCreated: boolean;
  readonly diagnosticsRefreshed: boolean;
  readonly applyEdit: { readonly applied: boolean; readonly failureReason: string };
}

async function startFakeServer(
  directory: string,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly onUnavailable?: LspServerClientOptions["onUnavailable"];
    readonly onWorkspaceEdit?: LspServerClientOptions["onWorkspaceEdit"];
    readonly diagnosticsMs?: number;
  } = {},
): Promise<LspServerClient> {
  const clientOptions: LspServerClientOptions = {
    serverId: "fake",
    rootPath: directory,
    command: process.execPath,
    args: [fixturePath],
    environment: { ...process.env, ...options.environment },
    initializationOptions: { fakeInitialization: true },
    settings: { typescript: { preferences: { quoteStyle: "single" } } },
    stderrPath: resolve(directory, "fake.stderr.log"),
    timeouts: {
      initializeMs: 5_000,
      requestMs: 1_000,
      diagnosticsMs: options.diagnosticsMs ?? 500,
      shutdownMs: 1_000,
    },
  };
  const client = await LspServerClient.start({
    ...clientOptions,
    onUnavailable: options.onUnavailable ?? (() => {}),
    onWorkspaceEdit:
      options.onWorkspaceEdit ??
      (async () => {
        throw new Error("Fake LSP test: no workspace edit preview handler");
      }),
  });
  clients.push(client);
  return client;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-lsp-client-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForStderrTail(filePath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const contents = await readFile(filePath);
    if (contents.subarray(-3).toString() === "END") return contents;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Fake LSP test: stderr tail was not flushed");
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LspServerClient", () => {
  test("handles required server requests, dynamic capabilities, settings, and preview rejection", async () => {
    const directory = await createTemporaryDirectory();
    const previews: unknown[] = [];
    const client = await startFakeServer(directory, {
      onWorkspaceEdit: async (edit) => {
        previews.push(edit);
        return "preview-1";
      },
    });

    const state = await client.request<FakeServerState>("fake/state", {});
    expect(client.serverInfo).toEqual({ name: "pi-lsp-fake", version: "1.0.0" });
    expect(client.positionEncoding).toBe("utf-8");
    expect(client.hasCapability("textDocument/hover")).toBe(true);
    expect(client.hasCapability("textDocument/foldingRange")).toBe(true);
    expect(state.initializationOptions).toEqual({ fakeInitialization: true });
    expect(state.settingsNotifications).toEqual([
      { typescript: { preferences: { quoteStyle: "single" } } },
    ]);
    expect(state.configuration).toEqual([
      { quoteStyle: "single" },
      { typescript: { preferences: { quoteStyle: "single" } } },
    ]);
    expect(state.workspaceFolders).toEqual([
      { name: "fake", uri: expect.stringMatching(/^file:/) },
    ]);
    expect(state.progressCreated).toBe(true);
    expect(state.diagnosticsRefreshed).toBe(true);
    expect(state.applyEdit).toEqual({
      applied: false,
      failureReason: "Pi LSP: workspace edit captured as preview preview-1",
    });
    expect(previews).toHaveLength(1);
    expect(client.recentProtocolMessages).toContain("fake server ready");
  });

  test("preserves BOM text, uses incremental sync/save, evicts the oldest document, and accepts empty pulls", async () => {
    const directory = await createTemporaryDirectory();
    const client = await startFakeServer(directory, {
      environment: { FAKE_DIAGNOSTICS: "empty", FAKE_PUSH: "none" },
    });
    const paths = Array.from({ length: 101 }, (_, index) => resolve(directory, `${index}.ts`));
    await Promise.all(
      paths.map((filePath, index) => writeFile(filePath, `export const v${index} = ${index};\n`)),
    );
    for (const filePath of paths) await client.synchronizeDocument(filePath, "typescript");

    const bomPath = paths.at(-1);
    if (bomPath === undefined) throw new Error("Fake LSP test: missing BOM path");
    await writeFile(
      bomPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("export const changed = true;\n"),
      ]),
    );
    const synchronized = await client.synchronizeDocument(bomPath, "typescript");
    expect(synchronized.text.startsWith("\uFEFF")).toBe(true);

    const documentDiagnostics = await client.documentDiagnostics(bomPath, "typescript");
    expect(documentDiagnostics).toEqual({
      status: "fresh",
      source: "document_pull",
      diagnostics: [],
    });
    const workspaceDiagnostics = await client.workspaceDiagnostics();
    expect(workspaceDiagnostics.status).toBe("fresh");
    if (workspaceDiagnostics.status !== "fresh") {
      throw new Error("Fake LSP test: expected fresh workspace diagnostics");
    }
    expect(workspaceDiagnostics.source).toBe("workspace_pull");

    const state = await client.request<FakeServerState>("fake/state", {});
    expect(state.opened).toHaveLength(101);
    expect(state.closed).toHaveLength(1);
    expect(state.changed).toHaveLength(1);
    expect(state.saved).toHaveLength(1);

    const invalidPath = resolve(directory, "invalid.ts");
    await writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
    await expect(client.synchronizeDocument(invalidPath, "typescript")).rejects.toMatchObject({
      kind: "invalid_utf8",
    });
  });

  test("bridges AbortSignal cancellation and keeps the latest 1 MB of stderr", async () => {
    const directory = await createTemporaryDirectory();
    const client = await startFakeServer(directory, {
      environment: { FAKE_STDERR_BYTES: String(1024 * 1024 + 100) },
    });
    await client.request<FakeServerState>("fake/state", {});

    const controller = new AbortController();
    const delayed = client.request("fake/delay", {}, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(delayed).rejects.toMatchObject({ kind: "cancelled" });
    const state = await client.request<FakeServerState>("fake/state", {});
    expect(state.cancellations).toBe(1);

    const stderr = await waitForStderrTail(client.stderrPath);
    expect(stderr.length).toBe(1024 * 1024);
    expect(stderr.subarray(-3).toString()).toBe("END");
  });

  test("reports a distinct diagnostics timeout", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "timeout.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      diagnosticsMs: 50,
      environment: { FAKE_DELAY_DIAGNOSTICS: "1", FAKE_PUSH: "none" },
    });

    await expect(client.documentDiagnostics(filePath, "typescript")).resolves.toEqual({
      status: "timeout",
      diagnostics: [],
    });
    await expect(client.workspaceDiagnostics()).resolves.toEqual({
      status: "timeout",
      diagnosticsByUri: new Map(),
    });
  });

  test("ignores stale versioned pushes until diagnostics for the synchronized version arrive", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "fresh.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      environment: {
        FAKE_DIAGNOSTICS: "one",
        FAKE_NO_PULL: "1",
        FAKE_STALE_PUSH: "1",
      },
    });

    const result = await client.documentDiagnostics(filePath, "typescript");
    expect(result.status).toBe("fresh");
    expect(result.diagnostics.map(({ message }) => message)).toEqual(["fresh diagnostic"]);
  });

  test("omits stale versioned pushes from cached workspace diagnostics", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "stale.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      environment: { FAKE_NO_PULL: "1", FAKE_STALE_PUSH: "only" },
    });

    await client.synchronizeDocument(filePath, "typescript");
    await client.request("fake/state", {});
    await expect(client.workspaceDiagnostics()).resolves.toMatchObject({
      status: "fresh",
      source: "push_cache",
      diagnosticsByUri: new Map(),
    });
  });

  test("omits versioned cached pushes for unsynchronized documents", async () => {
    const directory = await createTemporaryDirectory();
    const client = await startFakeServer(directory, {
      environment: { FAKE_NO_PULL: "1" },
    });

    await client.request("fake/publishDiagnostics", {
      uri: "file:///not-synchronized.ts",
      version: 1,
    });
    await expect(client.workspaceDiagnostics()).resolves.toMatchObject({
      status: "fresh",
      source: "push_cache",
      diagnosticsByUri: new Map(),
    });
  });

  test("notifies the owner exactly once after an unexpected process exit", async () => {
    const directory = await createTemporaryDirectory();
    const failures: LspServerClientError[] = [];
    const client = await startFakeServer(directory, {
      onUnavailable: (error) => failures.push(error),
    });
    const processId = client.processId;
    if (processId === undefined) throw new Error("Fake LSP test: missing process ID");
    process.kill(processId, "SIGKILL");

    await expect.poll(() => failures.length, { timeout: 2_000 }).toBe(1);
    expect(failures[0]).toMatchObject({ serverId: "fake" });
    expect(["exit", "protocol"]).toContain(failures[0]?.kind);
    await expect(client.request("fake/state", {})).rejects.toBe(failures[0]);
  });
});
