import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolAnnotations,
  ToolDefinition,
  ToolExposure,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";
import {
  type Diagnostic,
  PositionEncodingKind,
  type ServerCapabilities,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol/node";
import { LspInputError } from "../src/lsp-input-error.js";
import {
  LspServerClientError,
  type LspDocumentDiagnosticResult,
  type LspSynchronizedDocument,
  type LspWorkspaceDiagnosticResult,
} from "../src/lsp-server-client.js";
import { LspServerManager } from "../src/lsp-server-manager.js";
import { createLspSessionFiles, type LspSessionFiles } from "../src/lsp-session-files.js";
import { formatLspToolValue } from "../src/lsp-tool-output.js";
import {
  LSP_OPERATION_NAMES,
  LspApplyOutputSchema,
  LspPlainReadOutputSchema,
  LspPositionReadOutputSchema,
  LspReadOutputSchema,
  LspCodeActionsOutputSchema,
  LspStatusOutputSchema,
  type LspToolParameters,
  type LspToolResultDetails,
} from "../src/lsp-tool-contract.js";
import {
  createLspApplyToolDefinition,
  createLspToolDefinition,
  LSP_TOOL_GUIDELINE,
  LSP_TOOL_NAMESPACE,
  registerLspTools,
  type LspToolDependencies,
  type LspToolRegistrar,
  type LspToolServerClient,
} from "../src/lsp-tool.js";
import {
  LspWorkspaceEditStore,
  nodeLspWorkspaceEditFileOperations,
  type LspWorkspaceEditFileOperations,
} from "../src/lsp-workspace-edit.js";
import {
  TROUBLESHOOTING_HINT,
  TROUBLESHOOTING_SKILL_PATH,
  TROUBLESHOOTING_WARNING_POINTER,
} from "../src/troubleshooting-skill.js";
import type { ResolvedLspSettings } from "../src/pi-lsp-settings.js";
import { LSP_WARM_UP_LIMITS, type LspWarmUpLimits } from "../src/lsp-workspace-warm-up.js";
import { testTimeouts } from "./lsp-timeouts.js";

const temporaryDirectories: string[] = [];

/** Warm-up bounds that open nothing, so a test sees the unloaded-package warning. */
const NO_WARM_UP = { packageLimit: 0, timeoutMs: 0 };

class RecordingLspClient implements LspToolServerClient {
  readonly capabilities: ServerCapabilities = {};
  readonly positionEncoding = PositionEncodingKind.UTF16;
  readonly requests: string[] = [];
  readonly parametersByMethod = new Map<string, unknown[]>();
  responseByMethod = new Map<string, unknown>();
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Responders simulate servers over opaque protocol payloads.
  responderByMethod = new Map<string, (parameters: unknown) => unknown>();
  currentDiagnostics: Diagnostic[] = [];
  documentDiagnosticsResult: LspDocumentDiagnosticResult = {
    status: "fresh",
    source: "push",
    diagnostics: [],
  };
  currentDiagnosticsFailure: Error | undefined;
  workspaceDiagnosticsFailure: Error | undefined;
  synchronizationFailure: Error | undefined;
  workspaceDiagnosticsResult: LspWorkspaceDiagnosticResult = {
    status: "fresh",
    source: "push_cache",
    diagnosticsByUri: new Map(),
  };
  failureByMethod = new Map<string, Error>();
  readonly unsupportedMethods = new Set<string>();
  readonly synchronizedPaths = new Set<string>();
  shutdownCount = 0;

  hasCapability(method: string): boolean {
    return !this.unsupportedMethods.has(method);
  }

  async synchronizeDocument(
    filePath: string,
    _languageId: string,
  ): Promise<LspSynchronizedDocument> {
    if (this.synchronizationFailure !== undefined) throw this.synchronizationFailure;
    const text = await readFile(filePath, "utf8");
    this.synchronizedPaths.add(resolve(filePath));
    return {
      uri: pathToFileURL(filePath).href,
      version: 1,
      text,
    };
  }

  synchronizedDocumentPaths(): readonly string[] {
    return [...this.synchronizedPaths];
  }

  async request(
    method: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The recording protocol transport deliberately accepts opaque method payloads, like the real client.
    parameters: unknown,
    _signal?: AbortSignal,
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Fixture responses remain unparsed until the real dispatch/preview boundary checks them.
  ): Promise<unknown> {
    this.requests.push(method);
    this.parametersByMethod.set(method, [
      ...(this.parametersByMethod.get(method) ?? []),
      parameters,
    ]);
    const failure = this.failureByMethod.get(method);
    if (failure !== undefined) throw failure;
    const responder = this.responderByMethod.get(method);
    if (responder !== undefined) return responder(parameters);
    const response = this.responseByMethod.get(method) ?? [];
    return response;
  }

  async currentDocumentDiagnostics(
    _document: LspSynchronizedDocument,
    _signal?: AbortSignal,
  ): Promise<readonly Diagnostic[]> {
    if (this.currentDiagnosticsFailure !== undefined) throw this.currentDiagnosticsFailure;
    return this.currentDiagnostics;
  }

  async documentDiagnostics(
    _filePath: string,
    _languageId: string,
    _signal?: AbortSignal,
  ): Promise<LspDocumentDiagnosticResult> {
    this.requests.push("textDocument/diagnostic");
    return this.documentDiagnosticsResult;
  }

  async workspaceDiagnostics(_signal?: AbortSignal): Promise<LspWorkspaceDiagnosticResult> {
    this.requests.push("workspace/diagnostic");
    if (this.workspaceDiagnosticsFailure !== undefined) throw this.workspaceDiagnosticsFailure;
    return this.workspaceDiagnosticsResult;
  }

  async shutdown(): Promise<void> {
    this.shutdownCount++;
  }
}

/** The registration fields Pi reads to declare, list, and gate one tool. */
interface RegisteredLspTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly outputSchema: TSchema | undefined;
  readonly exposure: ToolExposure | undefined;
  readonly namespace: ToolNamespace | undefined;
  readonly annotations: ToolAnnotations | undefined;
  readonly promptGuidelines: readonly string[] | undefined;
  readonly promptSnippet: string | undefined;
  readonly hasPrepareArguments: boolean;
}

class RecordingLspToolRegistrar implements LspToolRegistrar {
  readonly tools: RegisteredLspTool[] = [];

  registerTool<TParams extends TSchema>(tool: ToolDefinition<TParams, LspToolResultDetails>): void {
    this.tools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      outputSchema: tool.outputSchema,
      exposure: tool.exposure,
      namespace: tool.namespace,
      annotations: tool.annotations,
      promptGuidelines: tool.promptGuidelines,
      promptSnippet: tool.promptSnippet,
      hasPrepareArguments: tool.prepareArguments !== undefined,
    });
  }
}

interface LspToolFixture {
  readonly client: RecordingLspClient;
  readonly context: ExtensionToolContext;
  readonly dependencies: LspToolDependencies;
  readonly filePath: string;
  readonly sessionFiles: LspSessionFiles;
  close(): Promise<void>;
}

