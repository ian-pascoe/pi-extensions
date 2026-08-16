import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  CodeActionRequest,
  CodeActionResolveRequest,
  CodeLensRequest,
  CodeLensResolveRequest,
  CompletionRequest,
  CompletionResolveRequest,
  DeclarationRequest,
  DefinitionRequest,
  DocumentColorRequest,
  DocumentFormattingRequest,
  DocumentHighlightRequest,
  DocumentLinkRequest,
  DocumentLinkResolveRequest,
  DocumentOnTypeFormattingRequest,
  DocumentRangeFormattingRequest,
  DocumentSymbolRequest,
  FoldingRangeRequest,
  HoverRequest,
  ImplementationRequest,
  InlayHintRequest,
  InlayHintResolveRequest,
  PositionEncodingKind,
  PrepareRenameRequest,
  ReferencesRequest,
  RenameRequest,
  SelectionRangeRequest,
  SignatureHelpRequest,
  TypeDefinitionRequest,
  TypeHierarchyPrepareRequest,
  TypeHierarchySubtypesRequest,
  TypeHierarchySupertypesRequest,
  WorkspaceSymbolRequest,
  WorkspaceSymbolResolveRequest,
  type LSPAny,
  type Position,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol/node";
import {
  convertLspCodePointPosition,
  convertLspProtocolPosition,
  normalizeLspPositionEncoding,
  type LspCodePointPosition,
  type LspPositionEncoding,
} from "./lsp-position-encoding.js";
import type {
  LspDocumentDiagnosticResult,
  LspSynchronizedDocument,
  LspWorkspaceDiagnosticResult,
} from "./lsp-server-client.js";
import {
  normalizeLspFilePath,
  type LspServerFailure,
  type LspServerManager,
  type LspServerReadResult,
  type LspServerRoute,
} from "./lsp-server-manager.js";
import type { LspSessionFiles } from "./lsp-session-files.js";
import {
  LspToolParametersSchema,
  LspWorkspaceEditPreviewRecordSchema,
  MutationManifestSchema,
  type LspToolParameters,
  type LspToolResultDetails,
  type MutationManifest,
  type ServerOperationOutcome,
} from "./lsp-tool-contract.js";
import {
  createLspToolOutput as createBaseLspToolOutput,
  formatLspToolValue,
} from "./lsp-tool-output.js";
import { LspWorkspaceEditError, type LspWorkspaceEditStore } from "./lsp-workspace-edit.js";

const ProtocolRecordSchema = Type.Record(Type.String(), Type.Any());
const ProtocolStringSchema = Type.String();

const ApplyPreviewArgumentsSchema = Type.Object(
  {
    operation: Type.Literal("apply"),
    preview_id: Type.String({ minLength: 1 }),
    mutation_manifest: Type.Optional(Type.Any()),
  },
  { additionalProperties: true },
);

type ApplyPreviewArguments = Static<typeof ApplyPreviewArgumentsSchema>;

type FileReadOperation =
  | "diagnostics"
  | "document_symbols"
  | "document_links"
  | "folding_ranges"
  | "code_lenses"
  | "document_colors";
type PositionReadOperation =
  | "completion"
  | "hover"
  | "signature_help"
  | "declaration"
  | "goto_definition"
  | "goto_type_definition"
  | "goto_implementation"
  | "find_references"
  | "document_highlights"
  | "call_hierarchy"
  | "incoming_calls"
  | "outgoing_calls"
  | "type_hierarchy"
  | "supertypes"
  | "subtypes"
  | "prepare_rename";
