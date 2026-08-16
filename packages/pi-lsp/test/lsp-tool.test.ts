import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  PositionEncodingKind,
  type LSPAny,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol/node";
import type {
  LspDocumentDiagnosticResult,
  LspSynchronizedDocument,
  LspWorkspaceDiagnosticResult,
} from "../src/lsp-server-client.js";
import { LspServerManager } from "../src/lsp-server-manager.js";
import { createLspSessionFiles, type LspSessionFiles } from "../src/lsp-session-files.js";
import {
  LspToolParametersSchema,
  type LspToolParameters,
  type LspToolResultDetails,
} from "../src/lsp-tool-contract.js";
import {
  registerLspTool,
  type LspToolDependencies,
  type LspToolRegistrar,
  type LspToolServerClient,
} from "../src/lsp-tool.js";
import {
  LspWorkspaceEditStore,
  nodeLspWorkspaceEditFileOperations,
  type LspWorkspaceEditFileOperations,
} from "../src/lsp-workspace-edit.js";
import type { ResolvedLspSettings } from "../src/pi-lsp-settings.js";

const temporaryDirectories: string[] = [];

class RecordingLspClient implements LspToolServerClient {
  readonly capabilities: LSPAny = {};
  readonly positionEncoding = PositionEncodingKind.UTF16;
  readonly requests: string[] = [];
  responseByMethod = new Map<string, LSPAny>();
  failureByMethod = new Map<string, Error>();
  shutdownCount = 0;

  hasCapability(_method: string): boolean {
    return true;
  }

  async synchronizeDocument(
    filePath: string,
    _languageId: string,
  ): Promise<LspSynchronizedDocument> {
    const text = await readFile(filePath, "utf8");
    return {
      filePath,
      uri: pathToFileURL(filePath).href,
      version: 1,
      text,
    };
  }

  async request<TResult>(
    method: string,
    _parameters: LSPAny,
    _signal?: AbortSignal,
  ): Promise<TResult> {
    this.requests.push(method);
    const failure = this.failureByMethod.get(method);
    if (failure !== undefined) throw failure;
    const response = this.responseByMethod.get(method) ?? [];
    // SAFETY: Each test configures the response for the exact protocol method selected by the typed tool branch.
    return response as TResult;
  }

  async documentDiagnostics(
    _filePath: string,
    _languageId: string,
    _signal?: AbortSignal,
  ): Promise<LspDocumentDiagnosticResult> {
    this.requests.push("textDocument/diagnostic");
    return { status: "fresh", source: "push", diagnostics: [] };
  }

  async workspaceDiagnostics(_signal?: AbortSignal): Promise<LspWorkspaceDiagnosticResult> {
    this.requests.push("workspace/diagnostic");
    return {
      status: "fresh",
      source: "push_cache",
      diagnosticsByUri: new Map(),
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }
}

class RecordingLspToolRegistrar implements LspToolRegistrar {
  readonly tools: ToolDefinition<typeof LspToolParametersSchema, LspToolResultDetails>[] = [];