function resolvedSettings(
  serverIds: readonly string[],
  rootMarkers: readonly string[] = [],
): ResolvedLspSettings {
  return {
    enablement: new Map(),
    includeHintDiagnostics: false,
    warnings: [],
    timeouts: testTimeouts({
      diagnosticsMs: 100,
      initializeMs: 100,
      requestMs: 100,
      shutdownMs: 100,
      workspaceRequestMs: 100,
    }),
    servers: new Map(
      serverIds.map((id) => [
        id,
        {
          id,
          command: "fake",
          args: [],
          environment: {},
          languages: [{ extensions: [".ts"], fileNames: [], languageId: "typescript" }],
          maxConcurrentDiagnostics: 2,
          requireRootMarker: false,
          rootMarkers: [...rootMarkers],
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
  // SAFETY: Tool execution only reads cwd from ExtensionContext; the recording fixture supplies that complete observed surface.
  const context = { cwd } as ExtensionToolContext;
  return {
    client,
    context,
    dependencies,
    filePath,
    sessionFiles,
    close: async () => {
      await manager.shutdown();
      await sessionFiles.close();
    },
  };
}

/** Execute one operation through its own `lsp_<operation>` ToolDefinition. */
async function executeTool(
  fixture: LspToolFixture,
  call: LspToolParameters,
  dependencies: LspToolDependencies = fixture.dependencies,
): Promise<AgentToolResult<LspToolResultDetails>> {
  if (call.operation === "apply") {
    const { operation: _operation, ...applyInput } = call;
    return createLspApplyToolDefinition(() => dependencies).execute(
      "tool-call",
      applyInput,
      undefined,
      undefined,
      fixture.context,
    );
  }
  const { operation, ...input } = call;
  const tool = createLspToolDefinition(operation, () => dependencies);
  return tool.execute("tool-call", input, undefined, undefined, fixture.context);
}

/** Prepare `lsp_apply` arguments as Pi does before its `tool_call` hooks run. */
function prepareApply(
  fixture: LspToolFixture,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preparation receives raw model arguments.
  argumentsValue: unknown,
  dependencies: LspToolDependencies = fixture.dependencies,
) {
  const prepared = createLspApplyToolDefinition(() => dependencies).prepareArguments?.(
    argumentsValue,
  );
  if (prepared === undefined) throw new Error("Expected apply argument preparation");
  return prepared;
}

function resultText(result: AgentToolResult<LspToolResultDetails>): string {
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

function range() {
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
  test("registers one namespaced tool per operation with exact exposure and annotations", async () => {
    const fixture = await createToolFixture();
    const registrar = new RecordingLspToolRegistrar();
    registerLspTools(registrar, () => fixture.dependencies);

    expect(registrar.tools.map(({ name }) => name)).toEqual(
      LSP_OPERATION_NAMES.map((operation) => `lsp_${operation}`),
    );
    expect(
      registrar.tools.filter(({ exposure }) => exposure === "direct").map(({ name }) => name),
    ).toEqual([
      "lsp_status",
      "lsp_diagnostics",
      "lsp_hover",
      "lsp_goto_definition",
      "lsp_find_references",
      "lsp_document_symbols",
      "lsp_workspace_symbols",
      "lsp_rename",
      "lsp_code_actions",
      "lsp_apply",
    ]);
    for (const tool of registrar.tools) {
      expect(tool.exposure === "direct" || tool.exposure === "codemode", tool.name).toBe(true);
      expect(tool.namespace, tool.name).toBe(LSP_TOOL_NAMESPACE);
      expect(tool.promptGuidelines, tool.name).toEqual(
        tool.exposure === "direct" ? [LSP_TOOL_GUIDELINE] : [],
      );
      expect(tool.outputSchema, tool.name).toMatchObject({ type: "object" });
      // Every tool accepts null for an optional parameter through `prepareArguments`.
      expect(tool.hasPrepareArguments, tool.name).toBe(true);
    }

    const annotationsOf = (name: string) =>
      registrar.tools.find((tool) => tool.name === name)?.annotations;
    expect(annotationsOf("lsp_hover")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotationsOf("lsp_apply")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(registrar.tools.find(({ name }) => name === "lsp_hover")?.outputSchema).toBe(
      LspPositionReadOutputSchema,
    );
    expect(registrar.tools.find(({ name }) => name === "lsp_diagnostics")?.outputSchema).toBe(
      LspPlainReadOutputSchema,
    );
    expect(registrar.tools.find(({ name }) => name === "lsp_apply")?.outputSchema).toBe(
      LspApplyOutputSchema,
    );
    await fixture.close();
  });

  test("dispatches every protocol operation through its own tool", async () => {
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
        // The default outline also asks for folding ranges, to leave import bindings out.
        requests: ["textDocument/foldingRange", "textDocument/documentSymbol"],
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
        input: { operation: "inlay_hints", file_path: fixture.filePath, range: range() },
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
          range: range(),
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
        input: { operation: "code_actions", file_path: fixture.filePath, range: range() },
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
        expect(result.structuredContent).toMatchObject({
          actions: [{ applicable: false }, { applicable: true }],
        });
      }
    }

    const preview = await fixture.dependencies.workspaceEdits.createPreview({
      edit,
      serverId: "typescript",
    });
    const prepared = prepareApply(fixture, {
      preview_id: preview.preview_id,
      mutation_manifest: [{ operation: "delete", path: fixture.filePath }],
    });
    const applyResult = await executeTool(fixture, { operation: "apply", ...prepared });
    expect(applyResult.details).toMatchObject({
      kind: "workspace_edit_apply",
      preview_id: preview.preview_id,
      state: "applied",
    });
    await fixture.close();
  });

  test("returns complete structured results for programmatic callers", async () => {
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
    fixture.client.responseByMethod.set("textDocument/references", [
      { uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } },
    ]);
    fixture.client.responseByMethod.set("textDocument/rename", edit);
    fixture.client.responseByMethod.set("textDocument/codeAction", [
      { title: "Run command", kind: "source", command: "example.run" },
      { title: "Apply edit", kind: "quickfix", edit },
    ]);

    const references = await executeTool(fixture, {
      operation: "find_references",
      file_path: fixture.filePath,
      line: 1,
      character: 7,
    });
    expect(references.structuredContent).toEqual({
      position: {
        path: fixture.filePath,
        line: 1,
        character: 7,
        token: "emoji",
        line_text: "const emoji = '😀';",
      },
      results: [
        {
          root_path: fixture.context.cwd,
          server_id: "typescript",
          value: [
            {
              uri: fixture.filePath,
              range: { start: { line: 1, character: 7 }, end: { line: 1, character: 12 } },
              path: fixture.filePath,
              line: 1,
              character: 7,
            },
          ],
        },
      ],
      warnings: [],
      structured_truncated: false,
      truncated: false,
    });
    expect(resultText(references)).toBe(
      [
        'Query position: source.ts:1:7 ("emoji")',
        `Searched typescript workspace root: ${fixture.context.cwd}`,
        "",
        "source.ts:1:7  const emoji = '😀';",
      ].join("\n"),
    );

    await executeTool(fixture, {
      operation: "hover",
      file_path: fixture.filePath,
      line: 1,
      character: 1,
    });
    const status = await executeTool(fixture, { operation: "status" });
    const runningServer = {
      server_id: "typescript",
      root_path: fixture.context.cwd,
      state: "running",
      languages: { typescript: [".ts"] },
    };
    expect(status.structuredContent).toEqual({
      servers: [runningServer],
      not_started: 0,
      warnings: [],
      structured_truncated: false,
      truncated: false,
    });
    expect(resultText(status)).toBe(`typescript running ${fixture.context.cwd} typescript(.ts)`);

    const rename = await executeTool(fixture, {
      operation: "rename",
      file_path: fixture.filePath,
      line: 1,
      character: 7,
      new_name: "renamed",
    });
    if (rename.details.kind !== "workspace_edit_preview") throw new Error("Expected a preview");
    expect(rename.structuredContent).toEqual({
      preview_id: rename.details.preview_id,
      server_id: "typescript",
      root_path: fixture.context.cwd,
      summary: rename.details.summary,
      warnings: [],
      mutation_manifest: [{ operation: "modify", path: fixture.filePath }],
      structured_truncated: false,
      truncated: false,
    });

    const actions = await executeTool(fixture, {
      operation: "code_actions",
      file_path: fixture.filePath,
      range: range(),
    });
    expect(actions.structuredContent).toMatchObject({
      actions: [
        {
          server_id: "typescript",
          applicable: false,
          title: "Run command",
          kind: "source",
          command: "example.run",
        },
        {
          server_id: "typescript",
          applicable: true,
          title: "Apply edit",
          kind: "quickfix",
          preview_id: expect.any(String),
        },
      ],
      warnings: [],
    });

    const prepared = prepareApply(fixture, { preview_id: rename.details.preview_id });
    const applied = await executeTool(fixture, { operation: "apply", ...prepared });
    expect(applied.isError).toBeUndefined();
    expect(resultText(applied)).toBe(
      [`Applied Workspace Edit Preview ${rename.details.preview_id}:`, "modified source.ts"].join(
        "\n",
      ),
    );
    expect(applied.structuredContent).toEqual({
      preview_id: rename.details.preview_id,
      state: "applied",
      changed_paths: [fixture.filePath],
      mutation_manifest: [{ operation: "modify", path: fixture.filePath }],
      changed_files: [fixture.filePath],
      created_files: [],
      deleted_files: [],
      moved_files: [],
      structured_truncated: false,
      truncated: false,
    });
    await fixture.close();
  });

  test("cuts document symbols to the requested depth in both the text and the structured result", async () => {
    const fixture = await createToolFixture();
    await writeFile(fixture.filePath, `${"0123456789\n".repeat(6)}`);
    const protocolRange = (line: number) => ({
      start: { line, character: 0 },
      end: { line, character: 10 },
    });
    const symbol = (name: string, kind: number, line: number, children: unknown[] = []) => ({
      name,
      kind,
      range: protocolRange(line),
      selectionRange: protocolRange(line),
      children,
    });
    fixture.client.responseByMethod.set("textDocument/documentSymbol", [
      symbol("Store", 5, 0, [symbol("add", 6, 1, [symbol("draft", 13, 2)])]),
      symbol("create", 12, 3, [symbol("state", 13, 4), symbol("callback", 12, 5)]),
    ]);
    const outline = async (parameters: { depth?: number | "all" }) => {
      const result = await executeTool(fixture, {
        operation: "document_symbols",
        file_path: fixture.filePath,
        ...parameters,
      });
      const structured = Value.Parse(LspReadOutputSchema, result.structuredContent);
      return {
        text: resultText(result)
          .split("\n")
          .map((line) => line.trim().split(" (")[0]),
        structured: JSON.stringify(structured.results.map(({ value }) => value)),
        omitted: structured.results.map((read) => read.omitted),
      };
    };

    const byDefault = await outline({});
    // The hint names the symbols the depth left out, and the structured result counts them.
    expect(byDefault.text).toEqual([
      "Store",
      "add",
      "create",
      '3 nested symbols omitted; raise depth or pass depth: "all" to see them.',
    ]);
    expect(byDefault.omitted).toEqual([3]);
    expect(byDefault.structured).toContain('"name":"add"');
    for (const hidden of ["draft", "state", "callback"]) {
      expect(byDefault.structured).not.toContain(`"name":"${hidden}"`);
    }
    expect((await outline({ depth: 2 })).omitted).toEqual([0]);
    expect((await outline({ depth: 2 })).text).toEqual([
      "Store",
      "add",
      "draft",
      "create",
      "state",
      "callback",
    ]);
    await fixture.close();
  });

  describe("import bindings in the document symbol outline", () => {
    const protocolRange = (line: number) => ({
      start: { line, character: 0 },
      end: { line, character: 10 },
    });
    const symbol = (name: string, kind: number, line: number) => ({
      name,
      kind,
      range: protocolRange(line),
      selectionRange: protocolRange(line),
      children: [],
    });
    const symbolRequests = (fixture: LspToolFixture) =>
      fixture.client.requests.filter(
        (method) =>
          method === "textDocument/foldingRange" || method === "textDocument/documentSymbol",
      );
    async function fixtureWithImports(): Promise<LspToolFixture> {
      const fixture = await createToolFixture();
      await writeFile(fixture.filePath, `${"0123456789\n".repeat(6)}`);
      fixture.client.responseByMethod.set("textDocument/documentSymbol", [
        symbol("alpha", 13, 0),
        symbol("beta", 13, 1),
        symbol("run", 12, 3),
      ]);
      fixture.client.responseByMethod.set("textDocument/foldingRange", [
        { startLine: 0, endLine: 1, kind: "imports" },
        { startLine: 3, endLine: 5, kind: "region" },
      ]);
      return fixture;
    }
    async function outline(fixture: LspToolFixture, parameters: { depth?: number | "all" } = {}) {
      const result = await executeTool(fixture, {
        operation: "document_symbols",
        file_path: fixture.filePath,
        ...parameters,
      });
      const structured = Value.Parse(LspReadOutputSchema, result.structuredContent);
      return {
        text: resultText(result)
          .split("\n")
          .map((line) => line.trim().split(" (")[0]),
        omitted: structured.results.map((read) => read.omitted),
        omittedImports: structured.results.map((read) => read.omitted_imports),
      };
    }

    test("drops top-level symbols inside an imports folding range with one extra request", async () => {
      const fixture = await fixtureWithImports();
      expect(await outline(fixture)).toEqual({
        text: ["run", '2 import bindings omitted; pass depth: "all" to see them.'],
        omitted: [2],
        omittedImports: [2],
      });
      expect(symbolRequests(fixture).toSorted()).toEqual([
        "textDocument/documentSymbol",
        "textDocument/foldingRange",
      ]);
      // The folding request names the document the symbols were read from.
      expect(fixture.client.parametersByMethod.get("textDocument/foldingRange")).toEqual(
        fixture.client.parametersByMethod
          .get("textDocument/documentSymbol")
          ?.map(() => ({ textDocument: { uri: pathToFileURL(fixture.filePath).href } })),
      );
      await fixture.close();
    });

    test("reports dropped imports apart from the nested symbols the depth drops", async () => {
      const fixture = await fixtureWithImports();
      fixture.client.responseByMethod.set("textDocument/documentSymbol", [
        symbol("alpha", 13, 0),
        { ...symbol("run", 12, 3), children: [symbol("local", 13, 4)] },
      ]);
      // The structured `omitted` sums both; the text counts each kind on its own line.
      expect(await outline(fixture)).toEqual({
        text: [
          "run",
          '1 nested symbol omitted; raise depth or pass depth: "all" to see it.',
          '1 import binding omitted; pass depth: "all" to see it.',
        ],
        omitted: [2],
        omittedImports: [1],
      });
      expect(await outline(fixture, { depth: 2 })).toMatchObject({
        text: ["run", "local", '1 import binding omitted; pass depth: "all" to see it.'],
        omitted: [1],
      });
      await fixture.close();
    });

    test("lists imports at depth all without asking for folding ranges", async () => {
      const fixture = await fixtureWithImports();
      expect(await outline(fixture, { depth: "all" })).toEqual({
        text: ["alpha", "beta", "run"],
        omitted: [0],
        omittedImports: [undefined],
      });
      expect(symbolRequests(fixture)).toEqual(["textDocument/documentSymbol"]);
      await fixture.close();
    });

    test("rejects when the call is aborted while the folding range request is pending", async () => {
      const fixture = await fixtureWithImports();
      const controller = new AbortController();
      fixture.client.responderByMethod.set("textDocument/foldingRange", () => {
        controller.abort();
        return Promise.reject(new Error("request cancelled"));
      });
      const tool = createLspToolDefinition("document_symbols", () => fixture.dependencies);
      await expect(
        tool.execute(
          "tool-call",
          { file_path: fixture.filePath },
          controller.signal,
          undefined,
          fixture.context,
        ),
      ).rejects.toThrow();
      await fixture.close();
    });

    test("falls back to listing imports when the folding range request fails", async () => {
      const fixture = await fixtureWithImports();
      fixture.client.failureByMethod.set("textDocument/foldingRange", new Error("timed out"));
      expect(await outline(fixture)).toEqual({
        text: ["alpha", "beta", "run"],
        omitted: [0],
        omittedImports: [undefined],
      });
      await fixture.close();
    });
  });

  test("lets a script pass any structured symbol or location straight to a position tool", async () => {
    const fixture = await createToolFixture();
    await writeFile(fixture.filePath, "class Outer {\n  inner() {}\n}\nconst target = 1;\n");
    const uri = pathToFileURL(fixture.filePath).href;
    const protocolRange = (line: number, start: number, end: number) => ({
      start: { line, character: start },
      end: { line, character: end },
    });
    fixture.client.responseByMethod.set("textDocument/documentSymbol", [
      {
        name: "Outer",
        kind: 5,
        range: protocolRange(0, 0, 3),
        selectionRange: protocolRange(0, 6, 11),
        children: [
          {
            name: "inner",
            kind: 6,
            range: protocolRange(1, 2, 20),
            selectionRange: protocolRange(1, 2, 7),
          },
        ],
      },
    ]);
    fixture.client.responseByMethod.set("workspace/symbol", [
      { name: "emoji", kind: 13, location: { uri, range: protocolRange(0, 6, 11) } },
      { name: "unlocated", kind: 99, location: { uri } },
    ]);
    fixture.client.responseByMethod.set("textDocument/definition", [
      {
        originSelectionRange: protocolRange(0, 0, 1),
        targetUri: uri,
        targetRange: protocolRange(3, 0, 17),
        targetSelectionRange: protocolRange(3, 6, 12),
      },
    ]);
    fixture.client.responseByMethod.set("textDocument/documentHighlight", [
      { range: protocolRange(0, 6, 11), kind: 3 },
    ]);
    const values = async (input: Parameters<typeof executeTool>[1]) => {
      const result = await executeTool(fixture, input);
      return Value.Parse(LspReadOutputSchema, result.structuredContent).results.map(
        ({ value }) => value,
      );
    };

    expect(
      await values({ operation: "document_symbols", file_path: fixture.filePath }),
    ).toMatchObject([
      [
        {
          name: "Outer",
          kind_name: "class",
          path: fixture.filePath,
          line: 1,
          character: 7,
          children: [
            { name: "inner", kind_name: "method", path: fixture.filePath, line: 2, character: 3 },
          ],
        },
      ],
    ]);
    const [workspace] = await values({
      operation: "workspace_symbols",
      query: "e",
      file_path: fixture.filePath,
    });
    expect(workspace).toMatchObject([
      { name: "emoji", kind_name: "variable", path: fixture.filePath, line: 1, character: 7 },
      { name: "unlocated", path: fixture.filePath },
    ]);
    // A symbol of an unnamed kind has no kind name, and one whose server named no range has a
    // path but no position to invent.
    expect(workspace).toEqual([
      expect.anything(),
      expect.not.objectContaining({ line: expect.anything(), kind_name: expect.anything() }),
    ]);
    const position = { file_path: fixture.filePath, line: 1, character: 7 };
    expect(await values({ operation: "goto_definition", ...position })).toMatchObject([
      [{ targetUri: fixture.filePath, path: fixture.filePath, line: 4, character: 7 }],
    ]);
    // Only the highlight itself gains fields; its raw range stays as the server sent it.
    expect(await values({ operation: "document_highlights", ...position })).toEqual([
      [
        {
          kind: 3,
          path: fixture.filePath,
          line: 1,
          character: 7,
          range: { start: { line: 1, character: 7 }, end: { line: 1, character: 12 } },
        },
      ],
    ]);
    await fixture.close();
  });

  test("filters completions by the identifier before the position and resolves only the kept items", async () => {
    const fixture = await createToolFixture();
    fixture.client.capabilities.completionProvider = { resolveProvider: true };
    const items = [
      { label: "emotion", kind: 6, sortText: "2", data: { token: "private-emotion" } },
      { label: "encodeURI", kind: 3, data: { token: "private-encode" } },
      { label: "emoji", kind: 6, sortText: "1", data: { token: "private-emoji" } },
      { label: "Emoticon", kind: 7, sortText: "3", data: { token: "private-emoticon" } },
    ];
    fixture.client.responseByMethod.set("textDocument/completion", {
      isIncomplete: false,
      items,
    });
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The resolve responder receives an opaque protocol item.
    fixture.client.responderByMethod.set("completionItem/resolve", (item: unknown) => ({
      ...Value.Parse(Type.Object({ label: Type.String() }, { additionalProperties: true }), item),
      detail: "resolved",
    }));

    // `const emo|ji`: the identifier before the position is "emo".
    const result = await executeTool(fixture, {
      operation: "completion",
      file_path: fixture.filePath,
      line: 1,
      character: 10,
      limit: 2,
    });

    expect(resultText(result)).toBe(
      [
        'Query position: source.ts:1:10 ("emoji")',
        "",
        'Completions starting with "emo":',
        "emoji (variable)  resolved",
        "emotion (variable)  resolved",
        "1 more omitted; raise limit or refine the prefix to see them.",
      ].join("\n"),
    );
    expect(resultText(result)).not.toContain("private-");
    expect(fixture.client.parametersByMethod.get("completionItem/resolve")).toEqual([
      items[2],
      items[0],
    ]);
    expect(result.structuredContent).toEqual({
      position: {
        path: fixture.filePath,
        line: 1,
        character: 10,
        token: "emoji",
        line_text: "const emoji = '😀';",
      },
      results: [
        {
          root_path: fixture.context.cwd,
          server_id: "typescript",
          prefix: "emo",
          omitted: 1,
          value: {
            isIncomplete: false,
            items: [
              { ...items[2], detail: "resolved" },
              { ...items[0], detail: "resolved" },
            ],
          },
        },
      ],
      warnings: [],
      structured_truncated: false,
      truncated: false,
    });
    expect(result.details).toMatchObject({ operation: "completion", result_count: 2 });

    const explicit = await executeTool(fixture, {
      operation: "completion",
      file_path: fixture.filePath,
      line: 1,
      character: 10,
      prefix: "",
    });
    expect(resultText(explicit).split("\n")).toEqual([
      'Query position: source.ts:1:10 ("emoji")',
      "",
      "emoji (variable)  resolved",
      "emotion (variable)  resolved",
      "Emoticon (class)  resolved",
      "encodeURI (function)  resolved",
    ]);
    await fixture.close();
  });

  test("names the searched workspace root and warns that other roots exist for references", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    const searchedRoot = resolve(cwd, "packages/a");
    const sourcePath = resolve(searchedRoot, "source.ts");
    await mkdir(resolve(cwd, "packages/b"), { recursive: true });
    await mkdir(searchedRoot, { recursive: true });
    await writeFile(resolve(searchedRoot, "package.json"), "{}\n");
    await writeFile(resolve(cwd, "packages/b/package.json"), "{}\n");
    await writeFile(sourcePath, "export const helper = 1;\n");
    fixture.client.responseByMethod.set("textDocument/references", [
      {
        uri: pathToFileURL(sourcePath).href,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
      },
    ]);
    const manager = new LspServerManager<LspToolServerClient>({
      cwd,
      settings: resolvedSettings(["typescript"], ["package.json"]),
      startClient: async () => fixture.client,
    });

    const result = await executeTool(
      fixture,
      { operation: "find_references", file_path: sourcePath, line: 1, character: 14 },
      { ...fixture.dependencies, manager },
    );

    const warning = `typescript searched only ${join("packages", "a")}; 1 other typescript root exists (${join("packages", "b")}), so importers there may be missed. Query a file there or search for importers. ${TROUBLESHOOTING_WARNING_POINTER}`;
    expect(resultText(result)).toBe(
      [
        `Query position: ${join("packages", "a", "source.ts")}:1:14 ("helper")`,
        `Searched typescript workspace root: ${join("packages", "a")}`,
        `Warning: ${warning}`,
        "",
        `${join("packages", "a", "source.ts")}:1:14  export const helper = 1;`,
      ].join("\n"),
    );
    expect(result.structuredContent).toMatchObject({
      results: [{ root_path: searchedRoot, server_id: "typescript" }],
      warnings: [warning],
    });
    await manager.shutdown();
    await fixture.close();
  });

  test("names at most three other workspace roots and counts the rest on one line", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    const sourcePath = resolve(cwd, "packages/a/source.ts");
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await mkdir(resolve(cwd, "packages", name), { recursive: true });
      await writeFile(resolve(cwd, "packages", name, "package.json"), "{}\n");
    }
    await writeFile(sourcePath, "export const helper = 1;\n");
    fixture.client.responseByMethod.set("textDocument/references", []);
    fixture.client.responseByMethod.set("textDocument/rename", {
      changes: {
        [pathToFileURL(sourcePath).href]: [
          {
            range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
            newText: "renamed",
          },
        ],
      },
    });
    const manager = new LspServerManager<LspToolServerClient>({
      cwd,
      settings: resolvedSettings(["typescript"], ["package.json"]),
      startClient: async () => fixture.client,
    });
    const dependencies = { ...fixture.dependencies, manager };
    const position = { file_path: sourcePath, line: 1, character: 14 };

    const references = await executeTool(
      fixture,
      { operation: "find_references", ...position },
      dependencies,
    );
    const rename = await executeTool(
      fixture,
      { operation: "rename", ...position, new_name: "renamed" },
      dependencies,
    );

    const names = ["b", "c", "d"].map((name) => join("packages", name)).join(", ");
    const warning = `typescript searched only ${join("packages", "a")}; 5 other typescript roots exist (${names}, +2 more), so importers there may be missed. Query a file there or search for importers. ${TROUBLESHOOTING_WARNING_POINTER}`;
    expect(references.structuredContent).toMatchObject({ warnings: [warning] });
    expect(rename.structuredContent).toMatchObject({ warnings: [warning] });
    if (rename.details.kind !== "workspace_edit_preview") throw new Error("Expected a preview");
    expect(rename.details.summary).toContain(`Warning: ${warning}\n`);
    await manager.shutdown();
    await fixture.close();
  });

  test("states the walk cap, not an early stop, when more other roots exist than it reports", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    const sourcePath = resolve(cwd, "packages/a/source.ts");
    for (const name of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      await mkdir(resolve(cwd, "packages", name), { recursive: true });
      await writeFile(resolve(cwd, "packages", name, "package.json"), "{}\n");
    }
    await writeFile(sourcePath, "export const helper = 1;\n");
    fixture.client.responseByMethod.set("textDocument/references", []);
    const manager = new LspServerManager<LspToolServerClient>({
      cwd,
      settings: resolvedSettings(["typescript"], ["package.json"]),
      startClient: async () => fixture.client,
    });

    const result = await executeTool(
      fixture,
      { operation: "find_references", file_path: sourcePath, line: 1, character: 14 },
      { ...fixture.dependencies, manager },
    );

    // The walk stops after finding one more than the five it reports.
    const names = ["b", "c", "d"].map((name) => join("packages", name)).join(", ");
    expect(result.structuredContent).toMatchObject({
      warnings: [
        `typescript searched only ${join("packages", "a")}; at least 6 other typescript roots exist (${names}, +3 more), so importers there may be missed. Query a file there or search for importers. ${TROUBLESHOOTING_WARNING_POINTER}`,
      ],
    });
    await manager.shutdown();
    await fixture.close();
  });

  test("warns that other roots may exist when root discovery stops before checking every directory", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    await writeFile(resolve(cwd, "package.json"), "{}\n");
    // More directories than the lowered discovery limit, none holding a root marker.
    await Promise.all(
      ["wide/0", "wide/1", "wide/2", "wide/3"].map((directory) =>
        mkdir(resolve(cwd, directory), { recursive: true }),
      ),
    );
    const manager = new LspServerManager<LspToolServerClient>({
      cwd,
      settings: resolvedSettings(["typescript"], ["package.json"]),
      startClient: async () => fixture.client,
      rootDiscoveryDirectoryLimit: 3,
    });

    const result = await executeTool(
      fixture,
      { operation: "find_references", file_path: fixture.filePath, line: 1, character: 7 },
      { ...fixture.dependencies, manager },
    );

    expect(result.structuredContent).toMatchObject({
      warnings: [
        `typescript searched only ${cwd}; other typescript roots may exist in directories that were not checked (discovery stopped early), so importers there may be missed. Query a file there or search for importers. ${TROUBLESHOOTING_WARNING_POINTER}`,
      ],
    });
    await manager.shutdown();
    await fixture.close();
  });

  test("warns about workspace packages the Server Instance has not loaded until a file there is queried, when warm-up is off", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    await writeFile(resolve(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const packageNames = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (const name of packageNames) {
      await mkdir(resolve(cwd, "packages", name), { recursive: true });
      await writeFile(resolve(cwd, "packages", name, "package.json"), "{}\n");
      await writeFile(resolve(cwd, "packages", name, "index.ts"), "export const helper = 1;\n");
    }
    const sourcePath = resolve(cwd, "packages/a/index.ts");
    fixture.client.responseByMethod.set("textDocument/rename", {
      changes: {
        [pathToFileURL(sourcePath).href]: [
          {
            range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
            newText: "renamed",
          },
        ],
      },
    });
    const settings = resolvedSettings(["typescript"], ["package.json"]);
    const definition = settings.servers.get("typescript");
    if (definition === undefined) throw new Error("Expected the typescript definition");
    const manager = new LspServerManager<LspToolServerClient>({
      cwd,
      settings: {
        ...settings,
        servers: new Map([
          ["typescript", { ...definition, workspaceRootMarkers: ["pnpm-workspace.yaml"] }],
        ]),
      },
      startClient: async () => fixture.client,
    });
    const dependencies = { ...fixture.dependencies, manager, warmUp: NO_WARM_UP };
    const position = { file_path: sourcePath, line: 1, character: 14 };
    const references = () =>
      executeTool(fixture, { operation: "find_references", ...position }, dependencies);
    const unloadedWarning = (names: string) =>
      `typescript has not loaded ${names} under ${cwd}; references there may be missing. Run any LSP tool on a file in each missing package, then retry. ${TROUBLESHOOTING_WARNING_POINTER}`;
    const packagePaths = (names: readonly string[]) =>
      names.map((name) => join("packages", name)).join(", ");

    const first = await references();
    const firstWarning = unloadedWarning(`7 packages (${packagePaths(["b", "c", "d"])}, +4 more)`);
    expect(resultText(first)).toContain(
      `Searched typescript workspace root: ${cwd}\nWarning: ${firstWarning}`,
    );
    expect(first.structuredContent).toMatchObject({ warnings: [firstWarning] });
    const rename = await executeTool(
      fixture,
      { operation: "rename", ...position, new_name: "renamed" },
      dependencies,
    );
    expect(rename.structuredContent).toMatchObject({ warnings: [firstWarning] });
    if (rename.details.kind !== "workspace_edit_preview") throw new Error("Expected a preview");
    expect(rename.details.summary).toContain(`Warning: ${firstWarning}\n`);

    // Querying a file in a package loads it: that package is no longer named.
    await executeTool(
      fixture,
      {
        operation: "hover",
        file_path: resolve(cwd, "packages/b/index.ts"),
        line: 1,
        character: 14,
      },
      dependencies,
    );
    expect((await references()).structuredContent).toMatchObject({
      warnings: [unloadedWarning(`6 packages (${packagePaths(["c", "d", "e"])}, +3 more)`)],
    });
    for (const name of packageNames.slice(2)) {
      await executeTool(
        fixture,
        {
          operation: "hover",
          file_path: resolve(cwd, "packages", name, "index.ts"),
          line: 1,
          character: 14,
        },
        dependencies,
      );
    }
    const loaded = await references();
    expect(loaded.structuredContent).toMatchObject({ warnings: [] });
    expect(resultText(loaded)).not.toContain("Warning");
    await manager.shutdown();
    await fixture.close();
  });

  describe("workspace warm-up before references and rename", () => {
    /** A pnpm-style workspace of packages a..e by default, each with a `src/index.ts`, and one manager. */
    async function createWorkspace(packageNames: readonly string[] = ["a", "b", "c", "d", "e"]) {
      const fixture = await createToolFixture();
      const cwd = fixture.context.cwd;
      await writeFile(resolve(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      for (const name of packageNames) {
        await mkdir(resolve(cwd, "packages", name, "src"), { recursive: true });
        await writeFile(resolve(cwd, "packages", name, "package.json"), "{}\n");
        await writeFile(
          resolve(cwd, "packages", name, "src/index.ts"),
          "export const helper = 1;\n",
        );
      }
      const settings = resolvedSettings(["typescript"], ["package.json"]);
      const definition = settings.servers.get("typescript");
      if (definition === undefined) throw new Error("Expected the typescript definition");
      const manager = new LspServerManager<LspToolServerClient>({
        cwd,
        settings: {
          ...settings,
          servers: new Map([
            ["typescript", { ...definition, workspaceRootMarkers: ["pnpm-workspace.yaml"] }],
          ]),
        },
        startClient: async () => fixture.client,
      });
      const sourcePath = resolve(cwd, "packages/a/src/index.ts");
      const references = (warmUp: LspWarmUpLimits = LSP_WARM_UP_LIMITS) =>
        executeTool(
          fixture,
          { operation: "find_references", file_path: sourcePath, line: 1, character: 14 },
          { ...fixture.dependencies, manager, warmUp },
        );
      const close = async () => {
        await manager.shutdown();
        await fixture.close();
      };
      return { fixture, cwd, manager, sourcePath, references, close };
    }

    test("opens one file in each unloaded package before searching, so no package is warned about", async () => {
      const { fixture, cwd, references, close } = await createWorkspace();

      const result = await references();

      expect([...fixture.client.synchronizedPaths].sort()).toEqual(
        ["a", "b", "c", "d", "e"].map((name) => resolve(cwd, "packages", name, "src/index.ts")),
      );
      expect(result.structuredContent).toMatchObject({ warnings: [] });
      expect(resultText(result)).not.toContain("Warning");
      await close();
    });

    test("warms up before a rename too, and a second request opens nothing more", async () => {
      const { fixture, cwd, manager, sourcePath, close } = await createWorkspace(["a", "b", "c"]);
      fixture.client.responseByMethod.set("textDocument/rename", {
        changes: {
          [pathToFileURL(sourcePath).href]: [
            {
              range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
              newText: "renamed",
            },
          ],
        },
      });
      const dependencies = { ...fixture.dependencies, manager };
      const rename = await executeTool(
        fixture,
        { operation: "rename", file_path: sourcePath, line: 1, character: 14, new_name: "renamed" },
        dependencies,
      );

      expect(rename.structuredContent).toMatchObject({ warnings: [] });
      expect(fixture.client.synchronizedPaths).toEqual(
        new Set(["a", "b", "c"].map((name) => resolve(cwd, "packages", name, "src/index.ts"))),
      );
      const synchronized = [...fixture.client.synchronizedPaths];
      await executeTool(
        fixture,
        { operation: "find_references", file_path: sourcePath, line: 1, character: 14 },
        dependencies,
      );
      expect([...fixture.client.synchronizedPaths]).toEqual(synchronized);
      await close();
    });

    test("opens at most the capped number of packages and names the rest as still unloaded", async () => {
      const { cwd, fixture, references, close } = await createWorkspace([
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
      ]);

      const result = await references({ packageLimit: 3, timeoutMs: 10_000 });

      // The queried package `a` is loaded already; the cap covers three of the six others.
      expect(fixture.client.synchronizedPaths.size).toBe(1 + 3);
      expect(result.structuredContent).toMatchObject({
        warnings: [
          `typescript has not loaded 3 packages (${["e", "f", "g"].map((name) => join("packages", name)).join(", ")}) under ${cwd}; references there may be missing. Run any LSP tool on a file in each missing package, then retry. ${TROUBLESHOOTING_WARNING_POINTER}`,
        ],
      });
      await close();
    });

    test("opens nothing once its time budget is spent, and still searches", async () => {
      const { fixture, references, close } = await createWorkspace();
      fixture.client.responseByMethod.set("textDocument/references", [
        {
          uri: pathToFileURL(resolve(fixture.context.cwd, "packages/a/src/index.ts")).href,
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
        },
      ]);

      const result = await references({ packageLimit: 20, timeoutMs: 0 });

      expect([...fixture.client.synchronizedPaths]).toHaveLength(1);
      expect(resultText(result)).toContain("packages/a/src/index.ts:1:14");
      expect(result.structuredContent).toMatchObject({
        warnings: [expect.stringContaining("has not loaded 4 packages")],
      });
      await close();
    });

    test("skips a package whose files cannot be opened and warns about it", async () => {
      const { fixture, cwd, references, close } = await createWorkspace(["a", "b", "c"]);
      await rm(resolve(cwd, "packages/b/src"), { recursive: true });
      await writeFile(resolve(cwd, "packages/b/notes.md"), "# notes\n");

      const result = await references();

      expect(fixture.client.synchronizedPaths.has(resolve(cwd, "packages/c/src/index.ts"))).toBe(
        true,
      );
      expect(result.structuredContent).toMatchObject({
        warnings: [expect.stringContaining(`has not loaded 1 package (${join("packages", "b")})`)],
      });
      await close();
    });

    test("never fails the request when a warm-up file cannot be synchronized", async () => {
      const { fixture, references, close } = await createWorkspace(["a", "b"]);
      const synchronize = fixture.client.synchronizeDocument.bind(fixture.client);
      fixture.client.synchronizeDocument = async (filePath, languageId) => {
        if (filePath.includes("packages/b")) throw new Error("not valid UTF-8");
        return synchronize(filePath, languageId);
      };

      const result = await references();

      expect(resultText(result)).toContain("has not loaded 1 package");
      await close();
    });

    test("opens nothing for a request that is already cancelled", async () => {
      const { fixture, cwd, manager, sourcePath, close } = await createWorkspace();
      const controller = new AbortController();
      controller.abort();
      const tool = createLspToolDefinition("find_references", () => ({
        ...fixture.dependencies,
        manager,
      }));

      await tool.execute(
        "tool-call",
        { file_path: sourcePath, line: 1, character: 14 },
        controller.signal,
        undefined,
        fixture.context,
      );

      expect([...fixture.client.synchronizedPaths]).toEqual([
        resolve(cwd, "packages/a/src/index.ts"),
      ]);
      await close();
    });

    test("opens nothing outside a workspace root", async () => {
      const fixture = await createToolFixture();
      const cwd = fixture.context.cwd;
      await writeFile(resolve(cwd, "package.json"), "{}\n");
      await mkdir(resolve(cwd, "packages/b"), { recursive: true });
      await writeFile(resolve(cwd, "packages/b/package.json"), "{}\n");
      await writeFile(resolve(cwd, "packages/b/index.ts"), "export {};\n");
      const manager = new LspServerManager<LspToolServerClient>({
        cwd,
        settings: resolvedSettings(["typescript"], ["package.json"]),
        startClient: async () => fixture.client,
      });

      await executeTool(
        fixture,
        { operation: "find_references", file_path: fixture.filePath, line: 1, character: 7 },
        { ...fixture.dependencies, manager },
      );

      expect([...fixture.client.synchronizedPaths]).toEqual([fixture.filePath]);
      await manager.shutdown();
      await fixture.close();
    });

    test("picks a source file under src over declaration, test, and configuration files", async () => {
      const { fixture, cwd, references, close } = await createWorkspace(["a", "b"]);
      const packageB = resolve(cwd, "packages/b");
      await writeFile(resolve(packageB, "vitest.config.ts"), "export default {};\n");
      await writeFile(resolve(packageB, "src/index.d.ts"), "export {};\n");
      await writeFile(resolve(packageB, "src/index.test.ts"), "export {};\n");
      await rm(resolve(packageB, "src/index.ts"));
      await writeFile(resolve(packageB, "src/zeta.ts"), "export const zeta = 1;\n");
      await mkdir(resolve(packageB, "node_modules/dep"), { recursive: true });
      await writeFile(resolve(packageB, "node_modules/dep/index.ts"), "export {};\n");

      await references();

      expect(fixture.client.synchronizedPaths.has(resolve(packageB, "src/zeta.ts"))).toBe(true);
      expect(fixture.client.synchronizedPaths.size).toBe(2);
      await close();
    });
  });

  test("reports a workspace walk cut short with the unloaded packages, not as other roots", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    await writeFile(resolve(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    for (const name of ["a", "b"]) {
      await mkdir(resolve(cwd, "packages", name, "src"), { recursive: true });
      await writeFile(resolve(cwd, "packages", name, "package.json"), "{}\n");
    }
    const sourcePath = resolve(cwd, "packages/a/src/index.ts");
    await writeFile(sourcePath, "export const helper = 1;\n");
    const settings = resolvedSettings(["typescript"], ["package.json"]);
    const definition = settings.servers.get("typescript");
    if (definition === undefined) throw new Error("Expected the typescript definition");
    const warningsWithLimit = async (
      rootDiscoveryDirectoryLimit: number,
      rootMarkers: readonly string[] = definition.rootMarkers,
    ) => {
      const manager = new LspServerManager<LspToolServerClient>({
        cwd,
        settings: {
          ...settings,
          servers: new Map([
            [
              "typescript",
              { ...definition, rootMarkers, workspaceRootMarkers: ["pnpm-workspace.yaml"] },
            ],
          ]),
        },
        startClient: async () => fixture.client,
        rootDiscoveryDirectoryLimit,
      });
      const result = await executeTool(
        fixture,
        { operation: "find_references", file_path: sourcePath, line: 1, character: 14 },
        { ...fixture.dependencies, manager },
      );
      await manager.shutdown();
      return result.structuredContent;
    };

    // The fixture's cwd also holds its session directory, listed after `packages`. Three
    // directories leave every package unchecked; five reach packages/b but not the src directories.
    expect(await warningsWithLimit(3)).toMatchObject({
      warnings: [
        `typescript may not have loaded every package under ${cwd} (discovery stopped early); references in unloaded packages may be missing. Run any LSP tool on a file in each package you need, then retry. ${TROUBLESHOOTING_WARNING_POINTER}`,
      ],
    });
    expect(await warningsWithLimit(5)).toMatchObject({
      warnings: [
        `typescript has not loaded at least 1 package (${join("packages", "b")}; discovery stopped early) under ${cwd}; references there may be missing. Run any LSP tool on a file in the missing package, then retry. ${TROUBLESHOOTING_WARNING_POINTER}`,
      ],
    });
    // Without root markers there are no packages to name, even when the walk is cut short.
    expect(await warningsWithLimit(3, [])).toMatchObject({ warnings: [] });
    await fixture.close();
  });

  test("renders goto results by server when several servers answer", async () => {
    const fixture = await createToolFixture(["good", "empty", "failing"]);
    const good = new RecordingLspClient();
    const empty = new RecordingLspClient();
    const failing = new RecordingLspClient();
    good.responseByMethod.set("textDocument/definition", {
      uri: pathToFileURL(fixture.filePath).href,
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
    });
    empty.responseByMethod.set("textDocument/definition", null);
    failing.failureByMethod.set("textDocument/definition", new Error("expected failure"));
    const clients = new Map([
      ["good", good],
      ["empty", empty],
      ["failing", failing],
    ]);
    const manager = new LspServerManager<LspToolServerClient>({
      cwd: fixture.context.cwd,
      settings: resolvedSettings(["good", "empty", "failing"]),
      startClient: async ({ definition }) => clients.get(definition.id) ?? good,
    });
    const result = await executeTool(
      fixture,
      { operation: "goto_definition", file_path: fixture.filePath, line: 1, character: 7 },
      { ...fixture.dependencies, manager },
    );
    const [warning] = Value.Parse(LspReadOutputSchema, result.structuredContent).warnings;
    expect(resultText(result)).toBe(
      [
        'Query position: source.ts:1:7 ("emoji")',
        "",
        "good:",
        "  source.ts:1:7  const emoji = '😀';",
        "empty:",
        '  No locations found at source.ts:1:7 ("emoji").',
        "",
        `Warning: ${warning}`,
      ].join("\n"),
    );
    expect(warning).toContain("expected failure");
    await manager.shutdown();
    await fixture.close();
  });

  test("says plainly that a single server has no hover information at the position", async () => {
    const fixture = await createToolFixture();
    fixture.client.responderByMethod.set("textDocument/hover", () => null);

    const hover = await executeTool(fixture, {
      operation: "hover",
      file_path: fixture.filePath,
      line: 1,
      character: 9,
    });

    expect(resultText(hover)).toBe(
      'The server has no hover information at source.ts:1:9 ("emoji").',
    );
    expect(Value.Parse(LspPositionReadOutputSchema, hover.structuredContent)).toMatchObject({
      results: [{ server_id: "typescript", value: null }],
      warnings: [],
    });
    expect(hover.details).toMatchObject({ operation: "hover", result_count: 0 });
    await fixture.close();
  });

  test("sends overlapping current LSP Diagnostics so diagnostic-dependent quick fixes return", async () => {
    const fixture = await createToolFixture();
    await writeFile(fixture.filePath, "const value = missingName();\nconst other = 1;\n");
    const uri = pathToFileURL(fixture.filePath).href;
    const missingName: Diagnostic = {
      range: { start: { line: 0, character: 14 }, end: { line: 0, character: 25 } },
      severity: 1,
      code: 2304,
      source: "ts",
      message: "Cannot find name 'missingName'.",
    };
    const sameLineElsewhere: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 2,
      message: "Prefer let.",
    };
    const otherLine: Diagnostic = {
      range: { start: { line: 1, character: 6 }, end: { line: 1, character: 11 } },
      severity: 4,
      message: "'other' is declared but never used.",
    };
    fixture.client.currentDiagnostics = [sameLineElsewhere, missingName, otherLine];
    const QuickFixContextSchema = Type.Object({
      context: Type.Object({
        diagnostics: Type.Array(Type.Object({ code: Type.Literal(2304) }), { minItems: 1 }),
      }),
    });
    // Like a real server, offer the import quick fix only for the diagnostic it fixes.
    fixture.client.responderByMethod.set("textDocument/codeAction", (parameters) =>
      Value.Check(QuickFixContextSchema, parameters)
        ? [
            {
              title: 'Add import from "./helper"',
              kind: "quickfix",
              diagnostics: [missingName],
              edit: {
                changes: {
                  [uri]: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                      newText: 'import { missingName } from "./helper";\n',
                    },
                  ],
                },
              },
            },
          ]
        : [],
    );

    const actions = await executeTool(fixture, {
      operation: "code_actions",
      file_path: fixture.filePath,
      range: { start: { line: 1, character: 15 }, end: { line: 1, character: 26 } },
      only_kinds: ["quickfix"],
    });

    expect(fixture.client.parametersByMethod.get("textDocument/codeAction")).toEqual([
      {
        textDocument: { uri },
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 25 } },
        context: { diagnostics: [missingName], only: ["quickfix"] },
      },
    ]);
    expect(actions.structuredContent).toMatchObject({
      actions: [
        {
          applicable: true,
          title: 'Add import from "./helper"',
          kind: "quickfix",
          preview_id: expect.any(String),
        },
      ],
    });
    await fixture.close();
  });

  test("sends LSP Diagnostics that only touch a code-action range endpoint", async () => {
    const fixture = await createToolFixture();
    await writeFile(fixture.filePath, "const value = missingName();\n");
    const endsAtCursor: Diagnostic = {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      message: "ends at the cursor",
    };
    const startsAtCursor: Diagnostic = {
      range: { start: { line: 0, character: 11 }, end: { line: 0, character: 13 } },
      message: "starts at the cursor",
    };
    const beforeCursor: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: "before the cursor",
    };
    fixture.client.currentDiagnostics = [beforeCursor, endsAtCursor, startsAtCursor];

    await executeTool(fixture, {
      operation: "code_actions",
      file_path: fixture.filePath,
      range: { start: { line: 1, character: 12 }, end: { line: 1, character: 12 } },
    });

    expect(fixture.client.parametersByMethod.get("textDocument/codeAction")).toMatchObject([
      { context: { diagnostics: [endsAtCursor, startsAtCursor] } },
    ]);
    await fixture.close();
  });

  describe("only_kinds", () => {
    const insertion = (uri: string) => ({
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "// edit\n",
          },
        ],
      },
    });
    const unfilteredActions = (uri: string) => [
      { title: "exact", kind: "quickfix", edit: insertion(uri) },
      { title: "sub-kind", kind: "quickfix.import", edit: insertion(uri) },
      { title: "not a boundary", kind: "quickfixes", edit: insertion(uri) },
      { title: "other kind", kind: "refactor.extract", edit: insertion(uri) },
      { title: "no kind", edit: insertion(uri) },
      { title: "plain command", command: { title: "Run", command: "run" } },
      {
        title: "command with kind",
        kind: "quickfix",
        command: { title: "Run", command: "run" },
      },
    ];

    test("keeps only actions matching a requested kind or its sub-kinds", async () => {
      const fixture = await createToolFixture();
      const uri = pathToFileURL(fixture.filePath).href;
      // The server ignores context.only and returns every action.
      fixture.client.responseByMethod.set("textDocument/codeAction", unfilteredActions(uri));
      const createPreview = vi.spyOn(fixture.dependencies.workspaceEdits, "createPreview");

      const result = await executeTool(fixture, {
        operation: "code_actions",
        file_path: fixture.filePath,
        range: range(),
        only_kinds: ["quickfix", "refactor"],
      });

      expect(fixture.client.parametersByMethod.get("textDocument/codeAction")).toMatchObject([
        { context: { only: ["quickfix", "refactor"] } },
      ]);
      expect(result.structuredContent).toMatchObject({
        actions: [
          { title: "exact", kind: "quickfix", applicable: true },
          { title: "sub-kind", kind: "quickfix.import", applicable: true },
          { title: "other kind", kind: "refactor.extract", applicable: true },
          { title: "command with kind", kind: "quickfix", applicable: false },
        ],
      });
      // Filtered actions leave no preview behind.
      expect(result.details).toMatchObject({ preview_records: [{}, {}, {}] });
      expect(createPreview).toHaveBeenCalledTimes(3);
      await fixture.close();
    });

    test("never resolves actions that only_kinds drops", async () => {
      const fixture = await createToolFixture();
      const uri = pathToFileURL(fixture.filePath).href;
      fixture.client.capabilities.codeActionProvider = { resolveProvider: true };
      fixture.client.responseByMethod.set("textDocument/codeAction", [
        { title: "keep", kind: "quickfix", data: "keep" },
        { title: "drop", kind: "refactor", data: "drop" },
        { title: "no kind", data: "no-kind" },
      ]);
      fixture.client.responderByMethod.set("codeAction/resolve", (parameters) => {
        const { data } = Value.Parse(Type.Object({ data: Type.String() }), parameters);
        if (data !== "keep") throw new Error(`unexpected resolve of ${data}`);
        return { title: "keep", kind: "quickfix", edit: insertion(uri) };
      });

      const result = await executeTool(fixture, {
        operation: "code_actions",
        file_path: fixture.filePath,
        range: range(),
        only_kinds: ["quickfix"],
      });

      expect(fixture.client.requests.filter((method) => method === "codeAction/resolve")).toEqual([
        "codeAction/resolve",
      ]);
      expect(result.structuredContent).toMatchObject({
        actions: [{ title: "keep", applicable: true }],
        warnings: [],
      });
      await fixture.close();
    });
  });

  test("lists code actions from every capable server, each naming its server", async () => {
    const fixture = await createToolFixture(["typescript", "oxlint", "incapable", "failing"]);
    const uri = pathToFileURL(fixture.filePath).href;
    const typescript = new RecordingLspClient();
    const oxlint = new RecordingLspClient();
    const failing = new RecordingLspClient();
    // A server without code actions is skipped, not reported, when server_id is omitted.
    const incapable = new (class extends RecordingLspClient {
      override hasCapability(method: string): boolean {
        return method !== "textDocument/codeAction";
      }
    })();
    typescript.responseByMethod.set("textDocument/codeAction", [
      { title: "Organize imports", kind: "source.organizeImports", command: "organize" },
    ]);
    oxlint.responseByMethod.set("textDocument/codeAction", [
      {
        title: "Disable rule for this line",
        kind: "quickfix",
        edit: {
          changes: {
            [uri]: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: "// oxlint-disable-next-line\n",
              },
            ],
          },
        },
      },
    ]);
    failing.failureByMethod.set("textDocument/codeAction", new Error("expected failure"));
    const clients = new Map([
      ["typescript", typescript],
      ["oxlint", oxlint],
      ["incapable", incapable],
      ["failing", failing],
    ]);
    const manager = new LspServerManager<LspToolServerClient>({
      cwd: fixture.context.cwd,
      settings: resolvedSettings(["typescript", "oxlint", "incapable", "failing"]),
      startClient: async ({ definition }) => clients.get(definition.id) ?? typescript,
    });
    const dependencies = { ...fixture.dependencies, manager };

    const all = await executeTool(
      fixture,
      { operation: "code_actions", file_path: fixture.filePath, range: range() },
      dependencies,
    );
    expect(all.structuredContent).toMatchObject({
      actions: [
        { server_id: "typescript", applicable: false, title: "Organize imports" },
        {
          server_id: "oxlint",
          applicable: true,
          title: "Disable rule for this line",
          preview_id: expect.any(String),
          mutation_manifest: [{ operation: "modify", path: fixture.filePath }],
        },
      ],
      warnings: [expect.stringContaining("expected failure")],
    });
    expect(all.details).toMatchObject({
      server_outcomes: [
        { server_id: "typescript", outcome: "success" },
        { server_id: "oxlint", outcome: "success" },
        { server_id: "failing", outcome: "error" },
      ],
      preview_records: [expect.objectContaining({ server_id: "oxlint" })],
    });

    const restricted = await executeTool(
      fixture,
      {
        operation: "code_actions",
        file_path: fixture.filePath,
        range: range(),
        server_id: "typescript",
      },
      dependencies,
    );
    expect(restricted.structuredContent).toMatchObject({
      actions: [{ server_id: "typescript", title: "Organize imports" }],
      warnings: [],
    });
    expect(oxlint.requests.filter((method) => method === "textDocument/codeAction")).toHaveLength(
      1,
    );
    await manager.shutdown();
    await fixture.close();
  });

  describe("code actions with an invalid Workspace Edit", () => {
    const insertion = (uri: string) => ({
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "// edit\n",
          },
        ],
      },
    });

    test("lists the invalid action as not applicable and keeps the others", async () => {
      const fixture = await createToolFixture(["typescript", "oxlint"]);
      const uri = pathToFileURL(fixture.filePath).href;
      const missingUri = pathToFileURL(join(fixture.context.cwd, "missing.ts")).href;
      const typescript = new RecordingLspClient();
      const oxlint = new RecordingLspClient();
      typescript.responseByMethod.set("textDocument/codeAction", [
        { title: "First fix", kind: "quickfix", edit: insertion(uri) },
        { title: "Fix elsewhere", kind: "quickfix", edit: insertion(missingUri) },
        { title: "Last fix", kind: "quickfix.import", edit: insertion(uri) },
      ]);
      oxlint.responseByMethod.set("textDocument/codeAction", [
        { title: "Lint fix", kind: "quickfix", edit: insertion(uri) },
      ]);
      const clients = new Map([
        ["typescript", typescript],
        ["oxlint", oxlint],
      ]);
      const manager = new LspServerManager<LspToolServerClient>({
        cwd: fixture.context.cwd,
        settings: resolvedSettings(["typescript", "oxlint"]),
        startClient: async ({ definition }) => clients.get(definition.id) ?? typescript,
      });
      const dependencies = { ...fixture.dependencies, manager };
      const createPreview = vi.spyOn(dependencies.workspaceEdits, "createPreview");

      const result = await executeTool(
        fixture,
        { operation: "code_actions", file_path: fixture.filePath, range: range() },
        dependencies,
      );

      expect(result.structuredContent).toMatchObject({
        actions: [
          { server_id: "typescript", title: "First fix", applicable: true },
          {
            server_id: "typescript",
            title: "Fix elsewhere",
            kind: "quickfix",
            applicable: false,
            error: expect.stringContaining("text edit file is missing"),
          },
          { server_id: "typescript", title: "Last fix", applicable: true },
          { server_id: "oxlint", title: "Lint fix", applicable: true },
        ],
        warnings: [],
      });
      const { actions } = Value.Parse(LspCodeActionsOutputSchema, result.structuredContent);
      expect(actions[1]).not.toHaveProperty("preview_id");
      expect(result.details).toMatchObject({
        server_outcomes: [
          { server_id: "typescript", outcome: "success" },
          { server_id: "oxlint", outcome: "success" },
        ],
      });
      // Every preview in the store is named by a returned action.
      const settled = await Promise.allSettled(
        createPreview.mock.results.map((entry) => entry.value),
      );
      const created = settled.flatMap((entry) =>
        entry.status === "fulfilled" ? entry.value.preview_id : [],
      );
      const named = actions.flatMap((action) => action.preview_id ?? []);
      expect(named).toHaveLength(3);
      expect(created.toSorted(byText)).toEqual(named.toSorted(byText));
      // Previews of the valid actions survive the invalid one.
      for (const id of named) {
        expect(() => dependencies.workspaceEdits.prepareMutationManifest(id)).not.toThrow();
      }
      await manager.shutdown();
      await fixture.close();
    });
  });

  describe("previews that no result names", () => {
    const insertion = (uri: string) => ({
      changes: {
        [uri]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "// edit\n",
          },
        ],
      },
    });

    /** The IDs of every preview the store created while the spy was installed. */
    async function createdPreviewIds(
      createPreview: MockInstance<LspWorkspaceEditStore["createPreview"]>,
    ): Promise<string[]> {
      const settled = await Promise.allSettled(
        createPreview.mock.results.flatMap((entry) =>
          entry.type === "return" ? [entry.value] : [],
        ),
      );
      return settled.flatMap((entry) =>
        entry.status === "fulfilled" ? [entry.value.preview_id] : [],
      );
    }

    function expectDiscarded(store: LspWorkspaceEditStore, ids: readonly string[]): void {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(() => store.prepareMutationManifest(id)).toThrow();
    }

    /** A client whose copy of the document has one line, so line 2 is past the end of it. */
    function singleLineDocumentClient(delayMs = 0): RecordingLspClient {
      return new (class extends RecordingLspClient {
        override async synchronizeDocument(
          filePath: string,
          languageId: string,
        ): Promise<LspSynchronizedDocument> {
          const document = await super.synchronizeDocument(filePath, languageId);
          await new Promise((done) => setTimeout(done, delayMs));
          return { ...document, text: "x" };
        }
      })();
    }

    test("discards a server's previews when another server then raises an input error", async () => {
      const fixture = await createToolFixture(["typescript", "oxlint"]);
      const uri = pathToFileURL(fixture.filePath).href;
      const typescript = new RecordingLspClient();
      typescript.responseByMethod.set("textDocument/codeAction", [
        { title: "First fix", kind: "quickfix", edit: insertion(uri) },
        { title: "Second fix", kind: "quickfix", edit: insertion(uri) },
      ]);
      // Rejects only after typescript has answered and created its previews.
      const oxlint = singleLineDocumentClient(30);
      const clients = new Map([
        ["typescript", typescript],
        ["oxlint", oxlint],
      ]);
      const manager = new LspServerManager<LspToolServerClient>({
        cwd: fixture.context.cwd,
        settings: resolvedSettings(["typescript", "oxlint"]),
        startClient: async ({ definition }) => clients.get(definition.id) ?? typescript,
      });
      const dependencies = { ...fixture.dependencies, manager };
      const createPreview = vi.spyOn(dependencies.workspaceEdits, "createPreview");

      const failure = await executeTool(
        fixture,
        {
          operation: "code_actions",
          file_path: fixture.filePath,
          range: { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } },
        },
        dependencies,
      ).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(LspInputError);
      const created = await createdPreviewIds(createPreview);
      expect(created).toHaveLength(2);
      expectDiscarded(dependencies.workspaceEdits, created);
      await manager.shutdown();
      await fixture.close();
    });

    test("discards the previews of a failed server and keeps those the result names", async () => {
      const fixture = await createToolFixture(["typescript", "oxlint"]);
      const uri = pathToFileURL(fixture.filePath).href;
      const typescript = new RecordingLspClient();
      typescript.responseByMethod.set("textDocument/codeAction", [
        { title: "Good fix", kind: "quickfix", edit: insertion(uri) },
      ]);
      const oxlint = new RecordingLspClient();
      oxlint.responseByMethod.set("textDocument/codeAction", [
        { title: "First fix", kind: "quickfix", edit: insertion(uri) },
        { title: "Second fix", kind: "quickfix", edit: insertion(uri) },
      ]);
      const clients = new Map([
        ["typescript", typescript],
        ["oxlint", oxlint],
      ]);
      const manager = new LspServerManager<LspToolServerClient>({
        cwd: fixture.context.cwd,
        settings: resolvedSettings(["typescript", "oxlint"]),
        startClient: async ({ definition }) => clients.get(definition.id) ?? typescript,
      });
      const dependencies = { ...fixture.dependencies, manager };
      const store = dependencies.workspaceEdits;
      const realCreatePreview = store.createPreview.bind(store);
      const createPreview = vi.spyOn(store, "createPreview");
      // oxlint's listing fails after its first preview; typescript's is unaffected.
      let oxlintPreviews = 0;
      createPreview.mockImplementation(async (input) => {
        if (input.serverId === "oxlint" && ++oxlintPreviews === 2) {
          throw new Error("expected store failure");
        }
        return realCreatePreview(input);
      });

      const result = await executeTool(
        fixture,
        { operation: "code_actions", file_path: fixture.filePath, range: range() },
        dependencies,
      );

      const { actions } = Value.Parse(LspCodeActionsOutputSchema, result.structuredContent);
      const named = actions.flatMap((action) => action.preview_id ?? []);
      expect(named).toHaveLength(1);
      const created = await createdPreviewIds(createPreview);
      expect(created).toHaveLength(2);
      expect(() => store.prepareMutationManifest(named[0] ?? "")).not.toThrow();
      expectDiscarded(
        store,
        created.filter((id) => !named.includes(id)),
      );
      await manager.shutdown();
      await fixture.close();
    });

    test("discards code action previews when the Result Spill cannot be written", async () => {
      const fixture = await createToolFixture();
      const uri = pathToFileURL(fixture.filePath).href;
      fixture.client.responseByMethod.set(
        "textDocument/codeAction",
        Array.from({ length: 3 }, (_unused, index) => ({
          title: `Fix ${index} ${"x".repeat(40 * 1024)}`,
          kind: "quickfix",
          edit: insertion(uri),
        })),
      );
      const sessionFiles: LspSessionFiles = {
        ...fixture.sessionFiles,
        writeResultSpill: async () => {
          throw new Error("disk full");
        },
      };
      const dependencies = { ...fixture.dependencies, sessionFiles };
      const createPreview = vi.spyOn(dependencies.workspaceEdits, "createPreview");

      await expect(
        executeTool(
          fixture,
          { operation: "code_actions", file_path: fixture.filePath, range: range() },
          dependencies,
        ),
      ).rejects.toThrow("disk full");

      const created = await createdPreviewIds(createPreview);
      expect(created).toHaveLength(3);
      expectDiscarded(dependencies.workspaceEdits, created);
      await fixture.close();
    });

    test("discards the rename preview when its Result Spill cannot be written", async () => {
      const fixture = await createToolFixture();
      const uri = pathToFileURL(fixture.filePath).href;
      // The preview summary is a patch of 3,000 added lines, beyond the model-visible limit.
      const textEdit = {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "added\n".repeat(3000),
      };
      fixture.client.responseByMethod.set("textDocument/rename", {
        changes: { [uri]: [textEdit] },
      });
      const sessionFiles: LspSessionFiles = {
        ...fixture.sessionFiles,
        writeResultSpill: async () => {
          throw new Error("disk full");
        },
      };
      const dependencies = { ...fixture.dependencies, sessionFiles };
      const createPreview = vi.spyOn(dependencies.workspaceEdits, "createPreview");

      await expect(
        executeTool(
          fixture,
          {
            operation: "rename",
            file_path: fixture.filePath,
            line: 1,
            character: 1,
            new_name: "renamed",
          },
          dependencies,
        ),
      ).rejects.toThrow("disk full");

      expectDiscarded(dependencies.workspaceEdits, await createdPreviewIds(createPreview));
      await fixture.close();
    });

    test("holds a server-initiated preview for the next result when a preview call fails", async () => {
      const fixture = await createToolFixture();
      const uri = pathToFileURL(fixture.filePath).href;
      const held = await fixture.dependencies.workspaceEdits.createPreview({
        edit: insertion(uri),
        serverId: "typescript",
      });
      const sessionFiles: LspSessionFiles = {
        ...fixture.sessionFiles,
        writeResultSpill: async () => {
          throw new Error("disk full");
        },
      };
      // A 3,000-line summary makes the failing call's output exceed the model-visible limit.
      fixture.client.responseByMethod.set("textDocument/rename", {
        changes: {
          [uri]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "added\n".repeat(3000),
            },
          ],
        },
      });

      await expect(
        executeTool(
          fixture,
          {
            operation: "rename",
            file_path: fixture.filePath,
            line: 1,
            character: 1,
            new_name: "renamed",
          },
          { ...fixture.dependencies, sessionFiles },
        ),
      ).rejects.toThrow("disk full");

      const next = await executeTool(fixture, { operation: "status" });
      expect(next.structuredContent).toMatchObject({ server_preview_ids: [held.preview_id] });
      expect(() =>
        fixture.dependencies.workspaceEdits.prepareMutationManifest(held.preview_id),
      ).not.toThrow();
      await fixture.close();
    });

    test("keeps and applies one call's preview when a concurrent call fails", async () => {
      const fixture = await createToolFixture();
      const otherPath = join(fixture.context.cwd, "other.ts");
      await writeFile(otherPath, "const other = 1;\n");
      const failingUri = pathToFileURL(fixture.filePath).href;
      const keptUri = pathToFileURL(otherPath).href;
      const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
      // The failing call is listed first and fails before the other call creates its preview.
      fixture.client.responderByMethod.set("textDocument/codeAction", async (parameters) => {
        const requested = JSON.stringify(parameters).includes("source.ts") ? failingUri : keptUri;
        if (requested === failingUri) {
          return [
            { title: "First fix", kind: "quickfix", edit: insertion(failingUri) },
            { title: "Second fix", kind: "quickfix", edit: insertion(failingUri) },
          ];
        }
        await delay(30);
        return [{ title: "Kept fix", kind: "quickfix", edit: insertion(keptUri) }];
      });
      const store = fixture.dependencies.workspaceEdits;
      const realCreatePreview = store.createPreview.bind(store);
      const createPreview = vi.spyOn(store, "createPreview");
      let failingPreviews = 0;
      createPreview.mockImplementation(async (input) => {
        const preview = await realCreatePreview(input);
        if (JSON.stringify(input.edit).includes("source.ts") && ++failingPreviews === 2) {
          throw new Error("expected store failure");
        }
        return preview;
      });

      const [failed, kept] = await Promise.allSettled([
        executeTool(fixture, {
          operation: "code_actions",
          file_path: fixture.filePath,
          range: range(),
        }),
        executeTool(fixture, {
          operation: "code_actions",
          file_path: otherPath,
          range: range(),
        }),
      ]);

      expect(failed.status).toBe("rejected");
      if (kept.status !== "fulfilled") throw new Error("Expected the concurrent call to succeed");
      const { actions } = Value.Parse(LspCodeActionsOutputSchema, kept.value.structuredContent);
      const previewId = actions[0]?.preview_id;
      if (previewId === undefined) throw new Error("Expected a preview");
      const applied = await executeTool(fixture, {
        operation: "apply",
        ...prepareApply(fixture, { preview_id: previewId }),
      });
      expect(applied.details).toMatchObject({ kind: "workspace_edit_apply", state: "applied" });
      expect(await readFile(otherPath, "utf8")).toBe("// edit\nconst other = 1;\n");
      await fixture.close();
    });
  });

  test("gets workspace diagnostics from every matching server unless server_id narrows them", async () => {
    const fixture = await createToolFixture(["typescript", "oxlint", "failing"]);
    const typescript = new RecordingLspClient();
    const oxlint = new RecordingLspClient();
    const failing = new RecordingLspClient();
    failing.workspaceDiagnosticsFailure = new Error("expected failure");
    typescript.workspaceDiagnosticsResult = { status: "unsupported" };
    oxlint.workspaceDiagnosticsResult = {
      status: "fresh",
      source: "workspace_pull",
      diagnosticsByUri: new Map([
        [
          pathToFileURL(fixture.filePath).href,
          [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              message: "lint",
            },
          ],
        ],
      ]),
    };
    const clients = new Map<string, RecordingLspClient>([
      ["typescript", typescript],
      ["oxlint", oxlint],
      ["failing", failing],
    ]);
    const manager = new LspServerManager<LspToolServerClient>({
      cwd: fixture.context.cwd,
      settings: resolvedSettings(["typescript", "oxlint", "failing"]),
      startClient: async ({ definition }) => clients.get(definition.id) ?? typescript,
    });
    const dependencies = { ...fixture.dependencies, manager };

    const all = await executeTool(
      fixture,
      { operation: "workspace_diagnostics", file_path: fixture.filePath },
      dependencies,
    );
    expect(all.isError).not.toBe(true);
    expect(Value.Parse(LspReadOutputSchema, all.structuredContent)).toMatchObject({
      results: [
        { server_id: "typescript", value: { status: "unsupported" } },
        { server_id: "oxlint", value: { status: "fresh", source: "workspace_pull" } },
      ],
      warnings: [expect.stringContaining("expected failure")],
    });
    expect(resultText(all)).toBe(
      [
        "typescript:",
        "  Server typescript publishes no workspace diagnostics; it reports diagnostics only for a requested file. Use lsp_diagnostics for each file.",
        "oxlint:",
        "  source.ts:1:1-2: lint",
        "",
        "Warning: Pi LSP: server failing request failed: expected failure",
      ].join("\n"),
    );

    const narrowed = await executeTool(
      fixture,
      { operation: "workspace_diagnostics", file_path: fixture.filePath, server_id: "oxlint" },
      dependencies,
    );
    expect(Value.Parse(LspReadOutputSchema, narrowed.structuredContent)).toMatchObject({
      results: [{ server_id: "oxlint" }],
      warnings: [],
    });
    await manager.shutdown();
    await fixture.close();
  });

  test("counts every file a push cache covers, including files without diagnostics", async () => {
    const fixture = await createToolFixture();
    const diagnostic: Diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "problem",
    };
    fixture.client.workspaceDiagnosticsResult = {
      status: "fresh",
      source: "push_cache",
      diagnosticsByUri: new Map([
        [pathToFileURL(fixture.filePath).href, [diagnostic]],
        [pathToFileURL(`${fixture.filePath}.clean.ts`).href, []],
      ]),
    };

    const result = await executeTool(fixture, {
      operation: "workspace_diagnostics",
      server_id: "typescript",
      file_path: fixture.filePath,
    });

    const [answer] = Value.Parse(LspReadOutputSchema, result.structuredContent).results;
    expect(answer?.value).toMatchObject({
      source: "push_cache",
      message: expect.stringContaining("pushed for 2 files opened in this session"),
    });
    expect(resultText(result)).toBe(
      [
        "Server typescript publishes no workspace diagnostics; these are the diagnostics it pushed for 2 files opened in this session. Use lsp_diagnostics for other files.",
        "source.ts:1:1-2: problem",
        "1 file: no diagnostics",
      ].join("\n"),
    );
    await fixture.close();
  });

  test("reports workspace diagnostics under plain paths", async () => {
    const fixture = await createToolFixture();
    const diagnostic: Diagnostic = {
      range: { start: { line: 0, character: 15 }, end: { line: 0, character: 17 } },
      message: "emoji",
    };
    fixture.client.workspaceDiagnosticsResult = {
      status: "fresh",
      source: "workspace_pull",
      diagnosticsByUri: new Map([[pathToFileURL(fixture.filePath).href, [diagnostic]]]),
    };

    const result = await executeTool(fixture, {
      operation: "workspace_diagnostics",
      server_id: "typescript",
      file_path: fixture.filePath,
    });

    const [answer] = Value.Parse(LspReadOutputSchema, result.structuredContent).results;
    expect(answer?.value).toEqual({
      status: "fresh",
      source: "workspace_pull",
      diagnosticsByUri: [
        {
          uri: fixture.filePath,
          value: [
            {
              message: "emoji",
              range: { start: { line: 1, character: 16 }, end: { line: 1, character: 17 } },
            },
          ],
        },
      ],
    });
    expect(resultText(result)).toBe("source.ts:1:16-17: emoji");
    await fixture.close();
  });

  test("still requests code actions when current LSP Diagnostics are unavailable", async () => {
    const fixture = await createToolFixture();
    fixture.client.currentDiagnosticsFailure = new Error("diagnostics pull failed");
    fixture.client.responseByMethod.set("textDocument/codeAction", [
      { title: "Organize imports", kind: "source.organizeImports", command: "organize" },
    ]);

    const actions = await executeTool(fixture, {
      operation: "code_actions",
      file_path: fixture.filePath,
      range: range(),
    });

    expect(fixture.client.parametersByMethod.get("textDocument/codeAction")).toMatchObject([
      { context: { diagnostics: [] } },
    ]);
    expect(actions.structuredContent).toMatchObject({
      actions: [{ applicable: false, title: "Organize imports" }],
    });
    await fixture.close();
  });

  test("reports a request timeout by its failure code and keeps the troubleshooting hint", async () => {
    const fixture = await createToolFixture(["good", "slow", "wordy"]);
    const good = new RecordingLspClient();
    const slow = new RecordingLspClient();
    const wordy = new RecordingLspClient();
    slow.failureByMethod.set(
      "textDocument/hover",
      new LspServerClientError("timeout", "slow", "/tmp/slow.stderr", "hover expired"),
    );
    wordy.failureByMethod.set("textDocument/hover", new Error("indexing timed out upstream"));
    const clients = new Map([
      ["good", good],
      ["slow", slow],
      ["wordy", wordy],
    ]);
    const manager = new LspServerManager<LspToolServerClient>({
      cwd: fixture.context.cwd,
      settings: resolvedSettings(["good", "slow", "wordy"]),
      startClient: async ({ definition }) => clients.get(definition.id) ?? good,
    });
    const dependencies = { ...fixture.dependencies, manager };
    const call = {
      operation: "hover",
      file_path: fixture.filePath,
      line: 1,
      character: 1,
    } satisfies LspToolParameters;

    const result = await executeTool(fixture, call, dependencies);
    expect(result.details).toMatchObject({
      server_outcomes: [
        { server_id: "good", outcome: "success" },
        { server_id: "slow", outcome: "timeout" },
        { server_id: "wordy", outcome: "error" },
      ],
    });

    const timedOut = await executeTool(fixture, { ...call, server_id: "slow" }, dependencies).catch(
      (cause: unknown) => cause,
    );
    expect(String(timedOut)).toContain("server slow request failed: Pi LSP: hover expired");
    expect(String(timedOut)).toContain(TROUBLESHOOTING_HINT);
    await manager.shutdown();
    await fixture.close();
  });

  test("converts incoming-call ranges against each caller file's Unicode text", async () => {
    const fixture = await createToolFixture();
    const longCallerPath = resolve(fixture.context.cwd, "long-caller.ts");
    const unicodeCallerPath = resolve(fixture.context.cwd, "unicode-caller.ts");
    await writeFile(longCallerPath, "export function aLongCallerName() { callee(); }\n");
    await writeFile(unicodeCallerPath, "const 😀 = callee();\n");
    const callHierarchyItem = (uri: string, line: number, character: number) => ({
      name: "caller",
      kind: 12,
      uri,
      range: { start: { line, character }, end: { line, character } },
      selectionRange: { start: { line, character }, end: { line, character } },
    });
    const range = (line: number, start: number, end: number) => ({
      start: { line, character: start },
      end: { line, character: end },
    });
    fixture.client.responseByMethod.set("textDocument/prepareCallHierarchy", [
      callHierarchyItem(pathToFileURL(fixture.filePath).href, 0, 0),
    ]);
    fixture.client.responseByMethod.set("callHierarchy/incomingCalls", [
      {
        from: callHierarchyItem(pathToFileURL(longCallerPath).href, 0, 16),
        fromRanges: [range(0, 36, 42)],
      },
      {
        from: callHierarchyItem(pathToFileURL(unicodeCallerPath).href, 0, 0),
        fromRanges: [range(0, 11, 17)],
      },
      {
        from: callHierarchyItem(pathToFileURL(fixture.filePath).href, 0, 0),
        fromRanges: [range(0, 17, 18)],
      },
    ]);

    const result = await executeTool(fixture, {
      operation: "incoming_calls",
      file_path: fixture.filePath,
      line: 1,
      character: 1,
    });
    expect(resultText(result)).toBe(
      [
        'Query position: source.ts:1:1 ("const")',
        "",
        "caller (function) long-caller.ts:1:17",
        "  long-caller.ts:1:37  export function aLongCallerName() { callee(); }",
        "caller (function) unicode-caller.ts:1:1",
        "  unicode-caller.ts:1:11  const 😀 = callee();",
        "caller (function) source.ts:1:1",
        "  source.ts:1:17  const emoji = '😀';",
      ].join("\n"),
    );
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          value: [
            {
              from: { uri: longCallerPath, selectionRange: range(1, 17, 17) },
              fromRanges: [range(1, 37, 43)],
            },
            { from: { uri: unicodeCallerPath }, fromRanges: [range(1, 11, 17)] },
            { from: { uri: fixture.filePath }, fromRanges: [range(1, 17, 18)] },
          ],
        },
      ],
    });
    await fixture.close();
  });

  test("converts each prepared item's outgoing call sites against that item's own file", async () => {
    const fixture = await createToolFixture();
    const helperPath = resolve(fixture.context.cwd, "helper.ts");
    const runPath = resolve(fixture.context.cwd, "run.ts");
    await writeFile(helperPath, "function helper() { const 😀 = run(); }\n");
    await writeFile(runPath, "export function run() {}\n");
    const position = (line: number, character: number) => ({ line, character });
    const item = (name: string, uri: string, character: number) => ({
      name,
      kind: 12,
      uri,
      range: { start: position(0, 0), end: position(0, character) },
      selectionRange: { start: position(0, character), end: position(0, character) },
    });
    const helperUri = pathToFileURL(helperPath).href;
    const sourceUri = pathToFileURL(fixture.filePath).href;
    const runItem = item("run", pathToFileURL(runPath).href, 16);
    fixture.client.responseByMethod.set("textDocument/prepareCallHierarchy", [
      item("helper", helperUri, 9),
      item("emoji", sourceUri, 6),
    ]);
    // Each prepared item's call sites lie in that item's file: helper.ts, then the queried source.ts.
    fixture.client.responderByMethod.set("callHierarchy/outgoingCalls", (parameters) => {
      const preparedUri = Value.Check(
        Type.Object({ item: Type.Object({ uri: Type.String() }) }),
        parameters,
      )
        ? parameters.item.uri
        : undefined;
      const site =
        preparedUri === helperUri
          ? { start: position(0, 31), end: position(0, 34) }
          : { start: position(0, 14), end: position(0, 18) };
      return [{ to: runItem, fromRanges: [site] }];
    });

    const result = await executeTool(fixture, {
      operation: "outgoing_calls",
      file_path: fixture.filePath,
      line: 1,
      character: 7,
    });

    expect(resultText(result)).toBe(
      [
        'Query position: source.ts:1:7 ("emoji")',
        "",
        "run (function) run.ts:1:17",
        "  helper.ts:1:31  function helper() { const 😀 = run(); }",
        "run (function) run.ts:1:17",
        "  source.ts:1:15  const emoji = '😀';",
      ].join("\n"),
    );
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          value: [
            {
              fromRanges: [{ start: { line: 1, character: 31 }, end: { line: 1, character: 34 } }],
            },
            {
              fromRanges: [{ start: { line: 1, character: 15 }, end: { line: 1, character: 18 } }],
            },
          ],
        },
      ],
    });
    await fixture.close();
  });

  describe("positions whose file text is unavailable", () => {
    const position = (line: number, character: number) => ({ line, character });
    const span = (line: number, start: number, end: number) => ({
      start: position(line, start),
      end: position(line, end),
    });
    const approximation = (files: string) =>
      `typescript: positions in ${files} are approximate because their text could not be read; lines are exact, but columns may be off after non-ASCII text.`;

    test("approximates location and LocationLink positions instead of converting them against the queried file", async () => {
      const fixture = await createToolFixture();
      const binaryPath = resolve(fixture.context.cwd, "binary.ts");
      await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0x0a]));
      const classUri = "jdt://contents/rt.jar/java.lang/String.class";
      const denoUri = "deno:/https/deno.land/x/mod.ts";
      fixture.client.responseByMethod.set("textDocument/definition", [
        // Past the end of the queried file's lines, which converting against it rejected.
        { uri: classUri, range: span(120, 40, 46) },
        { uri: pathToFileURL(binaryPath).href, range: span(0, 30, 31) },
        {
          originSelectionRange: span(0, 17, 17),
          targetUri: denoUri,
          targetRange: span(4, 2, 9),
          targetSelectionRange: span(4, 2, 9),
        },
        { uri: pathToFileURL(fixture.filePath).href, range: span(0, 17, 17) },
      ]);

      const result = await executeTool(fixture, {
        operation: "goto_definition",
        file_path: fixture.filePath,
        line: 1,
        character: 1,
      });

      const warning = approximation(`binary.ts, ${denoUri}, ${classUri}`);
      expect(resultText(result)).toBe(
        [
          'Query position: source.ts:1:1 ("const")',
          "",
          `${classUri}:121:41`,
          "binary.ts:1:31",
          `${denoUri}:5:3`,
          "source.ts:1:17  const emoji = '😀';",
          "",
          `Warning: ${warning}`,
        ].join("\n"),
      );
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            value: [
              { uri: classUri, range: span(121, 41, 47) },
              { uri: binaryPath, range: span(1, 31, 32) },
              {
                // The origin lies in the queried file, whose text converts it exactly.
                originSelectionRange: span(1, 17, 17),
                targetUri: denoUri,
                targetRange: span(5, 3, 10),
                targetSelectionRange: span(5, 3, 10),
              },
              { uri: fixture.filePath, range: span(1, 17, 17) },
            ],
          },
        ],
        warnings: [warning],
      });
      await fixture.close();
    });

    test("converts positions in the queried document against the text the server was synced with", async () => {
      const fixture = await createToolFixture();
      const uri = pathToFileURL(fixture.filePath).href;
      fixture.client.responderByMethod.set("textDocument/definition", () => {
        // The file changes on disk after the server received its text.
        writeFileSync(fixture.filePath, "x\n");
        return { uri, range: span(0, 17, 17) };
      });

      const result = await executeTool(fixture, {
        operation: "goto_definition",
        file_path: fixture.filePath,
        line: 1,
        character: 1,
      });

      expect(result.structuredContent).toMatchObject({
        results: [{ value: { uri: fixture.filePath, range: span(1, 17, 17) } }],
        warnings: [],
      });
      await fixture.close();
    });
  });

  describe("positions in a file changed since the server read it", () => {
    const position = (line: number, character: number) => ({ line, character });
    const span = (line: number, start: number, end: number) => ({
      start: position(line, start),
      end: position(line, end),
    });
    const staleWarning = (files: string) =>
      `typescript: positions in ${files} may be wrong because the file changed since the server read it or the server sent an invalid position.`;

    /** A referenced file the server indexed with several long lines, truncated to one short line. */
    async function truncatedFile(fixture: Awaited<ReturnType<typeof createToolFixture>>) {
      const path = resolve(fixture.context.cwd, "helper.ts");
      await writeFile(path, "x\n");
      return { path, uri: pathToFileURL(path).href };
    }

    test("clamps a character past the line end and keeps a line past the document end, with a warning", async () => {
      const fixture = await createToolFixture();
      const helper = await truncatedFile(fixture);
      fixture.client.responseByMethod.set("textDocument/definition", [
        { uri: helper.uri, range: span(0, 30, 33) },
        { uri: helper.uri, range: span(5, 2, 4) },
        { uri: pathToFileURL(fixture.filePath).href, range: span(0, 17, 17) },
      ]);

      const result = await executeTool(fixture, {
        operation: "goto_definition",
        file_path: fixture.filePath,
        line: 1,
        character: 1,
      });

      const warning = staleWarning("helper.ts");
      expect(resultText(result)).toBe(
        [
          'Query position: source.ts:1:1 ("const")',
          "",
          "helper.ts:1:2  x",
          "helper.ts:6:3",
          "source.ts:1:17  const emoji = '😀';",
          "",
          `Warning: ${warning}`,
        ].join("\n"),
      );
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            value: [
              { uri: helper.path, range: span(1, 2, 2) },
              { uri: helper.path, range: span(6, 3, 5) },
              { uri: fixture.filePath, range: span(1, 17, 17) },
            ],
          },
        ],
        warnings: [warning],
      });
      await fixture.close();
    });

    test("orders an unreadable-file warning, then a stale-file warning, then server failures", async () => {
      const fixture = await createToolFixture(["typescript", "failing"]);
      const helper = await truncatedFile(fixture);
      const classUri = "jdt://contents/rt.jar/java.lang/String.class";
      const good = new RecordingLspClient();
      good.responseByMethod.set("textDocument/definition", [
        { uri: helper.uri, range: span(5, 2, 4) },
        { uri: classUri, range: span(0, 3, 4) },
      ]);
      const failing = new RecordingLspClient();
      failing.failureByMethod.set("textDocument/definition", new Error("expected failure"));
      const manager = new LspServerManager<LspToolServerClient>({
        cwd: fixture.context.cwd,
        settings: resolvedSettings(["typescript", "failing"]),
        startClient: async ({ definition }) => (definition.id === "failing" ? failing : good),
      });

      const result = await executeTool(
        fixture,
        { operation: "goto_definition", file_path: fixture.filePath, line: 1, character: 1 },
        { ...fixture.dependencies, manager },
      );

      expect(result.structuredContent).toMatchObject({
        warnings: [
          `typescript: positions in ${classUri} are approximate because their text could not be read; lines are exact, but columns may be off after non-ASCII text.`,
          staleWarning("helper.ts"),
          expect.stringContaining("expected failure"),
        ],
      });
      await manager.shutdown();
      await fixture.close();
    });
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
    const dependencies = { ...fixture.dependencies, workspaceEdits };
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
    const prepared = prepareApply(fixture, { preview_id: preview.preview_id }, dependencies);
    const result = await executeTool(fixture, { operation: "apply", ...prepared }, dependencies);
    expect(result.details).toMatchObject({
      kind: "workspace_edit_apply",
      changed_paths: [fixture.filePath],
      state: "partial_failure",
    });
    // The partial failure is an error at its source, and scripts still receive its data.
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      preview_id: preview.preview_id,
      state: "partial_failure",
      changed_paths: [fixture.filePath],
      mutation_manifest: [
        { operation: "modify", path: secondFile },
        { operation: "modify", path: fixture.filePath },
      ],
      message: `Pi LSP: Workspace Edit rollback failed for: ${fixture.filePath}`,
      structured_truncated: false,
      truncated: false,
      // The directly created preview was never reported, like a server-initiated one.
      server_preview_ids: [preview.preview_id],
    });
    await fixture.close();
  });

  test("points configuration and server failures to the troubleshooting Skill", async () => {
    expect(existsSync(TROUBLESHOOTING_SKILL_PATH)).toBe(true);
    const fixture = await createToolFixture();
    await expect(
      executeTool(fixture, {
        operation: "capabilities",
        file_path: fixture.filePath,
        server_id: "missing",
      }),
    ).rejects.toThrow(TROUBLESHOOTING_HINT);

    fixture.client.failureByMethod.set("textDocument/hover", new Error("boom"));
    await expect(
      executeTool(fixture, {
        operation: "hover",
        file_path: fixture.filePath,
        line: 1,
        character: 1,
      }),
    ).rejects.toThrow(TROUBLESHOOTING_HINT);
    await fixture.close();
  });

  test("omits the troubleshooting hint for failures the model can fix itself", async () => {
    const fixture = await createToolFixture(["typescript", "other"]);
    const failure = await executeTool(fixture, {
      operation: "format_document",
      file_path: fixture.filePath,
      tab_size: 2,
      insert_spaces: true,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("provide server_id");
    expect(String(failure)).not.toContain(TROUBLESHOOTING_HINT);
    await expect(
      executeTool(fixture, {
        operation: "hover",
        file_path: fixture.filePath,
        line: 0,
        character: 1,
      }),
    ).rejects.not.toThrow(TROUBLESHOOTING_HINT);
    await fixture.close();
  });

  test("labels preview-tool timeouts and crashes by server and points to the troubleshooting Skill", async () => {
    const fixture = await createToolFixture();
    const timeout = new LspServerClientError(
      "timeout",
      "typescript",
      "/tmp/typescript.stderr",
      "request expired",
    );
    const crash = new LspServerClientError(
      "exit",
      "typescript",
      "/tmp/typescript.stderr",
      "process exited unexpectedly with code 1",
    );
    const previews = [
      {
        call: {
          operation: "rename",
          file_path: fixture.filePath,
          line: 1,
          character: 7,
          new_name: "smile",
        },
        method: "textDocument/rename",
      },
      {
        call: { operation: "code_actions", file_path: fixture.filePath, range: range() },
        method: "textDocument/codeAction",
      },
    ] satisfies { call: LspToolParameters; method: string }[];
    for (const { call, method } of previews) {
      for (const [failure, during] of [
        [timeout, "request"],
        [crash, "request"],
        [timeout, "synchronization"],
        [crash, "synchronization"],
      ] as const) {
        fixture.client.failureByMethod.clear();
        fixture.client.synchronizationFailure = undefined;
        if (during === "request") fixture.client.failureByMethod.set(method, failure);
        else fixture.client.synchronizationFailure = failure;
        const label = `${call.operation} ${failure.kind} during ${during}`;
        const error = await executeTool(fixture, call).catch((cause: unknown) => cause);
        expect(error, label).toEqual(
          new Error(
            `Pi LSP: server typescript request failed: ${failure.message}\n\n${TROUBLESHOOTING_HINT}`,
          ),
        );
      }
    }
    await fixture.close();
  });

  test("reports a missing file as an input error before asking any server", async () => {
    const fixture = await createToolFixture();
    const missing = resolve(fixture.context.cwd, "missing.ts");
    for (const call of [
      { operation: "hover", file_path: "missing.ts", line: 1, character: 1 },
      { operation: "diagnostics", file_path: "@missing.ts" },
      { operation: "rename", file_path: missing, line: 1, character: 1, new_name: "x" },
    ] satisfies LspToolParameters[]) {
      const failure = await executeTool(fixture, call).catch((cause: unknown) => cause);
      expect(failure, call.operation).toEqual(new Error(`Pi LSP: file not found: ${missing}`));
      expect(String(failure)).not.toContain(TROUBLESHOOTING_HINT);
    }
    await expect(
      executeTool(fixture, {
        operation: "document_symbols",
        file_path: fixture.context.cwd,
      }),
    ).rejects.toThrow(`Pi LSP: ${fixture.context.cwd} is a directory, not a file`);
    expect(fixture.client.requests).toEqual([]);
    await fixture.close();
  });

  test("names the unsupported capability and the matching servers that lack it, without the hint", async () => {
    const fixture = await createToolFixture(["typescript", "other"]);
    fixture.client.unsupportedMethods.add("textDocument/declaration");
    fixture.client.unsupportedMethods.add("textDocument/formatting");
    const read = await executeTool(fixture, {
      operation: "declaration",
      file_path: fixture.filePath,
      line: 1,
      character: 1,
    }).catch((cause: unknown) => cause);
    expect(read).toEqual(
      new Error(
        "Pi LSP: no matching server supports textDocument/declaration; matching servers without it: typescript, other",
      ),
    );
    const mutation = await executeTool(fixture, {
      operation: "format_document",
      file_path: fixture.filePath,
      tab_size: 2,
      insert_spaces: true,
      server_id: "other",
    }).catch((cause: unknown) => cause);
    expect(mutation).toEqual(
      new Error("Pi LSP: server other does not support textDocument/formatting"),
    );
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
    const prepared = prepareApply(fixture, {
      preview_id: preview.preview_id,
      mutation_manifest: [{ operation: "delete", path: fixture.filePath }],
    });
    expect(prepared.mutation_manifest).toEqual([{ operation: "modify", path: fixture.filePath }]);
    await expect(
      executeTool(fixture, {
        operation: "apply",
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
    // The structured result stays complete and names the Result Spill of the cut text.
    expect(resultText(spillResult).length).toBeLessThan(60 * 1024);
    expect(spillResult.structuredContent).toEqual({
      results: [
        {
          root_path: fixture.context.cwd,
          server_id: "typescript",
          value: [{ name: "x".repeat(60 * 1024) }],
          omitted: 0,
        },
      ],
      warnings: [],
      structured_truncated: false,
      truncated: true,
      spill_path: spillResult.details.spill_path,
      // The directly created preview was never reported, like a server-initiated one.
      server_preview_ids: [preview.preview_id],
    });
    await fixture.close();
  });

  describe("compact text results", () => {
    function protocolRange(line: number, character: number, length: number) {
      return {
        start: { line, character },
        end: { line, character: character + length },
      };
    }

    function oneBasedRange(line: number, character: number, length: number) {
      return {
        start: { line: line + 1, character: character + 1 },
        end: { line: line + 1, character: character + length + 1 },
      };
    }

    test("lists LSP Diagnostics one per line over unchanged structured data", async () => {
      const fixture = await createToolFixture();
      await writeFile(fixture.filePath, "const emoji = '😀';\nlet unused = emoji;\n");
      const uri = pathToFileURL(fixture.filePath).href;
      const related = [
        { location: { uri, range: protocolRange(0, 6, 5) }, message: "'emoji' is declared here." },
      ];
      fixture.client.documentDiagnosticsResult = {
        status: "fresh",
        source: "document_pull",
        diagnostics: [
          {
            range: protocolRange(1, 4, 6),
            severity: 2,
            source: "oxlint",
            code: "eslint(no-unused-vars)",
            codeDescription: {
              href: "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html",
            },
            message:
              "Variable 'unused' is declared but never used.\nUnused variables should start with a '_'.",
            relatedInformation: related,
          },
          {
            range: protocolRange(1, 13, 5),
            severity: 1,
            source: "ts",
            code: 2322,
            message: "Type 'string' is not assignable to type 'number'.",
          },
          { range: protocolRange(0, 0, 5), message: "Prefer let." },
        ],
      };

      const result = await executeTool(fixture, {
        operation: "diagnostics",
        file_path: fixture.filePath,
      });

      expect(resultText(result)).toBe(
        [
          "source.ts:2:5-11 warning oxlint(eslint(no-unused-vars)): Variable 'unused' is declared but never used. Unused variables should start with a '_'.",
          "source.ts:2:14-19 error ts(2322): Type 'string' is not assignable to type 'number'.",
          "source.ts:1:1-6: Prefer let.",
        ].join("\n"),
      );
      const results = [
        {
          root_path: fixture.context.cwd,
          server_id: "typescript",
          value: {
            status: "fresh",
            source: "document_pull",
            diagnostics: [
              {
                range: oneBasedRange(1, 4, 6),
                severity: 2,
                source: "oxlint",
                code: "eslint(no-unused-vars)",
                codeDescription: {
                  href: "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html",
                },
                message:
                  "Variable 'unused' is declared but never used.\nUnused variables should start with a '_'.",
                relatedInformation: [
                  {
                    location: { uri: fixture.filePath, range: oneBasedRange(0, 6, 5) },
                    message: "'emoji' is declared here.",
                  },
                ],
              },
              {
                range: oneBasedRange(1, 13, 5),
                severity: 1,
                source: "ts",
                code: 2322,
                message: "Type 'string' is not assignable to type 'number'.",
              },
              { range: oneBasedRange(0, 0, 5), message: "Prefer let." },
            ],
          },
        },
      ];
      expect(result.structuredContent).toEqual({
        results,
        warnings: [],
        structured_truncated: false,
        truncated: false,
      });
      expect(result.details).toMatchObject({ operation: "diagnostics", result_count: 3 });
      // The JSON envelope these results showed before the text was compact.
      const jsonText = formatLspToolValue({ results, warnings: [] });
      expect(resultText(result).length).toBeLessThan(jsonText.length / 2);
      await fixture.close();
    });

    test("shows only the hover contents under the queried position", async () => {
      const fixture = await createToolFixture();
      const markdown = {
        contents: {
          kind: "markdown",
          value: "```typescript\nconst emoji: string\n```\n\nA *smiling* face.",
        },
        range: protocolRange(0, 6, 5),
      };
      fixture.client.responseByMethod.set("textDocument/hover", markdown);
      const call = { file_path: fixture.filePath, line: 1, character: 7 } as const;

      const result = await executeTool(fixture, { operation: "hover", ...call });

      expect(resultText(result)).toBe(
        [
          'Query position: source.ts:1:7 ("emoji")',
          "",
          "```typescript",
          "const emoji: string",
          "```",
          "",
          "A *smiling* face.",
        ].join("\n"),
      );
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            server_id: "typescript",
            value: { contents: markdown.contents, range: oneBasedRange(0, 6, 5) },
          },
        ],
      });

      fixture.client.responseByMethod.set("textDocument/hover", {
        contents: [{ language: "typescript", value: "const emoji: string" }, "A smiling face."],
      });
      const marked = await executeTool(fixture, { operation: "hover", ...call });
      expect(resultText(marked)).toBe(
        [
          'Query position: source.ts:1:7 ("emoji")',
          "",
          "```typescript",
          "const emoji: string",
          "```",
          "",
          "A smiling face.",
        ].join("\n"),
      );
      await fixture.close();
    });

    test("lists Server Instances and Disabled Server Definitions, counts the other Server Definitions, and lists everything with all: true", async () => {
      const fixture = await createToolFixture();
      const cwd = fixture.context.cwd;
      const base = resolvedSettings(["typescript", "broken", "python", "dormant", "ruby"]);
      const typescriptLanguages = [
        { extensions: [".ts", ".tsx"], fileNames: [], languageId: "typescript" },
        { extensions: [".js"], fileNames: [], languageId: "javascript" },
      ];
      const pythonLanguages = [
        { extensions: [".py"], fileNames: ["SConstruct"], languageId: "python" },
      ];
      const rubyLanguages = [{ extensions: [".rb"], fileNames: [], languageId: "ruby" }];
      const languagesById = new Map([
        ["typescript", typescriptLanguages],
        ["broken", typescriptLanguages],
        ["python", pythonLanguages],
        ["dormant", pythonLanguages],
        ["ruby", rubyLanguages],
      ]);
      const settings: ResolvedLspSettings = {
        ...base,
        enablement: new Map([["dormant", { enabled: false, scope: "global" }]]),
        warnings: ["Project lsp.servers.bad: command is required"],
        servers: new Map(
          [...base.servers].map(([id, definition]) => [
            id,
            { ...definition, languages: languagesById.get(id) ?? [] },
          ]),
        ),
      };
      const manager = new LspServerManager<LspToolServerClient>({
        cwd,
        settings,
        startClient: async ({ definition }) => {
          if (definition.id === "broken") throw new Error("spawn broken ENOENT\nexit 127");
          return fixture.client;
        },
      });
      const dependencies = { ...fixture.dependencies, manager };
      await executeTool(
        fixture,
        { operation: "diagnostics", file_path: fixture.filePath },
        dependencies,
      );

      const status = await executeTool(fixture, { operation: "status" }, dependencies);
      const full = await executeTool(fixture, { operation: "status", all: true }, dependencies);

      const structured = Value.Parse(LspStatusOutputSchema, status.structuredContent);
      const [, broken] = structured.servers;
      expect(broken?.error).toContain("spawn broken ENOENT");
      const errorLine = `broken unavailable ${cwd} typescript(.ts,.tsx) javascript(.js) error: ${broken?.error?.replaceAll(/\s+/gu, " ")}`;
      expect(resultText(status)).toBe(
        [
          `typescript running ${cwd} typescript(.ts,.tsx) javascript(.js)`,
          errorLine,
          "dormant disabled python(.py,SConstruct)",
          "+2 configured, not started (pass all: true to list)",
          "",
          "Warning: Project lsp.servers.bad: command is required",
        ].join("\n"),
      );
      expect(resultText(full)).toBe(
        [
          `typescript running ${cwd} typescript(.ts,.tsx) javascript(.js)`,
          errorLine,
          "python configured python(.py,SConstruct)",
          "dormant disabled python(.py,SConstruct)",
          "ruby configured ruby(.rb)",
          "",
          "Warning: Project lsp.servers.bad: command is required",
        ].join("\n"),
      );
      // The structured result applies the same filter as the text, and all: true opts out.
      expect(structured).toEqual({
        servers: [
          {
            server_id: "typescript",
            root_path: cwd,
            state: "running",
            languages: { typescript: [".ts", ".tsx"], javascript: [".js"] },
          },
          {
            server_id: "broken",
            root_path: cwd,
            state: "unavailable",
            error: broken?.error,
            languages: { typescript: [".ts", ".tsx"], javascript: [".js"] },
          },
          {
            server_id: "dormant",
            state: "disabled",
            languages: { python: [".py", "SConstruct"] },
          },
        ],
        not_started: 2,
        warnings: ["Project lsp.servers.bad: command is required"],
        structured_truncated: false,
        truncated: false,
      });
      expect(Value.Parse(LspStatusOutputSchema, full.structuredContent)).toMatchObject({
        not_started: 0,
      });
      expect(status.details).toMatchObject({ operation: "status", result_count: 5 });
      expect(full.details).toMatchObject({ operation: "status", result_count: 5 });
      await manager.shutdown();
      await fixture.close();
    });

    test("lists code actions with their preview, or why they cannot be applied", async () => {
      const fixture = await createToolFixture();
      const uri = pathToFileURL(fixture.filePath).href;
      const missingUri = pathToFileURL(join(fixture.context.cwd, "missing.ts")).href;
      const insertion = (target: string): WorkspaceEdit => ({
        changes: {
          [target]: [{ range: protocolRange(0, 0, 0), newText: "// fixed\n" }],
        },
      });
      fixture.client.responseByMethod.set("textDocument/codeAction", [
        { title: "Add comment", kind: "quickfix", edit: insertion(uri) },
        { title: "Organize imports", kind: "source.organizeImports", command: "organize" },
        { title: "Fix elsewhere", edit: insertion(missingUri) },
      ]);

      const result = await executeTool(fixture, {
        operation: "code_actions",
        file_path: fixture.filePath,
        range: range(),
      });

      const { actions } = Value.Parse(LspCodeActionsOutputSchema, result.structuredContent);
      const [applicable, , invalid] = actions;
      expect(applicable?.summary).toContain("+// fixed");
      expect(invalid?.error).toContain("text edit file is missing");
      expect(resultText(result)).toBe(
        [
          `Add comment (quickfix): preview ${applicable?.preview_id}`,
          ...(applicable?.summary ?? "")
            .trimEnd()
            .split("\n")
            .map((line) => `  ${line}`),
          "Organize imports (source.organizeImports): command only, cannot be applied",
          `Fix elsewhere: cannot be applied: ${invalid?.error}`,
        ].join("\n"),
      );
      expect(result.details).toMatchObject({ operation: "code_actions", result_count: 3 });

      fixture.client.responseByMethod.set("textDocument/codeAction", []);
      const none = await executeTool(fixture, {
        operation: "code_actions",
        file_path: fixture.filePath,
        range: range(),
      });
      expect(resultText(none)).toBe("No code actions found.");
      await fixture.close();
    });

    test("lists the files an applied preview changed", async () => {
      const fixture = await createToolFixture();
      const cwd = fixture.context.cwd;
      await writeFile(join(cwd, "old.ts"), "old\n");
      await writeFile(join(cwd, "deleted.ts"), "deleted\n");
      const fileUri = (name: string) => pathToFileURL(join(cwd, name)).href;
      fixture.client.responseByMethod.set("textDocument/rename", {
        documentChanges: [
          {
            textDocument: { uri: pathToFileURL(fixture.filePath).href, version: null },
            edits: [{ range: protocolRange(0, 0, 0), newText: "// applied\n" }],
          },
          { kind: "create", uri: fileUri("created.ts") },
          { kind: "rename", oldUri: fileUri("old.ts"), newUri: fileUri("new.ts") },
          { kind: "delete", uri: fileUri("deleted.ts") },
        ],
      });
      const preview = await executeTool(fixture, {
        operation: "rename",
        file_path: fixture.filePath,
        line: 1,
        character: 7,
        new_name: "renamed",
      });
      if (preview.details.kind !== "workspace_edit_preview") throw new Error("Expected a preview");

      const prepared = prepareApply(fixture, { preview_id: preview.details.preview_id });
      const applied = await executeTool(fixture, { operation: "apply", ...prepared });

      expect(resultText(applied)).toBe(
        [
          `Applied Workspace Edit Preview ${preview.details.preview_id}:`,
          "modified source.ts",
          "created created.ts",
          "deleted deleted.ts",
          "renamed old.ts -> new.ts",
        ].join("\n"),
      );
      expect(applied.structuredContent).toMatchObject({
        state: "applied",
        changed_files: [fixture.filePath],
        created_files: [join(cwd, "created.ts")],
        deleted_files: [join(cwd, "deleted.ts")],
        moved_files: [{ from: join(cwd, "old.ts"), to: join(cwd, "new.ts") }],
      });
      await fixture.close();
    });

    test("shows each diagnostic's range end so findings at one start stay distinct", async () => {
      const fixture = await createToolFixture();
      await writeFile(fixture.filePath, `${"x".repeat(60)}\n${"y".repeat(10)}\n`);
      const diagnostics: Diagnostic[] = [
        { range: protocolRange(0, 27, 14), severity: 2, message: "Unnecessary cast" },
        { range: protocolRange(0, 27, 24), severity: 2, message: "Unnecessary cast" },
        {
          range: { start: { line: 0, character: 27 }, end: { line: 1, character: 2 } },
          severity: 1,
          message: "broken",
        },
        { range: protocolRange(1, 4, 0), severity: 1, message: "empty range" },
      ];
      const expected = [
        "source.ts:1:28-42 warning: Unnecessary cast",
        "source.ts:1:28-52 warning: Unnecessary cast",
        "source.ts:1:28-2:3 error: broken",
        "source.ts:2:5 error: empty range",
      ];
      fixture.client.documentDiagnosticsResult = { status: "fresh", source: "push", diagnostics };
      fixture.client.workspaceDiagnosticsResult = {
        status: "fresh",
        source: "workspace_pull",
        diagnosticsByUri: new Map([[pathToFileURL(fixture.filePath).href, diagnostics]]),
      };

      const document = await executeTool(fixture, {
        operation: "diagnostics",
        file_path: fixture.filePath,
      });
      const workspace = await executeTool(fixture, {
        operation: "workspace_diagnostics",
        server_id: "typescript",
        file_path: fixture.filePath,
      });

      expect(resultText(document)).toBe(expected.join("\n"));
      expect(resultText(workspace)).toBe(expected.join("\n"));
      await fixture.close();
    });

    test("renders well-formed diagnostics compactly beside a malformed one", async () => {
      const fixture = await createToolFixture();
      const malformed = { severity: 1, message: "no range" };
      // Servers send diagnostics that break the protocol's types, as a decoded wire message would.
      const diagnostics: Diagnostic[] = JSON.parse(
        JSON.stringify([
          { range: protocolRange(0, 6, 5), severity: 2, source: "ts", message: "first" },
          malformed,
          {
            range: protocolRange(0, 0, 5),
            severity: 1,
            source: null,
            code: null,
            message: "nulls",
          },
        ]),
      );
      fixture.client.documentDiagnosticsResult = { status: "fresh", source: "push", diagnostics };

      const result = await executeTool(fixture, {
        operation: "diagnostics",
        file_path: fixture.filePath,
      });

      expect(resultText(result)).toBe(
        [
          "source.ts:1:7-12 warning ts: first",
          formatLspToolValue(malformed),
          "source.ts:1:1-6 error: nulls",
        ].join("\n"),
      );
      await fixture.close();
    });

    test("marks a clean file per server", async () => {
      const fixture = await createToolFixture(["typescript", "oxlint"]);

      const result = await executeTool(fixture, {
        operation: "diagnostics",
        file_path: fixture.filePath,
      });

      expect(resultText(result)).toBe(
        [
          "typescript:",
          "  source.ts: no diagnostics",
          "oxlint:",
          "  source.ts: no diagnostics",
        ].join("\n"),
      );
      await fixture.close();
    });

    test("states that a silent server published no diagnostics, not that the query failed", async () => {
      const fixture = await createToolFixture();
      fixture.client.documentDiagnosticsResult = {
        status: "timeout",
        diagnostics: [],
        waitedMs: 3000,
        pushOnly: true,
        remembered: false,
      };

      const result = await executeTool(fixture, {
        operation: "diagnostics",
        file_path: fixture.filePath,
      });

      expect(resultText(result)).toBe(
        "source.ts: no diagnostics published by typescript within 3s (not a failure; a server that only pushes diagnostics stays silent for a clean file, so the file may be clean)",
      );
      expect(result.structuredContent).toMatchObject({
        results: [
          {
            server_id: "typescript",
            value: {
              status: "timeout",
              diagnostics: [],
              waitedMs: 3000,
              pushOnly: true,
              remembered: false,
            },
          },
        ],
      });
      await fixture.close();
    });

    test("reports a stalled pull-capable server as a stalled request, not as a clean file", async () => {
      const fixture = await createToolFixture();
      fixture.client.documentDiagnosticsResult = {
        status: "timeout",
        diagnostics: [],
        waitedMs: 3000,
        pushOnly: false,
        remembered: false,
      };

      const result = await executeTool(fixture, {
        operation: "diagnostics",
        file_path: fixture.filePath,
      });

      expect(resultText(result)).toBe(
        "source.ts: no diagnostics received from typescript within 3s (the request stalled; the server may still be starting or indexing, so retry later)",
      );
      await fixture.close();
    });

    test("says a remembered silence was answered without waiting again", async () => {
      const fixture = await createToolFixture();
      fixture.client.documentDiagnosticsResult = {
        status: "timeout",
        diagnostics: [],
        waitedMs: 250,
        pushOnly: true,
        remembered: true,
      };

      const result = await executeTool(fixture, {
        operation: "diagnostics",
        file_path: fixture.filePath,
      });

      expect(resultText(result)).toBe(
        "source.ts: no diagnostics published by typescript for this unchanged file (an earlier wait of 250ms saw none; not a failure, the file may be clean; edit the file to wait again)",
      );
      await fixture.close();
    });
  });
});