interface FileReadParameters {
  readonly operation: FileReadOperation;
  readonly file_path: string;
  readonly server_id?: string;
}
interface PositionReadParameters {
  readonly operation: PositionReadOperation;
  readonly file_path: string;
  readonly line: number;
  readonly character: number;
  readonly server_id?: string;
  readonly include_declaration?: boolean;
}
/** Public language-server client surface consumed by tool dispatch. */
export interface LspToolServerClient {
  /** Negotiated static capabilities plus supported dynamic registrations. */
  readonly capabilities: LSPAny;
  /** Negotiated protocol character encoding. */
  readonly positionEncoding: PositionEncodingKind;
  /** Report whether one protocol request is currently supported. */
  hasCapability(method: string): boolean;
  /** Open or update one UTF-8 document before a document request. */
  synchronizeDocument(filePath: string, languageId: string): Promise<LspSynchronizedDocument>;
  /** Send one cancellable protocol request. */
  request<TResult>(method: string, parameters: LSPAny, signal?: AbortSignal): Promise<TResult>;
  /** Synchronize and return fresh document diagnostics. */
  documentDiagnostics(
    filePath: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<LspDocumentDiagnosticResult>;
  /** Return pull workspace diagnostics or the cached push fallback. */
  workspaceDiagnostics(signal?: AbortSignal): Promise<LspWorkspaceDiagnosticResult>;
  /** Gracefully shut down the owned server process. */
  shutdown(): Promise<void>;
}

/** Narrow Pi registration surface used to install exactly one LSP tool. */
export interface LspToolRegistrar {
  /** Register the session-bound strict LSP ToolDefinition. */
  registerTool(tool: ToolDefinition<typeof LspToolParametersSchema, LspToolResultDetails>): void;
}

/** Runtime owners used by the single registered Pi LSP tool. */
export interface LspToolDependencies {
  /** Session-scoped lazy language-server registry. */
  readonly manager: LspServerManager<LspToolServerClient>;
  /** Session-scoped Workspace Edit Preview and Validated Workspace Edit store. */
  readonly workspaceEdits: LspWorkspaceEditStore;
  /** Private Result Spill storage for complete truncated output. */
  readonly sessionFiles: LspSessionFiles;
}

interface LspReadValue {
  readonly root_path: string;
  readonly server_id: string;
  readonly value: LSPAny;
}

interface PreparedDocument {
  readonly client: LspToolServerClient;
  readonly document: LspSynchronizedDocument;
  readonly positionEncoding: LspPositionEncoding;
  readonly route: LspServerRoute;
}

function piLspError(message: string): Error {
  return new Error(message.startsWith("Pi LSP:") ? message : `Pi LSP: ${message}`);
}

async function createLspToolOutput(
  text: string,
  details: LspToolResultDetails,
  dependencies: LspToolDependencies,
) {
  const previewRecords = dependencies.workspaceEdits.takeUnreportedPreviewRecords();
  const normalizedPreviewRecords = previewRecords.map((record) =>
    Value.Parse(LspWorkspaceEditPreviewRecordSchema, record),
  );
  const mergedDetails =
    normalizedPreviewRecords.length === 0
      ? details
      : {
          ...details,
          preview_records: [...(details.preview_records ?? []), ...normalizedPreviewRecords],
        };
  const previewNotice =
    previewRecords.length === 0
      ? ""
      : `\n\nServer Workspace Edit Preview${previewRecords.length === 1 ? "" : "s"}: ${previewRecords
          .map(({ preview_id: previewId }) => previewId)
          .join(", ")}`;
  return createBaseLspToolOutput(
    `${text}${previewNotice}`,
    mergedDetails,
    dependencies.sessionFiles,
  );
}

function parseLspToolParameters(input: LSPAny): LspToolParameters {
  try {
    return Value.Parse(LspToolParametersSchema, input);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw piLspError(`invalid tool arguments: ${message}`);
  }
}

function absoluteLspFilePath(filePath: string, context: ExtensionContext): string {
  return resolve(context.cwd, normalizeLspFilePath(filePath));
}

async function prepareLspDocument(
  client: LspToolServerClient,
  route: LspServerRoute,
  filePath: string,
): Promise<PreparedDocument> {
  return {
    client,
    document: await client.synchronizeDocument(filePath, route.language.languageId),
    positionEncoding: normalizeLspPositionEncoding(client.positionEncoding),
    route,
  };
}

function protocolPosition(prepared: PreparedDocument, position: LspCodePointPosition): Position {
  return convertLspCodePointPosition(prepared.document.text, position, prepared.positionEncoding);
}

function serverOutcomeForFailure(failure: LspServerFailure): ServerOperationOutcome {
  let outcome: ServerOperationOutcome["outcome"];
  if (failure.code === "server-unavailable") outcome = "unavailable";
  else if (failure.code === "no-capable-server") outcome = "unsupported";
  else if (failure.message.toLowerCase().includes("timed out")) outcome = "timeout";
  else outcome = "error";
  return { server_id: failure.serverId, outcome, message: failure.message };
}

function operationDetails(
  operation: LspToolParameters["operation"],
  outcomes: readonly ServerOperationOutcome[],
  previewRecords: readonly LSPAny[] = [],
): LspToolResultDetails {
  const details: LSPAny = {
    kind: "operation",
    operation,
    server_outcomes: [...outcomes],
  };
  if (previewRecords.length > 0) details.preview_records = previewRecords;
  return details;
}

function requireReadSuccess<T>(result: LspServerReadResult<T>): void {
  if (result.successes.length > 0) return;
  throw piLspError(result.failures.map(({ message }) => message).join("; "));
}

function readOperationValue<T>(result: LspServerReadResult<T>): LspReadValue[] {
  return result.successes.map((success) => ({
    root_path: success.rootPath,
    server_id: success.serverId,
    value: success.value,
  }));
}

function readOperationOutcomes<T>(result: LspServerReadResult<T>): ServerOperationOutcome[] {
  return [
    ...result.successes.map(({ serverId }): ServerOperationOutcome => ({
      server_id: serverId,
      outcome: "success",
    })),
    ...result.failures.map(serverOutcomeForFailure),
  ];
}

function protocolRecord(value: LSPAny): Record<string, LSPAny> | undefined {
  return Value.Check(ProtocolRecordSchema, value) ? value : undefined;
}

function protocolPositionValue(value: LSPAny): Position | undefined {
  const record = protocolRecord(value);
  if (
    record === undefined ||
    !Number.isSafeInteger(record.line) ||
    !Number.isSafeInteger(record.character) ||
    Object.keys(record).some((key) => key !== "line" && key !== "character")
  ) {
    return undefined;
  }
  return { line: record.line, character: record.character };
}

async function textForProtocolUri(uri: string): Promise<string | undefined> {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(fileURLToPath(uri)),
    );
  } catch {
    return undefined;
  }
}

