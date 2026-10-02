import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolAnnotations,
  ToolDefinition,
  ToolExposure,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
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
  responseByMethod = new Map<string, unknown>();
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
    _parameters: unknown,
    _signal?: AbortSignal,
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Fixture responses remain unparsed until the real dispatch/preview boundary checks them.
  ): Promise<unknown> {
    this.requests.push(method);
    const failure = this.failureByMethod.get(method);
    if (failure !== undefined) throw failure;
    const response = this.responseByMethod.get(method) ?? [];
    return response;
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

function resolvedSettings(serverIds: readonly string[]): ResolvedLspSettings {
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
      ...JSON.parse(resultText(references)),
      structured_truncated: false,
      truncated: false,
    });
    expect(references.structuredContent).toMatchObject({
      results: [
        {
          server_id: "typescript",
          value: [{ uri: fixture.filePath, range: { start: { line: 1, character: 7 } } }],
        },
      ],
    });

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
      summary: rename.details.summary,
      mutation_manifest: [{ operation: "modify", path: fixture.filePath }],
      structured_truncated: false,
      truncated: false,
    });

    const actions = await executeTool(fixture, {
      operation: "code_actions",
      file_path: fixture.filePath,
      range: oneBasedRange(),
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
