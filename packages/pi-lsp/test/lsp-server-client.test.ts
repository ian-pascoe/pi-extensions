import { writeFileSync } from "node:fs";
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
  readonly textDocumentCapabilities: {
    readonly hover: unknown;
    readonly completion: unknown;
    readonly signatureHelp: unknown;
    readonly foldingRange: unknown;
  } | null;
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
  // The stderr tail is flushed asynchronously by the client; poll until a generous deadline so a
  // loaded runner does not fail the test, while the happy path returns on the first match.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
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
    expect(client.hasCapability("textDocument/prepareRename")).toBe(true);
    expect(state.initializationOptions).toEqual({ fakeInitialization: true });
    const formats = ["markdown", "plaintext"];
    expect(state.textDocumentCapabilities?.hover).toEqual({
      dynamicRegistration: true,
      contentFormat: formats,
    });
    expect(state.textDocumentCapabilities?.completion).toEqual({
      dynamicRegistration: true,
      completionItem: { documentationFormat: formats },
    });
    expect(state.textDocumentCapabilities?.signatureHelp).toEqual({
      dynamicRegistration: true,
      signatureInformation: { documentationFormat: formats },
    });
    // The outline finds import bindings by folding range kind, so the client names the kinds it reads.
    expect(state.textDocumentCapabilities?.foldingRange).toEqual({
      dynamicRegistration: true,
      foldingRangeKind: { valueSet: ["comment", "imports", "region"] },
    });
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
    // The oldest document was evicted; the rest are listed oldest first.
    expect(client.synchronizedDocumentPaths()).toEqual(paths.slice(1));
    // Synchronizing a listed document again moves it last.
    await client.synchronizeDocument(paths[1] ?? "", "typescript");
    expect(client.synchronizedDocumentPaths()).toEqual([...paths.slice(2), paths[1]]);

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

  test("synchronizes concurrent requests for one document exactly once", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "concurrent.ts");
    await writeFile(filePath, "export const value = 42;\n");
    const client = await startFakeServer(directory);

    const documents = await Promise.all([
      client.synchronizeDocument(filePath, "typescript"),
      client.synchronizeDocument(filePath, "typescript"),
      client.synchronizeDocument(filePath, "typescript"),
    ]);
    const state = await client.request<FakeServerState>("fake/state", {});

    expect(documents.map(({ version }) => version)).toEqual([1, 1, 1]);
    expect(state.opened).toHaveLength(1);
    expect(state.changed).toHaveLength(0);
  });

  test("re-reads a document after a concurrent synchronization failure", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "recovered.ts");
    await writeFile(filePath, Buffer.from([0xc3, 0x28]));
    const client = await startFakeServer(directory);

    const failed = client.synchronizeDocument(filePath, "typescript");
    void failed.catch(() => {
      writeFileSync(filePath, "export const recovered = true;\n");
    });
    const recovered = client.synchronizeDocument(filePath, "typescript");

    await expect(failed).rejects.toMatchObject({ kind: "invalid_utf8" });
    await expect(recovered).resolves.toMatchObject({
      languageId: "typescript",
      text: "export const recovered = true;\n",
      version: 1,
    });
    const state = await client.request<FakeServerState>("fake/state", {});

    expect(state.opened).toHaveLength(1);
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
      waitedMs: 50,
      pushOnly: false,
      remembered: false,
    });
    await expect(client.workspaceDiagnostics()).resolves.toEqual({
      status: "timeout",
      diagnosticsByUri: new Map(),
    });
  });

  describe("push-only server silence", () => {
    const pushOnly = { FAKE_NO_PULL: "1", FAKE_PUSH: "none" } as const;
    const silent = { status: "timeout", diagnostics: [], waitedMs: 100, pushOnly: true };

    test("answers a repeat query of the unchanged version without waiting again", async () => {
      const directory = await createTemporaryDirectory();
      const filePath = resolve(directory, "clean.md");
      await writeFile(filePath, "# clean\n");
      const client = await startFakeServer(directory, {
        diagnosticsMs: 100,
        environment: pushOnly,
      });

      await expect(client.documentDiagnostics(filePath, "markdown")).resolves.toEqual({
        ...silent,
        remembered: false,
      });
      for (let repeat = 0; repeat < 2; repeat++) {
        await expect(client.documentDiagnostics(filePath, "markdown")).resolves.toEqual({
          ...silent,
          remembered: true,
        });
      }
      const state = await client.request<FakeServerState>("fake/state", {});
      expect(state.opened).toHaveLength(1);
      expect(state.changed).toHaveLength(0);
    });

    test("waits again after the document changes", async () => {
      const directory = await createTemporaryDirectory();
      const filePath = resolve(directory, "changed.md");
      await writeFile(filePath, "# clean\n");
      const client = await startFakeServer(directory, {
        diagnosticsMs: 100,
        environment: pushOnly,
      });
      await client.documentDiagnostics(filePath, "markdown");
      await writeFile(filePath, "# still clean\n");

      await expect(client.documentDiagnostics(filePath, "markdown")).resolves.toMatchObject({
        status: "timeout",
        remembered: false,
      });
      const state = await client.request<FakeServerState>("fake/state", {});
      expect(state.changed).toHaveLength(1);
    });

    test("forgets the silence when the server later publishes for the version", async () => {
      const directory = await createTemporaryDirectory();
      const filePath = resolve(directory, "late.md");
      await writeFile(filePath, "# late\n");
      const client = await startFakeServer(directory, {
        diagnosticsMs: 100,
        environment: { ...pushOnly, FAKE_DIAGNOSTICS: "one" },
      });
      const document = await client.synchronizeDocument(filePath, "markdown");
      await client.documentDiagnostics(filePath, "markdown");
      await expect(client.documentDiagnostics(filePath, "markdown")).resolves.toMatchObject({
        remembered: true,
      });

      await client.request("fake/publishDiagnostics", { uri: document.uri, version: 1 });

      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await client.documentDiagnostics(filePath, "markdown");
        expect(result.status).toBe("fresh");
        expect(result.diagnostics.map(({ message }) => message)).toEqual([
          "unsynchronized diagnostic",
        ]);
      }
    });

    test("forgets the silence when the document is closed", async () => {
      const directory = await createTemporaryDirectory();
      const filePath = resolve(directory, "closed.md");
      await writeFile(filePath, "# closed\n");
      const client = await startFakeServer(directory, {
        diagnosticsMs: 100,
        environment: pushOnly,
      });
      await client.documentDiagnostics(filePath, "markdown");
      await client.closeDocument(filePath);

      await expect(client.documentDiagnostics(filePath, "markdown")).resolves.toMatchObject({
        status: "timeout",
        remembered: false,
      });
    });

    test("keeps retrying a pull-capable server that timed out", async () => {
      const directory = await createTemporaryDirectory();
      const filePath = resolve(directory, "pull.md");
      await writeFile(filePath, "# pull\n");
      const client = await startFakeServer(directory, {
        diagnosticsMs: 50,
        environment: { FAKE_DELAY_DIAGNOSTICS: "1", FAKE_PUSH: "none" },
      });
      await client.documentDiagnostics(filePath, "markdown");

      await expect(client.documentDiagnostics(filePath, "markdown")).resolves.toMatchObject({
        status: "timeout",
        pushOnly: false,
        remembered: false,
      });
    });

    test("returns a version's published diagnostics on every query of the unchanged file", async () => {
      const directory = await createTemporaryDirectory();
      const filePath = resolve(directory, "published.md");
      await writeFile(filePath, "# published\n");
      const client = await startFakeServer(directory, {
        diagnosticsMs: 100,
        environment: { FAKE_NO_PULL: "1", FAKE_DIAGNOSTICS: "one" },
      });
      await client.synchronizeDocument(filePath, "markdown");

      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await client.documentDiagnostics(filePath, "markdown");
        expect(result).toMatchObject({ status: "fresh", source: "push" });
        expect(result.diagnostics).toHaveLength(1);
      }
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

  test("returns cached current push diagnostics without waiting for a newer push", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "current.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      diagnosticsMs: 200,
      environment: { FAKE_DIAGNOSTICS: "one", FAKE_NO_PULL: "1", FAKE_STALE_PUSH: "1" },
    });

    const first = await client.currentDocumentDiagnostics(
      await client.synchronizeDocument(filePath, "typescript"),
    );
    expect(first.map(({ message }) => message)).toEqual(["fresh diagnostic"]);
    // The unchanged document gets no newer push; documentDiagnostics would time out here.
    const second = await client.currentDocumentDiagnostics(
      await client.synchronizeDocument(filePath, "typescript"),
    );
    expect(second.map(({ message }) => message)).toEqual(["fresh diagnostic"]);
  });

  test("pulls current diagnostics from a pull-only server", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "pull.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      environment: { FAKE_DIAGNOSTICS: "one", FAKE_PUSH: "none" },
    });

    const diagnostics = await client.currentDocumentDiagnostics(
      await client.synchronizeDocument(filePath, "typescript"),
    );
    expect(diagnostics.map(({ message }) => message)).toEqual(["fake diagnostic"]);
  });

  test("returns no current diagnostics for a superseded document version", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "superseded.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      environment: { FAKE_DIAGNOSTICS: "one", FAKE_NO_PULL: "1" },
    });

    const superseded = await client.synchronizeDocument(filePath, "typescript");
    await writeFile(filePath, "export const value = false;\n");
    const current = await client.synchronizeDocument(filePath, "typescript");

    await expect(client.currentDocumentDiagnostics(superseded)).resolves.toEqual([]);
    const diagnostics = await client.currentDocumentDiagnostics(current);
    expect(diagnostics.map(({ message }) => message)).toEqual(["fake diagnostic"]);
  });

  test("returns no current diagnostics when the diagnostics budget expires", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "silent.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      diagnosticsMs: 50,
      environment: { FAKE_DELAY_DIAGNOSTICS: "1", FAKE_PUSH: "none" },
    });

    await expect(
      client.currentDocumentDiagnostics(await client.synchronizeDocument(filePath, "typescript")),
    ).resolves.toEqual([]);
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

  test("omits unversioned cached pushes for documents that are not open", async () => {
    const directory = await createTemporaryDirectory();
    const client = await startFakeServer(directory, {
      environment: { FAKE_NO_PULL: "1" },
    });

    await client.request("fake/publishDiagnostics", { uri: "file:///not-synchronized.ts" });
    await expect(client.workspaceDiagnostics()).resolves.toMatchObject({
      status: "fresh",
      source: "push_cache",
      diagnosticsByUri: new Map(),
    });
  });

  test("omits a push that arrives after its document was closed", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "closed.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      environment: { FAKE_NO_PULL: "1", FAKE_PUSH: "none" },
    });

    const document = await client.synchronizeDocument(filePath, "typescript");
    await client.closeDocument(filePath);
    await client.request("fake/publishDiagnostics", { uri: document.uri });
    await expect(client.workspaceDiagnostics()).resolves.toMatchObject({
      status: "fresh",
      source: "push_cache",
      diagnosticsByUri: new Map(),
    });
  });

  test("reports no workspace diagnostics from a server that only answers document pulls", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "document-pull.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      environment: { FAKE_DIAGNOSTICS: "one", FAKE_NO_WORKSPACE_PULL: "1", FAKE_PUSH: "none" },
    });

    const documentDiagnostics = await client.documentDiagnostics(filePath, "typescript");
    expect(documentDiagnostics.diagnostics).toHaveLength(1);
    await expect(client.workspaceDiagnostics()).resolves.toEqual({ status: "unsupported" });
  });

  test("returns cached pushes from a document-pull server that also publishes", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = resolve(directory, "document-pull-push.ts");
    await writeFile(filePath, "export const value = true;\n");
    const client = await startFakeServer(directory, {
      environment: { FAKE_DIAGNOSTICS: "one", FAKE_NO_WORKSPACE_PULL: "1" },
    });

    const document = await client.synchronizeDocument(filePath, "typescript");
    await client.request("fake/state", {});
    await expect(client.workspaceDiagnostics()).resolves.toMatchObject({
      status: "fresh",
      source: "push_cache",
      diagnosticsByUri: new Map([[document.uri, [expect.objectContaining({ source: "fake" })]]]),
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

  test("shuts down after the connection closes before the process exits", async () => {
    const directory = await createTemporaryDirectory();
    const failures: LspServerClientError[] = [];
    const client = await startFakeServer(directory, {
      environment: { FAKE_CLOSE_STDOUT: "1" },
      onUnavailable: (error) => failures.push(error),
    });
    await expect.poll(() => failures.length, { timeout: 2_000 }).toBe(1);
    const processId = client.processId;
    if (processId === undefined) throw new Error("Fake LSP test: missing process ID");
    expect(() => process.kill(processId, 0)).not.toThrow();

    await expect(client.shutdown()).resolves.toBeUndefined();
    await expect.poll(() => isProcessAlive(processId), { timeout: 2_000 }).toBe(false);
  });
});

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}