async function normalizeProtocolResult(
  value: LSPAny,
  prepared: PreparedDocument | undefined,
  inheritedText?: string,
  inheritedEncoding?: LspPositionEncoding,
): Promise<LSPAny> {
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((entry) =>
        normalizeProtocolResult(entry, prepared, inheritedText, inheritedEncoding),
      ),
    );
  }
  if (value instanceof Map) {
    return Promise.all(
      [...value.entries()]
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
        .map(async ([key, entryValue]) => ({
          uri: key,
          value: await normalizeProtocolResult(
            entryValue,
            prepared,
            await textForProtocolUri(key),
            inheritedEncoding,
          ),
        })),
    );
  }

  const position = protocolPositionValue(value);
  const text = inheritedText ?? prepared?.document.text;
  const positionEncoding = inheritedEncoding ?? prepared?.positionEncoding;
  if (position !== undefined && text !== undefined && positionEncoding !== undefined) {
    return convertLspProtocolPosition(text, position, positionEncoding);
  }

  const record = protocolRecord(value);
  if (record === undefined) return value;
  const uriValue = Value.Check(ProtocolStringSchema, record.uri) ? record.uri : undefined;
  const targetUriValue = Value.Check(ProtocolStringSchema, record.targetUri)
    ? record.targetUri
    : undefined;
  const sourceText = inheritedText ?? prepared?.document.text;
  const uriText = uriValue === undefined ? undefined : await textForProtocolUri(uriValue);
  const targetText =
    targetUriValue === undefined ? undefined : await textForProtocolUri(targetUriValue);
  const localText = uriText ?? targetText ?? sourceText;
  const entries = await Promise.all(
    Object.entries(record).map(async ([key, entryValue]) => {
      if ((key === "uri" || key === "targetUri") && Value.Check(ProtocolStringSchema, entryValue)) {
        return [
          key,
          entryValue.startsWith("file:") ? fileURLToPath(entryValue) : entryValue,
        ] as const;
      }
      return [
        key,
        await normalizeProtocolResult(
          entryValue,
          prepared,
          targetUriValue !== undefined && key === "originSelectionRange"
            ? sourceText
            : targetUriValue !== undefined &&
                (key === "targetRange" || key === "targetSelectionRange")
              ? targetText
              : localText,
          positionEncoding,
        ),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function requestDocumentMethod(
  prepared: PreparedDocument,
  method: string,
  parameters: LSPAny,
  signal: AbortSignal | undefined,
): Promise<LSPAny> {
  return prepared.client.request<LSPAny>(method, parameters, signal);
}

function supportsResolveProvider(value: LSPAny): boolean {
  return protocolRecord(value)?.resolveProvider === true;
}

async function resolveProtocolItems(
  client: LspToolServerClient,
  value: LSPAny,
  method: string,
  signal: AbortSignal | undefined,
): Promise<LSPAny> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => client.request<LSPAny>(method, item, signal)));
  }
  const record = protocolRecord(value);
  if (record === undefined || !Array.isArray(record.items)) return value;
  return {
    ...record,
    items: await Promise.all(
      record.items.map((item: LSPAny) => client.request<LSPAny>(method, item, signal)),
    ),
  };
}

