import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
import { afterEach, describe, expect, test } from "vitest";
import {
  type Diagnostic,
  PositionEncodingKind,
  type ServerCapabilities,
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
  LSP_OPERATION_NAMES,
  LspApplyOutputSchema,
  LspReadOutputSchema,
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
import { TROUBLESHOOTING_HINT, TROUBLESHOOTING_SKILL_PATH } from "../src/troubleshooting-skill.js";
import type { ResolvedLspSettings } from "../src/pi-lsp-settings.js";

const temporaryDirectories: string[] = [];

class RecordingLspClient implements LspToolServerClient {
  readonly capabilities: ServerCapabilities = {};
  readonly positionEncoding = PositionEncodingKind.UTF16;
  readonly requests: string[] = [];
  readonly parametersByMethod = new Map<string, unknown[]>();
  responseByMethod = new Map<string, unknown>();
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Responders simulate servers over opaque protocol payloads.
  responderByMethod = new Map<string, (parameters: unknown) => unknown>();
  currentDiagnostics: Diagnostic[] = [];
  currentDiagnosticsFailure: Error | undefined;
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
      uri: pathToFileURL(filePath).href,
      version: 1,
      text,
    };
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
      expect(tool.promptGuidelines, tool.name).toEqual([LSP_TOOL_GUIDELINE]);
      expect(tool.outputSchema, tool.name).toMatchObject({ type: "object" });
      expect(tool.hasPrepareArguments, tool.name).toBe(tool.name === "lsp_apply");
      // Shared rules live in the namespace instructions and one deduplicated guideline.
      expect(tool.description, tool.name).not.toMatch(/one-based|Result Spill|leading @/u);
    }
    expect(LSP_TOOL_NAMESPACE.description?.length ?? 0).toBeLessThan(80);
    expect(LSP_TOOL_NAMESPACE.instructions).toContain("one-based");
    expect(LSP_TOOL_NAMESPACE.instructions).toContain("Result Spill");
    expect(LSP_TOOL_NAMESPACE.instructions).toContain("Paths may start with @");
    expect(LSP_TOOL_NAMESPACE.instructions).toContain("lsp_apply");
    // Pi shows namespace instructions only to scripts, so direct callers learn the output rules
    // from the guideline.
    expect(LSP_TOOL_GUIDELINE).toContain("in arguments and results, are one-based");
    expect(LSP_TOOL_GUIDELINE).toContain(
      "path:line:col line per location, with paths relative to the working directory",
    );

    const annotationsOf = (name: string) =>
      registrar.tools.find((tool) => tool.name === name)?.annotations;
    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    for (const name of ["lsp_hover", "lsp_status", "lsp_capabilities", "lsp_workspace_diagnostics"])
      expect(annotationsOf(name), name).toEqual(readOnly);
    // Preview producers change no file, but every call creates a new preview_id.
    for (const name of [
      "lsp_rename",
      "lsp_code_actions",
      "lsp_format_document",
      "lsp_format_range",
      "lsp_format_on_type",
    ])
      expect(annotationsOf(name), name).toEqual({ ...readOnly, idempotentHint: false });
    // One snippet names the lsp_* family in the system prompt's tool list.
    expect(
      registrar.tools.filter((tool) => tool.promptSnippet !== undefined).map(({ name }) => name),
    ).toEqual(["lsp_diagnostics"]);
    expect(annotationsOf("lsp_restart")).toEqual({
      readOnlyHint: false,
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
      LspReadOutputSchema,
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
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        expect(text).toContain('"applicable":false');
        expect(text).toContain('"applicable":true');
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
      results: [
        {
          root_path: fixture.context.cwd,
          server_id: "typescript",
          value: [
            {
              uri: fixture.filePath,
              range: { start: { line: 1, character: 7 }, end: { line: 1, character: 12 } },
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
    expect(status.structuredContent).toEqual({
      servers: [{ server_id: "typescript", root_path: fixture.context.cwd, state: "running" }],
      warnings: [],
      structured_truncated: false,
      truncated: false,
    });
    expect(JSON.parse(resultText(status))).toEqual({
      servers: [{ server_id: "typescript", root_path: fixture.context.cwd, state: "running" }],
      warnings: [],
    });

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
    expect(actions.structuredContent).toEqual({
      server_id: "typescript",
      actions: JSON.parse(resultText(actions)),
      structured_truncated: false,
      truncated: false,
    });
    expect(actions.structuredContent).toMatchObject({
      actions: [
        { applicable: false, title: "Run command", kind: "source", command: "example.run" },
        { applicable: true, title: "Apply edit", kind: "quickfix", preview_id: expect.any(String) },
      ],
    });

    const prepared = prepareApply(fixture, { preview_id: rename.details.preview_id });
    const applied = await executeTool(fixture, { operation: "apply", ...prepared });
    expect(applied.isError).toBeUndefined();
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

  test("renders a multi-file references result as readable text over unchanged structured data", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    const otherPath = resolve(cwd, "nested/use.ts");
    await mkdir(resolve(cwd, "nested"), { recursive: true });
    await writeFile(otherPath, "import { emoji } from '../source';\n\tconsole.log(emoji);\n");
    const outsidePath = resolve(cwd, "..", `${basename(cwd)}-outside.ts`);
    temporaryDirectories.push(outsidePath);
    await writeFile(outsidePath, "emoji;\n");
    const protocolRange = (line: number, character: number) => ({
      start: { line, character },
      end: { line, character: character + 5 },
    });
    fixture.client.responseByMethod.set("textDocument/references", [
      { uri: pathToFileURL(fixture.filePath).href, range: protocolRange(0, 6) },
      { uri: pathToFileURL(otherPath).href, range: protocolRange(0, 9) },
      { uri: pathToFileURL(otherPath).href, range: protocolRange(1, 13) },
      { uri: pathToFileURL(outsidePath).href, range: protocolRange(0, 0) },
    ]);

    const result = await executeTool(fixture, {
      operation: "find_references",
      file_path: "@source.ts",
      line: 1,
      character: 7,
    });

    expect(resultText(result)).toBe(
      [
        `Searched typescript workspace root: ${cwd}`,
        "",
        "source.ts:1:7  const emoji = '😀';",
        "nested/use.ts:1:10  import { emoji } from '../source';",
        "nested/use.ts:2:14  console.log(emoji);",
        `${outsidePath}:1:1  emoji;`,
      ].join("\n"),
    );
    const oneBasedRange = (line: number, character: number) => ({
      end: { character: character + 5, line },
      start: { character, line },
    });
    // Byte-identical to the compact JSON these reads returned as text before.
    expect(JSON.stringify(result.structuredContent)).toBe(
      JSON.stringify({
        results: [
          {
            root_path: cwd,
            server_id: "typescript",
            value: [
              { range: oneBasedRange(1, 7), uri: fixture.filePath },
              { range: oneBasedRange(1, 10), uri: otherPath },
              { range: oneBasedRange(2, 14), uri: otherPath },
              { range: oneBasedRange(1, 1), uri: outsidePath },
            ],
          },
        ],
        warnings: [],
        truncated: false,
        structured_truncated: false,
      }),
    );
    expect(result.details).toEqual({
      kind: "operation",
      operation: "find_references",
      server_outcomes: [{ server_id: "typescript", outcome: "success" }],
      result_count: 4,
    });
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

    const warning = `typescript searched only its workspace root ${join("packages", "a")}, but other typescript workspace roots exist: ${join("packages", "b")}. Files outside ${join("packages", "a")} may not have been considered; query a file under each other root or search for importers before relying on this result.`;
    expect(resultText(result)).toBe(
      [
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

  test("warns in the rename preview summary that other workspace roots were not searched", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    const searchedRoot = resolve(cwd, "packages/a");
    const sourcePath = resolve(searchedRoot, "source.ts");
    await mkdir(resolve(cwd, "packages/b"), { recursive: true });
    await mkdir(searchedRoot, { recursive: true });
    await writeFile(resolve(searchedRoot, "package.json"), "{}\n");
    await writeFile(resolve(cwd, "packages/b/package.json"), "{}\n");
    await writeFile(sourcePath, "export const helper = 1;\n");
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

    const rename = await executeTool(
      fixture,
      { operation: "rename", file_path: sourcePath, line: 1, character: 14, new_name: "renamed" },
      { ...fixture.dependencies, manager },
    );

    if (rename.details.kind !== "workspace_edit_preview") throw new Error("Expected a preview");
    const warning = `typescript searched only its workspace root ${join("packages", "a")}, but other typescript workspace roots exist: ${join("packages", "b")}. Files outside ${join("packages", "a")} may not have been considered; query a file under each other root or search for importers before relying on this result.`;
    const scope = `Searched typescript workspace root: ${join("packages", "a")}\nWarning: ${warning}`;
    expect(rename.details.summary.startsWith(`${scope}\n\n`)).toBe(true);
    expect(rename.details.summary).toContain("+export const renamed = 1;");
    expect(resultText(rename)).toBe(
      `Workspace Edit Preview ${rename.details.preview_id}\n${rename.details.summary}`,
    );
    expect(rename.structuredContent).toMatchObject({
      root_path: searchedRoot,
      summary: rename.details.summary,
      warnings: [warning],
    });
    await manager.shutdown();
    await fixture.close();
  });

  test("names the only workspace root without a warning", async () => {
    const fixture = await createToolFixture();
    const cwd = fixture.context.cwd;
    await writeFile(resolve(cwd, "package.json"), "{}\n");
    fixture.client.responseByMethod.set("textDocument/rename", {
      changes: {
        [pathToFileURL(fixture.filePath).href]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
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

    const references = await executeTool(
      fixture,
      { operation: "find_references", file_path: fixture.filePath, line: 1, character: 7 },
      dependencies,
    );
    const rename = await executeTool(
      fixture,
      {
        operation: "rename",
        file_path: fixture.filePath,
        line: 1,
        character: 7,
        new_name: "renamed",
      },
      dependencies,
    );

    expect(resultText(references)).toBe(
      [`Searched typescript workspace root: ${cwd}`, "", "No references found."].join("\n"),
    );
    expect(references.structuredContent).toMatchObject({ warnings: [] });
    if (rename.details.kind !== "workspace_edit_preview") throw new Error("Expected a preview");
    expect(
      rename.details.summary.startsWith(`Searched typescript workspace root: ${cwd}\n\n`),
    ).toBe(true);
    expect(rename.details.summary).not.toContain("Warning:");
    expect(rename.structuredContent).toMatchObject({ root_path: cwd, warnings: [] });
    await manager.shutdown();
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
        "good:",
        "  source.ts:1:7  const emoji = '😀';",
        "empty:",
        "  No locations found.",
        "",
        `Warning: ${warning}`,
      ].join("\n"),
    );
    expect(warning).toContain("expected failure");
    await manager.shutdown();
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
    const result = await executeTool(
      fixture,
      { operation: "hover", file_path: fixture.filePath, line: 1, character: 1 },
      { ...fixture.dependencies, manager },
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
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({
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

  test("preserves opaque completion metadata without treating lookalike fields as positions", async () => {
    const fixture = await createToolFixture();
    fixture.client.responseByMethod.set("textDocument/completion", {
      isIncomplete: false,
      items: [
        {
          label: "value",
          data: { line: "opaque", character: 0, enabled: false, empty: "", none: null },
        },
      ],
    });
    const result = await executeTool(fixture, {
      operation: "completion",
      file_path: fixture.filePath,
      line: 1,
      character: 1,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({
      results: [
        {
          value: {
            isIncomplete: false,
            items: [
              {
                label: "value",
                data: { line: "opaque", character: 0, enabled: false, empty: "", none: null },
              },
            ],
          },
        },
      ],
    });
    await fixture.close();
  });

  test("converts folding ranges to one-based Unicode code-point coordinates", async () => {
    const fixture = await createToolFixture();
    fixture.client.responseByMethod.set("textDocument/foldingRange", [
      { startLine: 0, startCharacter: 15, endLine: 0, endCharacter: 17 },
    ]);

    const result = await executeTool(fixture, {
      operation: "folding_ranges",
      file_path: fixture.filePath,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain('"startCharacter":16');
    expect(text).toContain('"endCharacter":17');
    expect(text).toContain('"startLine":1');
    expect(text).toContain('"endLine":1');
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

  test("caps structured results at 1 MiB, bounding them and keeping the complete Result Spill", async () => {
    const fixture = await createToolFixture();
    const hugeName = "y".repeat(3 * 1024 * 1024);
    const symbols = Array.from({ length: 50_000 }, (_, index) => ({
      name: `symbol-${index}`,
    }));
    fixture.client.responseByMethod.set("workspace/symbol", [{ name: hugeName }, ...symbols]);
    const result = await executeTool(fixture, {
      operation: "workspace_symbols",
      query: "y",
      file_path: fixture.filePath,
    });
    if (result.details.kind !== "operation" || result.details.spill_path === undefined) {
      throw new Error("Expected Result Spill path");
    }
    const structured = Value.Parse(LspReadOutputSchema, result.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(structured).toMatchObject({
      structured_truncated: true,
      truncated: true,
      spill_path: result.details.spill_path,
    });
    const complete = await readFile(result.details.spill_path, "utf8");
    expect(complete).toContain(hugeName);
    expect(complete).toContain("symbol-49999");
    const [answer] = structured.results;
    expect(answer?.value).toEqual(expect.any(Array));
    expect(structured.warnings.join("\n")).toContain(result.details.spill_path);
    await fixture.close();
  });
});