  registerTool(tool: ToolDefinition<typeof LspToolParametersSchema, LspToolResultDetails>): void {
    this.tools.push(tool);
  }
}

interface LspToolFixture {
  readonly client: RecordingLspClient;
  readonly context: ExtensionContext;
  readonly dependencies: LspToolDependencies;
  readonly filePath: string;
  readonly sessionFiles: LspSessionFiles;
  readonly tool: ToolDefinition<typeof LspToolParametersSchema, LspToolResultDetails>;
  close(): Promise<void>;
}

function resolvedSettings(serverIds: readonly string[]): ResolvedLspSettings {
  return {
    enabled: true,
    warnings: [],
    timeouts: {
      diagnosticsMs: 100,
      initializeMs: 100,
      requestMs: 100,
      shutdownMs: 100,
    },
    servers: new Map(
      serverIds.map((id) => [
        id,
        {
          id,
          command: "fake",
          args: [],
          environment: {},
          languages: [{ extensions: [".ts"], fileNames: [], languageId: "typescript" }],
          rootMarkers: [],
        },
      ]),
    ),
  };
}

async function createToolFixture(
  serverIds: readonly string[] = ["typescript"],
): Promise<LspToolFixture> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-tool-"));
  temporaryDirectories.push(cwd);
  const filePath = resolve(cwd, "source.ts");
  await writeFile(filePath, "const emoji = '😀';\n");
  const client = new RecordingLspClient();
  const sessionFiles = await createLspSessionFiles(cwd);
  const manager = new LspServerManager<LspToolServerClient>({
    cwd,
    settings: resolvedSettings(serverIds),
    startClient: async () => client,
  });
  const dependencies: LspToolDependencies = {
    manager,
    workspaceEdits: new LspWorkspaceEditStore(),
    sessionFiles,
  };
  const registrar = new RecordingLspToolRegistrar();
  registerLspTool(registrar, dependencies);
  expect(registrar.tools).toHaveLength(1);
  const tool = registrar.tools[0];
  if (tool === undefined) throw new Error("Expected registered LSP tool");
  // SAFETY: Tool execution only reads cwd from ExtensionContext; the recording fixture supplies that complete observed surface.
  const context = { cwd } as ExtensionContext;
  return {
    client,
    context,
    dependencies,
    filePath,
    sessionFiles,
    tool,
    close: async () => {
      await manager.shutdown();
      await sessionFiles.close();
    },
  };
}

async function executeTool(
  fixture: LspToolFixture,
  input: LSPAny,
): Promise<AgentToolResult<LspToolResultDetails>> {
  return fixture.tool.execute("tool-call", input, undefined, undefined, fixture.context);
}