async function resolveCodeActionItems(
  client: LspToolServerClient,
  actions: LSPAny,
  signal: AbortSignal | undefined,
): Promise<LSPAny> {
  if (!Array.isArray(actions)) return actions;
  return Promise.all(
    actions.map((action) => {
      const record = protocolRecord(action);
      return record !== undefined && Value.Check(ProtocolStringSchema, record.command)
        ? action
        : client.request<LSPAny>(CodeActionResolveRequest.method, action, signal);
    }),
  );
}

function formattingOptions(
  parameters: Extract<
    LspToolParameters,
    { operation: "format_document" | "format_range" | "format_on_type" }
  >,
): LSPAny {
  return {
    tabSize: parameters.tab_size,
    insertSpaces: parameters.insert_spaces,
    trimTrailingWhitespace: parameters.trim_trailing_whitespace,
    insertFinalNewline: parameters.insert_final_newline,
    trimFinalNewlines: parameters.trim_final_newlines,
  };
}

function workspaceEditFromTextEdits(uri: string, edits: LSPAny): WorkspaceEdit {
  return { changes: { [uri]: Array.isArray(edits) ? edits : [] } };
}

function storeManifestEntries(manifest: LSPAny): readonly LSPAny[] {
  if (Array.isArray(manifest)) return manifest;
  const record = protocolRecord(manifest);
  if (record !== undefined && Array.isArray(record.entries)) return record.entries;
  throw piLspError("Workspace Edit Preview returned an invalid Mutation Manifest");
}

function normalizeStoreMutationManifest(manifest: LSPAny): MutationManifest {
  const entries = storeManifestEntries(manifest).map((entry) => {
    const record = protocolRecord(entry);
    if (record === undefined) throw piLspError("Mutation Manifest contains an invalid entry");
    if (record.operation === "rename") {
      return {
        operation: "rename",
        path: record.path,
        destination_path: record.destination_path ?? record.to,
      };
    }
    return { operation: record.operation, path: record.path };
  });
  try {
    return Value.Parse(MutationManifestSchema, entries);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw piLspError(`invalid canonical Mutation Manifest: ${message}`);
  }
}

function sameMutationManifest(left: MutationManifest, right: MutationManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function workspacePreviewOutput(
  dependencies: LspToolDependencies,
  operation: "format_document" | "format_range" | "format_on_type" | "rename" | "code_actions",
  serverId: string,
  edit: WorkspaceEdit,
  positionEncoding: PositionEncodingKind,
): Promise<
  ReturnType<typeof createLspToolOutput> extends Promise<infer TResult> ? TResult : never
> {
  const preview = await dependencies.workspaceEdits.createPreview({
    edit,
    serverId,
    positionEncoding,
  });
  dependencies.workspaceEdits.markPreviewReported(preview.preview_id);
  const manifest = normalizeStoreMutationManifest(
    dependencies.workspaceEdits.prepareMutationManifest(preview.preview_id),
  );
  const details: LSPAny = {
    kind: "workspace_edit_preview",
    preview_id: preview.preview_id,
    operation,
    summary: preview.summary,
    mutation_manifest: manifest,
    preview_record: preview,
    state: "available",
  };
  return createLspToolOutput(
    `Workspace Edit Preview ${preview.preview_id}\n${preview.summary}`,
    details,
    dependencies,
  );
}

async function executePositionRead(
  dependencies: LspToolDependencies,
  parameters: PositionReadParameters,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<LSPAny>> {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  const methodByOperation = {
    completion: CompletionRequest.method,
    hover: HoverRequest.method,
    signature_help: SignatureHelpRequest.method,
    declaration: DeclarationRequest.method,
    goto_definition: DefinitionRequest.method,
    goto_type_definition: TypeDefinitionRequest.method,
    goto_implementation: ImplementationRequest.method,
    find_references: ReferencesRequest.method,
    document_highlights: DocumentHighlightRequest.method,
    call_hierarchy: CallHierarchyPrepareRequest.method,
    incoming_calls: CallHierarchyPrepareRequest.method,
    outgoing_calls: CallHierarchyPrepareRequest.method,
    type_hierarchy: TypeHierarchyPrepareRequest.method,
    supertypes: TypeHierarchyPrepareRequest.method,
    subtypes: TypeHierarchyPrepareRequest.method,
    prepare_rename: PrepareRenameRequest.method,
  } as const;
  const capabilityMethod = methodByOperation[parameters.operation];
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    (client) => client.hasCapability(capabilityMethod),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      const position = protocolPosition(prepared, {
        line: parameters.line,
        character: parameters.character,
      });
      const textDocument = { uri: prepared.document.uri };
      let requestParameters: LSPAny = { textDocument, position };
      if (parameters.operation === "find_references") {
        requestParameters = {
          ...requestParameters,
          context: { includeDeclaration: parameters.include_declaration ?? true },
        };
      }
      let value = await requestDocumentMethod(
        prepared,
        capabilityMethod,
        requestParameters,
        signal,
      );

      if (
        parameters.operation === "incoming_calls" ||
        parameters.operation === "outgoing_calls" ||
        parameters.operation === "supertypes" ||
        parameters.operation === "subtypes"
      ) {
        const followupMethod =
          parameters.operation === "incoming_calls"
            ? CallHierarchyIncomingCallsRequest.method
            : parameters.operation === "outgoing_calls"
              ? CallHierarchyOutgoingCallsRequest.method
              : parameters.operation === "supertypes"
                ? TypeHierarchySupertypesRequest.method
                : TypeHierarchySubtypesRequest.method;
        const preparedItems = Array.isArray(value) ? value : [];
        value = (
          await Promise.all(
            preparedItems.map((item) => client.request<LSPAny>(followupMethod, { item }, signal)),
          )
        ).flat();
      } else if (
        parameters.operation === "completion" &&
        supportsResolveProvider(client.capabilities.completionProvider)
      ) {
        value = await resolveProtocolItems(client, value, CompletionResolveRequest.method, signal);
      }

      return normalizeProtocolResult(value, prepared);
    },
  );
}

async function executeFileRead(
  dependencies: LspToolDependencies,
  parameters: FileReadParameters,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<LSPAny>> {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  const methodByOperation = {
    diagnostics: "diagnostics",
    document_symbols: DocumentSymbolRequest.method,
    document_links: DocumentLinkRequest.method,
    folding_ranges: FoldingRangeRequest.method,
    code_lenses: CodeLensRequest.method,
    document_colors: DocumentColorRequest.method,
  } as const;
  const method = methodByOperation[parameters.operation];
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    (client) => method === "diagnostics" || client.hasCapability(method),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      if (parameters.operation === "diagnostics") {
        return normalizeProtocolResult(
          await client.documentDiagnostics(filePath, route.language.languageId, signal),
          prepared,
        );
      }
      let value = await client.request<LSPAny>(
        method,
        { textDocument: { uri: prepared.document.uri } },
        signal,
      );
      if (
        parameters.operation === "document_links" &&
        supportsResolveProvider(client.capabilities.documentLinkProvider)
      ) {
        value = await resolveProtocolItems(
          client,
          value,
          DocumentLinkResolveRequest.method,
          signal,
        );
      } else if (
        parameters.operation === "code_lenses" &&
        supportsResolveProvider(client.capabilities.codeLensProvider)
      ) {
        value = await resolveProtocolItems(client, value, CodeLensResolveRequest.method, signal);
      }
      return normalizeProtocolResult(value, prepared);
    },
  );
}

async function executeInlayHints(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "inlay_hints" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<LSPAny>> {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    (client) => client.hasCapability(InlayHintRequest.method),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      let value = await client.request<LSPAny>(
        InlayHintRequest.method,
        {
          textDocument: { uri: prepared.document.uri },
          range: {
            start: protocolPosition(prepared, parameters.range.start),
            end: protocolPosition(prepared, parameters.range.end),
          },
        },
        signal,
      );
      if (supportsResolveProvider(client.capabilities.inlayHintProvider)) {
        value = await resolveProtocolItems(client, value, InlayHintResolveRequest.method, signal);
      }
      return normalizeProtocolResult(value, prepared);
    },
  );
}

async function executeSelectionRanges(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "selection_ranges" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<LSPAny>> {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    (client) => client.hasCapability(SelectionRangeRequest.method),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      const value = await client.request<LSPAny>(
        SelectionRangeRequest.method,
        {
          textDocument: { uri: prepared.document.uri },
          positions: parameters.positions.map((position) => protocolPosition(prepared, position)),
        },
        signal,
      );
      return normalizeProtocolResult(value, prepared);
    },
  );
}