function oneBasedRange() {
  return {
    start: { line: 1, character: 1 },
    end: { line: 1, character: 1 },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("registered LSP tool", () => {
  test("registers one strict definition and dispatches every protocol operation", async () => {
    const fixture = await createToolFixture();
    const uri = pathToFileURL(fixture.filePath).href;
    const edit: WorkspaceEdit = {
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "// ",
          },
        ],
      },
    };
    fixture.client.responseByMethod.set("textDocument/rename", edit);
    fixture.client.responseByMethod.set("textDocument/formatting", edit.changes?.[uri] ?? []);
    fixture.client.responseByMethod.set("textDocument/rangeFormatting", edit.changes?.[uri] ?? []);
    fixture.client.responseByMethod.set("textDocument/onTypeFormatting", edit.changes?.[uri] ?? []);
    const hierarchyItem = {
      name: "value",
      kind: 13,
      uri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    };
    fixture.client.responseByMethod.set("textDocument/prepareCallHierarchy", [hierarchyItem]);
    fixture.client.responseByMethod.set("textDocument/prepareTypeHierarchy", [hierarchyItem]);
    fixture.client.responseByMethod.set("textDocument/codeAction", [
      { title: "Run command", command: "example.run" },
      { title: "Apply edit", edit },
    ]);
    fixture.client.capabilities.codeActionProvider = { resolveProvider: true };
    fixture.client.responseByMethod.set("codeAction/resolve", { title: "Apply edit", edit });
    fixture.client.capabilities.documentLinkProvider = { resolveProvider: true };
    fixture.client.responseByMethod.set("textDocument/documentLink", [{ target: uri, data: 1 }]);
    fixture.client.responseByMethod.set("documentLink/resolve", [{ target: uri }]);

    const operationCases: readonly {
      readonly input: LspToolParameters;
      readonly requests: readonly string[];
    }[] = [
      {
        input: { operation: "diagnostics", file_path: fixture.filePath },
        requests: ["textDocument/diagnostic"],
      },
      {
        input: {
          operation: "workspace_diagnostics",
          server_id: "typescript",
          file_path: fixture.filePath,
        },
        requests: ["workspace/diagnostic"],
      },
      {
        input: { operation: "completion", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/completion"],
      },
      {
        input: { operation: "hover", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/hover"],
      },
      {
        input: { operation: "signature_help", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/signatureHelp"],
      },
      {
        input: { operation: "declaration", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/declaration"],
      },
      {
        input: { operation: "goto_definition", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/definition"],
      },
      {
        input: {
          operation: "goto_type_definition",
          file_path: fixture.filePath,
          line: 1,
          character: 1,
        },
        requests: ["textDocument/typeDefinition"],
      },
      {
        input: {
          operation: "goto_implementation",
          file_path: fixture.filePath,
          line: 1,
          character: 1,
        },
        requests: ["textDocument/implementation"],
      },
      {
        input: { operation: "find_references", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/references"],
      },
      {
        input: {
          operation: "document_highlights",
          file_path: fixture.filePath,
          line: 1,
          character: 1,
        },
        requests: ["textDocument/documentHighlight"],
      },
      {
        input: { operation: "document_symbols", file_path: fixture.filePath },
        requests: ["textDocument/documentSymbol"],
      },
      {
        input: { operation: "workspace_symbols", query: "value", file_path: fixture.filePath },
        requests: ["workspace/symbol"],
      },
      {
        input: { operation: "document_links", file_path: fixture.filePath },
        requests: ["textDocument/documentLink", "documentLink/resolve"],
      },
      {
        input: { operation: "call_hierarchy", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/prepareCallHierarchy"],
      },
      {
        input: { operation: "incoming_calls", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls"],
      },
      {
        input: { operation: "outgoing_calls", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/prepareCallHierarchy", "callHierarchy/outgoingCalls"],
      },
      {
        input: { operation: "type_hierarchy", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/prepareTypeHierarchy"],
      },
      {
        input: { operation: "supertypes", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/prepareTypeHierarchy", "typeHierarchy/supertypes"],
      },
      {
        input: { operation: "subtypes", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/prepareTypeHierarchy", "typeHierarchy/subtypes"],
      },
      {
        input: {
          operation: "selection_ranges",
          file_path: fixture.filePath,
          positions: [{ line: 1, character: 1 }],
        },
        requests: ["textDocument/selectionRange"],
      },
      {
        input: { operation: "folding_ranges", file_path: fixture.filePath },
        requests: ["textDocument/foldingRange"],
      },
      {
        input: { operation: "code_lenses", file_path: fixture.filePath },
        requests: ["textDocument/codeLens"],
      },
      {
        input: { operation: "inlay_hints", file_path: fixture.filePath, range: oneBasedRange() },
        requests: ["textDocument/inlayHint"],
      },
      {
        input: { operation: "document_colors", file_path: fixture.filePath },
        requests: ["textDocument/documentColor"],
      },
      {
        input: {
          operation: "format_document",
          file_path: fixture.filePath,
          tab_size: 2,
          insert_spaces: true,
        },
        requests: ["textDocument/formatting"],
      },
      {
        input: {
          operation: "format_range",
          file_path: fixture.filePath,
          range: oneBasedRange(),
          tab_size: 2,
          insert_spaces: true,
        },
        requests: ["textDocument/rangeFormatting"],
      },
      {
        input: {
          operation: "format_on_type",
          file_path: fixture.filePath,
          line: 1,
          character: 1,
          trigger_character: ";",
          tab_size: 2,
          insert_spaces: true,
        },
        requests: ["textDocument/onTypeFormatting"],
      },
      {
        input: { operation: "prepare_rename", file_path: fixture.filePath, line: 1, character: 1 },
        requests: ["textDocument/prepareRename"],
      },
      {
        input: {
          operation: "rename",
          file_path: fixture.filePath,
          line: 1,
          character: 1,
          new_name: "renamed",
        },
        requests: ["textDocument/rename"],
      },
      {
        input: { operation: "code_actions", file_path: fixture.filePath, range: oneBasedRange() },
        requests: ["textDocument/codeAction", "codeAction/resolve"],
      },
    ];

    await executeTool(fixture, { operation: "status" });
    await executeTool(fixture, {
      operation: "capabilities",
      server_id: "typescript",
      file_path: fixture.filePath,
    });
    await executeTool(fixture, {
      operation: "restart",
      server_id: "typescript",
      file_path: fixture.filePath,
    });
    for (const operationCase of operationCases) {
      fixture.client.requests.length = 0;
      const result = await executeTool(fixture, operationCase.input);
      expect(result.content).toHaveLength(1);
      expect(fixture.client.requests).toEqual(operationCase.requests);
      if (operationCase.input.operation === "code_actions") {
        expect(result.details).toMatchObject({
          kind: "operation",
          preview_records: [expect.objectContaining({ state: "available" })],
        });
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        expect(text).toContain('"applicable":false');
        expect(text).toContain('"applicable":true');
      }
    }

    const preview = await fixture.dependencies.workspaceEdits.createPreview({
      edit,
      serverId: "typescript",
    });
    const prepared = fixture.tool.prepareArguments?.({
      operation: "apply",
      preview_id: preview.preview_id,
      mutation_manifest: [{ operation: "delete", path: fixture.filePath }],
    });
    if (prepared === undefined) throw new Error("Expected apply argument preparation");
    const applyResult = await executeTool(fixture, prepared);
    expect(applyResult.details).toMatchObject({
      kind: "workspace_edit_apply",
      preview_id: preview.preview_id,
      state: "applied",
    });
    await fixture.close();
  });

  test("keeps successful multi-server position reads with labeled warnings", async () => {
    const fixture = await createToolFixture(["good", "failing"]);
    let starts = 0;
    const good = new RecordingLspClient();
    const failing = new RecordingLspClient();
    failing.failureByMethod.set("textDocument/hover", new Error("expected failure"));
    const manager = new LspServerManager<LspToolServerClient>({
      cwd: fixture.context.cwd,
      settings: resolvedSettings(["good", "failing"]),
      startClient: async ({ definition }) => {
        starts++;
        return definition.id === "good" ? good : failing;
      },
    });
    const registrar = new RecordingLspToolRegistrar();
    registerLspTool(registrar, {
      ...fixture.dependencies,
      manager,
    });
    const tool = registrar.tools[0];
    if (tool === undefined) throw new Error("Expected registered LSP tool");
    const result = await tool.execute(
      "hover",
      { operation: "hover", file_path: fixture.filePath, line: 1, character: 1 },
      undefined,
      undefined,
      fixture.context,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(starts).toBe(2);
    expect(text).toContain("expected failure");
    expect(result.details).toMatchObject({
      server_outcomes: expect.arrayContaining([
        expect.objectContaining({ outcome: "success", server_id: "good" }),
        expect.objectContaining({ outcome: "error", server_id: "failing" }),
      ]),
    });
    await manager.shutdown();
    await fixture.close();
  });

  test("converts LocationLink source and target ranges against their own Unicode text", async () => {
    const fixture = await createToolFixture();
    const targetPath = resolve(fixture.context.cwd, "target.ts");
    await writeFile(fixture.filePath, "😀source");
    await writeFile(targetPath, "xx😀target");
    fixture.client.responseByMethod.set("textDocument/hover", [
      {
        originSelectionRange: {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 2 },
        },
        targetUri: pathToFileURL(targetPath).href,
        targetRange: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 4 },
        },
        targetSelectionRange: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 4 },
        },
      },
    ]);

    const result = await executeTool(fixture, {
      operation: "hover",
      file_path: fixture.filePath,
      line: 1,
      character: 1,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain('"originSelectionRange":{"end":{"character":2');
    expect(text).toContain('"targetRange":{"end":{"character":4');
    expect(text).toContain('"targetSelectionRange":{"end":{"character":4');
    await fixture.close();
  });

  test("exposes a server-initiated workspace edit preview through the active result", async () => {
    const fixture = await createToolFixture();
    const preview = await fixture.dependencies.workspaceEdits.createPreview({
      edit: {
        changes: {
          [pathToFileURL(fixture.filePath).href]: [
            {
              newText: "// server edit\n",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            },
          ],
        },
      },
      serverId: "typescript",
    });
    const result = await executeTool(fixture, {
      operation: "hover",
      file_path: fixture.filePath,
      line: 1,
      character: 1,
    });
    expect(result.details).toMatchObject({
      kind: "operation",
      preview_records: [expect.objectContaining({ preview_id: preview.preview_id })],
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain(`Server Workspace Edit Preview: ${preview.preview_id}`);
    await fixture.close();
  });

  test("returns partial-failure details when rollback leaves a changed file", async () => {
    const fixture = await createToolFixture();
    const secondFile = resolve(fixture.context.cwd, "second.ts");
    await writeFile(secondFile, "second");
    let replacements = 0;
    const failingFiles: LspWorkspaceEditFileOperations = {
      ...nodeLspWorkspaceEditFileOperations,
      async replaceFile(path, contents, mode) {
        replacements++;
        if (replacements >= 2) throw new Error(`injected replacement failure ${replacements}`);
        await nodeLspWorkspaceEditFileOperations.replaceFile(path, contents, mode);
      },
    };
    const workspaceEdits = new LspWorkspaceEditStore({ fileOperations: failingFiles });
    const registrar = new RecordingLspToolRegistrar();
    registerLspTool(registrar, { ...fixture.dependencies, workspaceEdits });
    const tool = registrar.tools[0];
    if (tool === undefined) throw new Error("Expected registered LSP tool");
    const preview = await workspaceEdits.createPreview({
      edit: {
        changes: {
          [pathToFileURL(fixture.filePath).href]: [
            {
              newText: "changed",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            },
          ],
          [pathToFileURL(secondFile).href]: [
            {
              newText: "changed",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
            },
          ],
        },
      },
      serverId: "typescript",
    });
    const prepared = tool.prepareArguments?.({
      operation: "apply",
      preview_id: preview.preview_id,
    });
    if (prepared === undefined) throw new Error("Expected prepared apply arguments");
    const result = await tool.execute(
      "partial-apply",
      prepared,
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details).toMatchObject({
      kind: "workspace_edit_apply",
      changed_paths: [fixture.filePath],
      recovery_failure_paths: [fixture.filePath],
      state: "partial_failure",
    });
    await fixture.close();
  });

  test("revalidates hook-mutated apply manifests and spills complete oversized output", async () => {
    const fixture = await createToolFixture();
    await expect(
      executeTool(fixture, {
        operation: "hover",
        file_path: fixture.filePath,
        line: 0,
        character: 1,
      }),
    ).rejects.toThrow("Pi LSP: invalid tool arguments");
    const edit: WorkspaceEdit = {
      changes: {
        [pathToFileURL(fixture.filePath).href]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "// guarded\n",
          },
        ],
      },
    };
    const preview = await fixture.dependencies.workspaceEdits.createPreview({
      edit,
      serverId: "typescript",
    });
    const prepared = fixture.tool.prepareArguments?.({
      operation: "apply",
      preview_id: preview.preview_id,
    });
    if (prepared === undefined || prepared.operation !== "apply") {
      throw new Error("Expected prepared apply arguments");
    }
    await expect(
      executeTool(fixture, {
        ...prepared,
        mutation_manifest: [{ operation: "delete", path: fixture.filePath }],
      }),
    ).rejects.toThrow("Pi LSP: Mutation Manifest changed after argument preparation");

    fixture.client.responseByMethod.set("workspace/symbol", [{ name: "x".repeat(60 * 1024) }]);
    const spillResult = await executeTool(fixture, {
      operation: "workspace_symbols",
      query: "x",
      file_path: fixture.filePath,
    });
    expect(spillResult.details).toMatchObject({
      kind: "operation",
      spill_path: expect.any(String),
    });
    if (spillResult.details.kind !== "operation" || spillResult.details.spill_path === undefined) {
      throw new Error("Expected Result Spill path");
    }
    expect(await readFile(spillResult.details.spill_path, "utf8")).toContain("x".repeat(1024));
    await fixture.close();
  });
});