async function executeWorkspaceRead(
  dependencies: LspToolDependencies,
  parameters: Extract<
    LspToolParameters,
    { operation: "workspace_diagnostics" | "workspace_symbols" }
  >,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<LSPAny>> {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  if (parameters.operation === "workspace_diagnostics") {
    return dependencies.manager.runRead(
      filePath,
      parameters.server_id,
      () => true,
      async (client) =>
        normalizeProtocolResult(
          await client.workspaceDiagnostics(signal),
          undefined,
          undefined,
          normalizeLspPositionEncoding(client.positionEncoding),
        ),
    );
  }
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    (client) => client.hasCapability(WorkspaceSymbolRequest.method),
    async (client) => {
      let value = await client.request<LSPAny>(
        WorkspaceSymbolRequest.method,
        { query: parameters.query },
        signal,
      );
      if (supportsResolveProvider(client.capabilities.workspaceSymbolProvider)) {
        value = await resolveProtocolItems(
          client,
          value,
          WorkspaceSymbolResolveRequest.method,
          signal,
        );
      }
      return normalizeProtocolResult(
        value,
        undefined,
        undefined,
        normalizeLspPositionEncoding(client.positionEncoding),
      );
    },
  );
}

async function executeFormattingPreview(
  dependencies: LspToolDependencies,
  parameters: Extract<
    LspToolParameters,
    { operation: "format_document" | "format_range" | "format_on_type" }
  >,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  const method =
    parameters.operation === "format_document"
      ? DocumentFormattingRequest.method
      : parameters.operation === "format_range"
        ? DocumentRangeFormattingRequest.method
        : DocumentOnTypeFormattingRequest.method;
  const resolution = await dependencies.manager.resolveMutationClient(
    filePath,
    parameters.server_id,
    (client) => client.hasCapability(method),
  );
  if (resolution.kind === "failure") throw piLspError(resolution.failure.message);
  const { client, route } = resolution.instance;
  const prepared = await prepareLspDocument(client, route, filePath);
  const requestBase = {
    textDocument: { uri: prepared.document.uri },
    options: formattingOptions(parameters),
  };
  const requestParameters =
    parameters.operation === "format_range"
      ? {
          ...requestBase,
          range: {
            start: protocolPosition(prepared, parameters.range.start),
            end: protocolPosition(prepared, parameters.range.end),
          },
        }
      : parameters.operation === "format_on_type"
        ? {
            ...requestBase,
            position: protocolPosition(prepared, parameters),
            ch: parameters.trigger_character,
          }
        : requestBase;
  const edits = await client.request<LSPAny>(method, requestParameters, signal);
  return workspacePreviewOutput(
    dependencies,
    parameters.operation,
    route.serverId,
    workspaceEditFromTextEdits(prepared.document.uri, edits),
    client.positionEncoding,
  );
}

async function executeRenamePreview(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "rename" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  const resolution = await dependencies.manager.resolveMutationClient(
    filePath,
    parameters.server_id,
    (client) => client.hasCapability(RenameRequest.method),
  );
  if (resolution.kind === "failure") throw piLspError(resolution.failure.message);
  const { client, route } = resolution.instance;
  const prepared = await prepareLspDocument(client, route, filePath);
  const edit = await client.request<WorkspaceEdit | null>(
    RenameRequest.method,
    {
      textDocument: { uri: prepared.document.uri },
      position: protocolPosition(prepared, parameters),
      newName: parameters.new_name,
    },
    signal,
  );
  if (edit === null) throw piLspError("rename returned no Workspace Edit Preview");
  return workspacePreviewOutput(
    dependencies,
    "rename",
    route.serverId,
    edit,
    client.positionEncoding,
  );
}

async function executeCodeActions(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "code_actions" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  const resolution = await dependencies.manager.resolveMutationClient(
    filePath,
    parameters.server_id,
    (client) => client.hasCapability(CodeActionRequest.method),
  );
  if (resolution.kind === "failure") throw piLspError(resolution.failure.message);
  const { client, route } = resolution.instance;
  const prepared = await prepareLspDocument(client, route, filePath);
  let actions = await client.request<LSPAny>(
    CodeActionRequest.method,
    {
      textDocument: { uri: prepared.document.uri },
      range: {
        start: protocolPosition(prepared, parameters.range.start),
        end: protocolPosition(prepared, parameters.range.end),
      },
      context: {
        diagnostics: [],
        only: parameters.only_kinds,
      },
    },
    signal,
  );
  if (supportsResolveProvider(client.capabilities.codeActionProvider)) {
    actions = await resolveCodeActionItems(client, actions, signal);
  }
  const results: LSPAny[] = [];
  const previewRecords: LSPAny[] = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    const record = protocolRecord(action);
    if (record === undefined) continue;
    if (record.command !== undefined || record.edit === undefined) {
      results.push({
        applicable: false,
        command: record.command,
        kind: record.kind,
        title: record.title,
      });
      continue;
    }
    const preview = await dependencies.workspaceEdits.createPreview({
      edit: record.edit,
      serverId: route.serverId,
      positionEncoding: client.positionEncoding,
    });
    dependencies.workspaceEdits.markPreviewReported(preview.preview_id);
    previewRecords.push(preview);
    results.push({
      applicable: true,
      kind: record.kind,
      mutation_manifest: normalizeStoreMutationManifest(
        dependencies.workspaceEdits.prepareMutationManifest(preview.preview_id),
      ),
      preview_id: preview.preview_id,
      summary: preview.summary,
      title: record.title,
    });
  }
  const details = operationDetails(
    "code_actions",
    [{ server_id: route.serverId, outcome: "success" }],
    previewRecords,
  );
  return createLspToolOutput(formatLspToolValue(results), details, dependencies);
}

async function executeApplyPreview(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "apply" }>,
  signal: AbortSignal | undefined,
) {
  const storeManifest = dependencies.workspaceEdits.prepareMutationManifest(parameters.preview_id);
  const canonicalManifest = normalizeStoreMutationManifest(storeManifest);
  if (
    parameters.mutation_manifest === undefined ||
    !sameMutationManifest(parameters.mutation_manifest, canonicalManifest)
  ) {
    throw piLspError("Mutation Manifest changed after argument preparation");
  }
  let result;
  try {
    result = await dependencies.workspaceEdits.applyPreview(
      parameters.preview_id,
      storeManifest,
      signal,
    );
  } catch (cause) {
    if (
      !(cause instanceof LspWorkspaceEditError) ||
      cause.code !== "workspace_edit_recovery_failed"
    ) {
      throw cause;
    }
    return createLspToolOutput(
      cause.message,
      {
        kind: "workspace_edit_apply",
        preview_id: parameters.preview_id,
        mutation_manifest: canonicalManifest,
        changed_paths: [...cause.recoveryFailures].sort((left, right) => left.localeCompare(right)),
        recovery_failure_paths: [...cause.recoveryFailures],
        state: "partial_failure",
      },
      dependencies,
    );
  }
  const record = protocolRecord(result) ?? {};
  const movedFiles = Array.isArray(record.moved_files) ? record.moved_files : [];
  const changedPaths = [
    ...(Array.isArray(record.changed_files) ? record.changed_files : []),
    ...(Array.isArray(record.created_files) ? record.created_files : []),
    ...(Array.isArray(record.deleted_files) ? record.deleted_files : []),
    ...movedFiles.flatMap((move: LSPAny) => {
      const moveRecord = protocolRecord(move);
      return moveRecord === undefined ? [] : [moveRecord.from, moveRecord.to];
    }),
  ].filter((path): path is string => Value.Check(ProtocolStringSchema, path));
  const details: LSPAny = {
    kind: "workspace_edit_apply",
    preview_id: parameters.preview_id,
    mutation_manifest: canonicalManifest,
    changed_paths: [...new Set(changedPaths)].sort((left, right) => left.localeCompare(right)),
    state: record.state === "partial_failure" ? "partial_failure" : "applied",
  };
  return createLspToolOutput(formatLspToolValue(result), details, dependencies);
}

/** Create the single strict Pi LSP ToolDefinition bound to one session's runtime owners. */
export function createLspToolDefinition(
  dependencies: LspToolDependencies,
): ToolDefinition<typeof LspToolParametersSchema, LspToolResultDetails> {
  return {
    name: "lsp",
    label: "LSP",
    description:
      "Query configured language servers and create/apply guarded Workspace Edit Previews. All paths accept an optional leading @. Lines and characters are one-based Unicode code points. Output is limited to 2,000 lines or 50 KB; complete truncated output is saved as a Result Spill.",
    promptSnippet: "Query configured language servers and preview guarded LSP mutations",
    promptGuidelines: [
      "Use lsp read operations for semantic source navigation and diagnostics; use preview-producing lsp operations followed by lsp apply for language-server mutations.",
    ],
    parameters: LspToolParametersSchema,
    prepareArguments(argumentsValue) {
      if (!Value.Check(ApplyPreviewArgumentsSchema, argumentsValue)) {
        return parseLspToolParameters(argumentsValue);
      }
      const applyArguments: ApplyPreviewArguments = argumentsValue;
      const storeManifest = dependencies.workspaceEdits.prepareMutationManifest(
        applyArguments.preview_id,
      );
      return parseLspToolParameters({
        ...applyArguments,
        mutation_manifest: normalizeStoreMutationManifest(storeManifest),
      });
    },
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      const parameters = parseLspToolParameters(input);
      switch (parameters.operation) {
        case "status": {
          const status = dependencies.manager.getStatus();
          const outcomes = status.servers.map((server): ServerOperationOutcome => {
            const outcome: ServerOperationOutcome = {
              server_id: server.serverId,
              outcome: server.state === "unavailable" ? "unavailable" : "success",
            };
            if (server.error === undefined) return outcome;
            return { ...outcome, message: server.error };
          });
          return createLspToolOutput(
            formatLspToolValue(status),
            operationDetails("status", outcomes),
            dependencies,
          );
        }
        case "capabilities":
        case "restart": {
          const filePath = absoluteLspFilePath(parameters.file_path, context);
          const resolution =
            parameters.operation === "capabilities"
              ? await dependencies.manager.getCapabilities(parameters.server_id, filePath)
              : await dependencies.manager.restartServer(parameters.server_id, filePath);
          if (resolution.kind === "failure") throw piLspError(resolution.failure.message);
          return createLspToolOutput(
            formatLspToolValue({
              capabilities: resolution.instance.client.capabilities,
              root_path: resolution.instance.route.rootPath,
              server_id: resolution.instance.route.serverId,
            }),
            operationDetails(parameters.operation, [
              { server_id: resolution.instance.route.serverId, outcome: "success" },
            ]),
            dependencies,
          );
        }
        case "completion":
        case "hover":
        case "signature_help":
        case "declaration":
        case "goto_definition":
        case "goto_type_definition":
        case "goto_implementation":
        case "find_references":
        case "document_highlights":
        case "call_hierarchy":
        case "incoming_calls":
        case "outgoing_calls":
        case "type_hierarchy":
        case "supertypes":
        case "subtypes":
        case "prepare_rename": {
          const result = await executePositionRead(dependencies, parameters, context, signal);
          requireReadSuccess(result);
          return createLspToolOutput(
            formatLspToolValue({
              results: readOperationValue(result),
              warnings: result.failures.map(({ message }) => message),
            }),
            operationDetails(parameters.operation, readOperationOutcomes(result)),
            dependencies,
          );
        }
        case "diagnostics":
        case "document_symbols":
        case "document_links":
        case "folding_ranges":
        case "code_lenses":
        case "document_colors": {
          const result = await executeFileRead(dependencies, parameters, context, signal);
          requireReadSuccess(result);
          return createLspToolOutput(
            formatLspToolValue({
              results: readOperationValue(result),
              warnings: result.failures.map(({ message }) => message),
            }),
            operationDetails(parameters.operation, readOperationOutcomes(result)),
            dependencies,
          );
        }
        case "workspace_diagnostics":
        case "workspace_symbols": {
          const result = await executeWorkspaceRead(dependencies, parameters, context, signal);
          requireReadSuccess(result);
          return createLspToolOutput(
            formatLspToolValue({
              results: readOperationValue(result),
              warnings: result.failures.map(({ message }) => message),
            }),
            operationDetails(parameters.operation, readOperationOutcomes(result)),
            dependencies,
          );
        }
        case "selection_ranges": {
          const result = await executeSelectionRanges(dependencies, parameters, context, signal);
          requireReadSuccess(result);
          return createLspToolOutput(
            formatLspToolValue({
              results: readOperationValue(result),
              warnings: result.failures.map(({ message }) => message),
            }),
            operationDetails(parameters.operation, readOperationOutcomes(result)),
            dependencies,
          );
        }
        case "inlay_hints": {
          const result = await executeInlayHints(dependencies, parameters, context, signal);
          requireReadSuccess(result);
          return createLspToolOutput(
            formatLspToolValue({
              results: readOperationValue(result),
              warnings: result.failures.map(({ message }) => message),
            }),
            operationDetails(parameters.operation, readOperationOutcomes(result)),
            dependencies,
          );
        }
        case "format_document":
        case "format_range":
        case "format_on_type":
          return executeFormattingPreview(dependencies, parameters, context, signal);
        case "rename":
          return executeRenamePreview(dependencies, parameters, context, signal);
        case "code_actions":
          return executeCodeActions(dependencies, parameters, context, signal);
        case "apply":
          return executeApplyPreview(dependencies, parameters, signal);
      }
    },
  };
}

/** Register exactly one strict `lsp` tool for the current Pi extension session. */
export function registerLspTool(pi: LspToolRegistrar, dependencies: LspToolDependencies): void {
  pi.registerTool(createLspToolDefinition(dependencies));
}
