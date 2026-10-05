import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolAnnotations,
  ToolDefinition,
  ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
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
  DocumentDiagnosticRequest,
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
  WorkspaceDiagnosticRequest,
  WorkspaceSymbolRequest,
  WorkspaceSymbolResolveRequest,
  Position,
  type Diagnostic,
  type Range,
  type ReferenceParams,
  type ServerCapabilities,
  type TextDocumentPositionParams,
} from "vscode-languageserver-protocol/node";
import { LspInputError } from "./lsp-input-error.js";
import {
  boundLspCompletions,
  boundLspWorkspaceSymbols,
  completionPrefixAt,
  formatLspItemListText,
  type LspBoundedItems,
} from "./lsp-item-list.js";
import {
  formatLspLocationReadText,
  isLspLocationOperation,
  lspDisplayPath,
} from "./lsp-location-text.js";
import { formatLspStructureReadText, isLspStructureOperation } from "./lsp-structure-text.js";
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
  type LspCapabilityRequirement,
  type LspServerFailure,
  type LspServerFailureCode,
  type LspServerLanguage,
  type LspServerManager,
  type LspServerReadResult,
  type LspServerRoute,
} from "./lsp-server-manager.js";
import {
  describeLspQueryPosition,
  isLspPositionReadOperation,
  lspEmptyPositionReadMessage,
  lspQueryPosition,
  type LspQueryPosition,
} from "./lsp-query-position.js";
import type { LspSessionFiles } from "./lsp-session-files.js";
import {
  DEFAULT_LSP_ITEM_LIMIT,
  LSP_OPERATION_NAMES,
  LspApplyOutputSchema,
  LspCodeActionsOutputSchema,
  LspOperationParametersSchemas,
  LspPositionReadOutputSchema,
  LspPreviewOutputSchema,
  LspReadOutputSchema,
  LspServerOutputSchema,
  LspStatusOutputSchema,
  LspWorkspaceEditPreviewRecordSchema,
  MutationManifestSchema,
  lspToolName,
  type LspOperationName,
  type LspOperationParameters,
  type LspToolParameters,
  type LspToolResultDetails,
  type LspWorkspaceEditPreviewRecord,
  type MutationManifest,
  type ServerOperationOutcome,
} from "./lsp-tool-contract.js";
import {
  createLspToolOutput as createBaseLspToolOutput,
  formatLspToolValue,
  lspStructuredFields,
  lspStructuredValue,
  type LspStructuredFields,
} from "./lsp-tool-output.js";
import {
  humanizeLspOperation,
  renderLspToolCall,
  renderLspToolResult,
  semanticLspValueCount,
} from "./lsp-tool-rendering.js";
import {
  LspWorkspaceEditError,
  NO_CHANGES_SUMMARY,
  type LspMutationManifest,
  type LspWorkspaceEditStore,
} from "./lsp-workspace-edit.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

const ProtocolRecordSchema = Type.Record(Type.String(), Type.Unknown());
const ProtocolStringSchema = Type.String();
const ProtocolFoldingRangeSchema = Type.Object(
  {
    startLine: Type.Integer({ minimum: 0 }),
    startCharacter: Type.Optional(Type.Integer({ minimum: 0 })),
    endLine: Type.Integer({ minimum: 0 }),
    endCharacter: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);

/** The `lsp_workspace_diagnostics` value of a server that publishes no workspace diagnostics. */
const UnpublishedWorkspaceDiagnosticsSchema = Type.Object({
  status: Type.Literal("unsupported"),
  message: Type.String({ minLength: 1 }),
});

const ApplyPreviewArgumentsSchema = Type.Object(
  {
    preview_id: Type.String({ minLength: 1 }),
    mutation_manifest: Type.Optional(Type.Unknown()),
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
  readonly capabilities: ServerCapabilities;
  /** Negotiated protocol character encoding. */
  readonly positionEncoding: PositionEncodingKind;
  /** Report whether one protocol request is currently supported. */
  hasCapability(method: string): boolean;
  /** Open or update one UTF-8 document before a document request. */
  synchronizeDocument(filePath: string, languageId: string): Promise<LspSynchronizedDocument>;
  /** Send one cancellable protocol request. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- The dynamic protocol transport establishes no payload fields; dispatch validates fields only where consumed.
  request(method: string, parameters: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Synchronize and return fresh document diagnostics. */
  documentDiagnostics(
    filePath: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<LspDocumentDiagnosticResult>;
  /** Return LSP Diagnostics for a synchronized document version, cached when possible. */
  currentDocumentDiagnostics(
    document: LspSynchronizedDocument,
    signal?: AbortSignal,
  ): Promise<readonly Diagnostic[]>;
  /** Return pull workspace diagnostics or the cached push fallback. */
  workspaceDiagnostics(signal?: AbortSignal): Promise<LspWorkspaceDiagnosticResult>;
  /** Gracefully shut down the owned server process. */
  shutdown(): Promise<void>;
}

/** Narrow Pi registration surface used to install the LSP tools. */
export interface LspToolRegistrar {
  /** Register one session-bound strict LSP ToolDefinition. */
  registerTool<TParams extends TSchema>(tool: ToolDefinition<TParams, LspToolResultDetails>): void;
}

/** Runtime owners shared by every registered Pi LSP tool. */
export interface LspToolDependencies {
  /** Session-scoped lazy language-server registry. */
  readonly manager: LspServerManager<LspToolServerClient>;
  /** Session-scoped Workspace Edit Preview and Validated Workspace Edit store. */
  readonly workspaceEdits: LspWorkspaceEditStore;
  /** Private Result Spill storage for complete truncated output. */
  readonly sessionFiles: LspSessionFiles;
}

/** The registered ToolDefinition of one LSP operation. */
export type LspToolDefinition<TOperation extends LspOperationName = LspOperationName> =
  ToolDefinition<(typeof LspOperationParametersSchemas)[TOperation], LspToolResultDetails>;

interface LspReadValue {
  readonly root_path: string;
  readonly server_id: string;
  readonly value: unknown;
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

/**
 * Failures that are expected outcomes rather than broken servers or configuration: an ambiguous
 * mutation is resolved by supplying `server_id`, and a missing capability is a fact about the
 * server. Neither points to the troubleshooting Skill (ADR-0005).
 */
const EXPECTED_FAILURE_CODES: ReadonlySet<LspServerFailureCode> = new Set([
  "ambiguous-server",
  "no-capable-server",
]);

/**
 * Raise server failures, pointing to the troubleshooting Skill when any is a server startup,
 * crash, timeout, request, or configuration failure.
 */
function piLspFailureError(failures: readonly LspServerFailure[]): Error {
  const message = failures.map((failure) => failure.message).join("; ");
  if (failures.every(({ code }) => EXPECTED_FAILURE_CODES.has(code))) return piLspError(message);
  return piLspError(`${message}\n\n${TROUBLESHOOTING_HINT}`);
}

/** The workspace root one Server Instance searched for a references or rename result. */
interface ServerInstanceScope {
  /** Names the searched root. */
  readonly line: string;
  /** Present when other workspace roots of the same Server Definition exist. */
  readonly warning?: string;
}

/**
 * Disclose the single workspace root a references or rename request searched. Each root of a
 * Server Definition gets its own Server Instance, so files under other roots may be missing.
 */
async function serverInstanceScope(
  dependencies: LspToolDependencies,
  serverId: string,
  rootPath: string,
  cwd: string,
): Promise<ServerInstanceScope> {
  const root = lspDisplayPath(cwd, rootPath);
  const line = `Searched ${serverId} workspace root: ${root}`;
  const others = await dependencies.manager.findOtherWorkspaceRoots(serverId, rootPath);
  if (others.rootPaths.length === 0 && !others.hasMore) return { line };
  const otherRoots =
    others.rootPaths.length === 0
      ? `other ${serverId} workspace roots may exist in directories that were not checked`
      : `other ${serverId} workspace roots exist: ${[
          ...others.rootPaths.map((path) => lspDisplayPath(cwd, path)),
          ...(others.hasMore ? ["and more"] : []),
        ].join(", ")}`;
  return {
    line,
    warning: `${serverId} searched only its workspace root ${root}, but ${otherRoots}. Files outside ${root} may not have been considered; query a file under each other root or search for importers before relying on this result.`,
  };
}

function serverInstanceScopeLines(scopes: readonly ServerInstanceScope[]): string[] {
  return scopes.flatMap(({ line, warning }) =>
    warning === undefined ? [line] : [line, `Warning: ${warning}`],
  );
}

function serverInstanceScopeWarnings(scopes: readonly ServerInstanceScope[]): string[] {
  return scopes.flatMap(({ warning }) => (warning === undefined ? [] : [warning]));
}

/** Require the protocol method an operation sends, naming it in unsupported-operation failures. */
function requireMethod(method: string): LspCapabilityRequirement<LspToolServerClient> {
  return { method, isSupportedBy: (client) => client.hasCapability(method) };
}

/** Every server serves document diagnostics, by pull request or from pushed diagnostics. */
const DOCUMENT_DIAGNOSTICS_CAPABILITY: LspCapabilityRequirement<LspToolServerClient> = {
  method: DocumentDiagnosticRequest.method,
  isSupportedBy: () => true,
};

/**
 * Every server answers workspace diagnostics: by pull request, from cached pushes, or by reporting
 * that it publishes none.
 */
const WORKSPACE_DIAGNOSTICS_CAPABILITY: LspCapabilityRequirement<LspToolServerClient> = {
  method: WorkspaceDiagnosticRequest.method,
  isSupportedBy: () => true,
};

async function createLspToolOutput(
  text: string,
  details: LspToolResultDetails,
  structured: LspStructuredFields,
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
  const structuredWithPreviews =
    previewRecords.length === 0
      ? structured
      : {
          ...structured,
          server_preview_ids: previewRecords.map(({ preview_id: previewId }) => previewId),
        };
  return createBaseLspToolOutput(
    `${text}${previewNotice}`,
    mergedDetails,
    structuredWithPreviews,
    dependencies.sessionFiles,
  );
}

/** What a read's readable model-visible text needs beyond the servers' responses. */
interface ReadTextContext {
  readonly cwd: string;
  /** Absolute path of the queried document or, for workspace reads, the root anchor. */
  readonly documentPath: string;
  /** Requested selection-range positions. */
  readonly positions?: readonly LspCodePointPosition[];
  /** What a position-based query's requested position held. */
  readonly queried?: QueriedPosition | undefined;
}

/** What a position-based query's requested position held, as its result reports it. */
interface QueriedPosition {
  readonly query: LspQueryPosition;
  /** Servers whose hierarchy follow-up found no item at the position to follow. */
  readonly noHierarchyItemServers: ReadonlySet<string>;
}

/**
 * The parts of a read's output that name its queried position: the Structured Result field, the
 * line that opens a result that found something, and the line stating that a server found nothing.
 */
function queriedPositionText(
  operation: LspOperationName,
  queried: QueriedPosition | undefined,
  textContext: ReadTextContext,
  resultCount: number,
) {
  if (queried === undefined || !isLspPositionReadOperation(operation)) return undefined;
  const position = describeLspQueryPosition(textContext.cwd, queried.query);
  return {
    structured: { position: lspStructuredValue(formatLspToolValue(queried.query)) },
    position,
    headline: resultCount === 0 ? [] : [`Query position: ${position}`],
    emptyMessage: (read: { readonly server_id: string }) =>
      lspEmptyPositionReadMessage(
        operation,
        position,
        queried.noHierarchyItemServers.has(read.server_id),
      ),
  };
}

function readTextContext(filePath: string, context: ExtensionContext): ReadTextContext {
  return { cwd: context.cwd, documentPath: absoluteLspFilePath(filePath, context) };
}

/**
 * Return one read's result. The Structured Result is the compact JSON of every server's normalized
 * response; location, symbol, hierarchy, and range reads derive readable model-visible text from
 * the same data (ADR-0003), and other reads show that JSON. References also name each searched
 * workspace root and warn when other roots of the same Server Definition exist. A position-based
 * query also reports its queried position: in the Structured Result, as the opening line of a result
 * that found something, and in the line stating that a server found nothing there.
 */
async function readOutput(
  operation: LspToolParameters["operation"],
  result: Promise<LspServerReadResult<unknown>>,
  dependencies: LspToolDependencies,
  textContext: ReadTextContext,
) {
  const resolved = await result;
  requireReadSuccess(resolved);
  const results = readOperationValue(resolved);
  const failureWarnings = resolved.failures.map(({ message }) => message);
  const scopes =
    operation === "find_references"
      ? await Promise.all(
          resolved.successes.map(({ serverId, rootPath }) =>
            serverInstanceScope(dependencies, serverId, rootPath, textContext.cwd),
          ),
        )
      : [];
  const warnings = [...serverInstanceScopeWarnings(scopes), ...failureWarnings];
  const json = formatLspToolValue({ results, warnings });
  const details = operationDetails(operation, readOperationOutcomes(resolved));
  const resultCount = results.reduce((count, read) => count + semanticLspValueCount(read.value), 0);
  const queried = queriedPositionText(operation, textContext.queried, textContext, resultCount);
  const structured = { ...queried?.structured, ...lspStructuredFields(json) };
  let text: string;
  if (isLspLocationOperation(operation)) {
    text = await formatLspLocationReadText({
      operation,
      cwd: textContext.cwd,
      documentPath: textContext.documentPath,
      reads: results,
      warnings: failureWarnings,
      scope: [...(queried?.headline ?? []), ...serverInstanceScopeLines(scopes)],
      emptyMessage: queried?.emptyMessage,
    });
  } else if (isLspStructureOperation(operation)) {
    text = await formatLspStructureReadText({
      operation,
      cwd: textContext.cwd,
      documentPath: textContext.documentPath,
      reads: results,
      warnings: failureWarnings,
      positions: textContext.positions,
      outgoingCallSitePath: (call) => OUTGOING_CALL_SITE_PATHS.get(call),
      scope: queried?.headline ?? [],
      emptyMessage: queried?.emptyMessage,
    });
  } else if (queried !== undefined) {
    // Other position reads show their JSON under the queried position, or under what was not found.
    const summary =
      resultCount === 0 ? [...new Set(results.map(queried.emptyMessage))] : queried.headline;
    text = [...summary, json].join("\n");
  } else {
    return createLspToolOutput(json, details, structured, dependencies);
  }
  return createLspToolOutput(
    text,
    { ...details, result_count: resultCount },
    structured,
    dependencies,
  );
}

/** One server's answer to a position-based query. */
interface PositionReadValue {
  // oxlint-disable-next-line anti-slop/no-unknown-property-types -- Normalized server responses stay opaque until rendering checks recognized shapes.
  readonly response: unknown;
  /** What the queried position held in the text sent to this server. */
  readonly query: LspQueryPosition;
  /** Whether a hierarchy follow-up found no item at the position to follow. */
  readonly noHierarchyItem: boolean;
}

/**
 * Return a position-based query's result: a read whose output also names what the requested
 * position held, so an off-by-one position is visible.
 */
async function positionReadOutput(
  operation: PositionReadOperation,
  result: Promise<LspServerReadResult<PositionReadValue>>,
  dependencies: LspToolDependencies,
  textContext: ReadTextContext,
) {
  const resolved = await result;
  const [first] = resolved.successes;
  const queried: QueriedPosition | undefined =
    first === undefined
      ? undefined
      : {
          query: first.value.query,
          noHierarchyItemServers: new Set(
            resolved.successes
              .filter(({ value }) => value.noHierarchyItem)
              .map(({ serverId }) => serverId),
          ),
        };
  const reads = {
    failures: resolved.failures,
    successes: resolved.successes.map((success) => ({
      ...success,
      value: success.value.response,
    })),
  };
  return readOutput(operation, Promise.resolve(reads), dependencies, { ...textContext, queried });
}

/**
 * Return a completion or workspace-symbol read. The Structured Result holds each server's bounded
 * response with its prefix and omitted count; the model-visible text lists one line per item
 * derived from the same data (ADR-0003), without server-private resolve data.
 */
async function itemListOutput(
  operation: "completion" | "workspace_symbols",
  result: Promise<LspServerReadResult<BoundedServerItems>>,
  dependencies: LspToolDependencies,
  textContext: ReadTextContext,
) {
  const resolved = await result;
  requireReadSuccess(resolved);
  const results = resolved.successes.map(({ serverId, rootPath, value }) => ({
    root_path: rootPath,
    server_id: serverId,
    value: value.value,
    omitted: value.omitted,
    // Undefined fields are dropped from the serialized result, so symbols carry no prefix.
    prefix: value.prefix,
  }));
  const warnings = resolved.failures.map(({ message }) => message);
  const json = formatLspToolValue({ results, warnings });
  const resultCount = results.reduce((count, read) => count + semanticLspValueCount(read.value), 0);
  const query = resolved.successes[0]?.value.query;
  const queried = queriedPositionText(
    operation,
    query === undefined ? undefined : { query, noHierarchyItemServers: new Set() },
    textContext,
    resultCount,
  );
  const text = await formatLspItemListText({
    operation,
    cwd: textContext.cwd,
    documentPath: textContext.documentPath,
    reads: results,
    warnings,
    scope: queried?.headline ?? [],
    position: queried?.position,
  });
  return createLspToolOutput(
    text,
    { ...operationDetails(operation, readOperationOutcomes(resolved)), result_count: resultCount },
    { ...queried?.structured, ...lspStructuredFields(json) },
    dependencies,
  );
}

function parseLspOperationParameters<TOperation extends LspOperationName>(
  operation: TOperation,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Tool arguments are validated by the operation's strict parameter schema at this ingress.
  input: unknown,
): LspOperationParameters<TOperation> {
  try {
    return Value.Parse(LspOperationParametersSchemas[operation], input);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw piLspError(`invalid tool arguments: ${message}`);
  }
}

function lspOperationCall<TOperation extends LspOperationName>(
  operation: TOperation,
  parameters: LspOperationParameters<TOperation>,
): LspToolParameters {
  // SAFETY: `parameters` was parsed by the strict schema of exactly `operation`, so the pair is the matching LspToolParameters member; TypeScript cannot correlate the generic key with the union.
  return { operation, ...parameters } as LspToolParameters;
}

function absoluteLspFilePath(filePath: string, context: ExtensionContext): string {
  return resolve(context.cwd, normalizeLspFilePath(filePath));
}

/**
 * Resolve the path of a document an operation opens, rejecting a missing file or a directory as an
 * input error before any server is routed or started.
 */
async function documentFilePath(filePath: string, context: ExtensionContext): Promise<string> {
  const absolutePath = absoluteLspFilePath(filePath, context);
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") {
        throw new LspInputError(`file not found: ${absolutePath}`);
      }
    }
    throw cause;
  }
  if (stats.isDirectory()) throw new LspInputError(`${absolutePath} is a directory, not a file`);
  return absolutePath;
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
  previewRecords: readonly LspWorkspaceEditPreviewRecord[] = [],
): Extract<LspToolResultDetails, { kind: "operation" }> {
  const details: Extract<LspToolResultDetails, { kind: "operation" }> = {
    kind: "operation",
    operation,
    server_outcomes: [...outcomes],
  };
  if (previewRecords.length > 0) details.preview_records = [...previewRecords];
  return details;
}

function requireReadSuccess<T>(result: LspServerReadResult<T>): void {
  if (result.successes.length > 0) return;
  throw piLspFailureError(result.failures);
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
    ...result.successes.map(({ serverId, value }): ServerOperationOutcome => {
      // A server that publishes no workspace diagnostics answered, but not with diagnostics.
      if (Value.Check(UnpublishedWorkspaceDiagnosticsSchema, value)) {
        return { server_id: serverId, outcome: "unsupported", message: value.message };
      }
      return { server_id: serverId, outcome: "success" };
    }),
    ...result.failures.map(serverOutcomeForFailure),
  ];
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Protocol records retain unknown fields; consumers validate each inspected value rather than promising a complete response type.
function protocolRecord(value: unknown): Record<string, unknown> | undefined {
  return Value.Check(ProtocolRecordSchema, value) ? value : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only validated, exact position objects are rewritten during protocol output normalization.
function protocolPositionValue(value: unknown): Position | undefined {
  if (
    !Position.is(value) ||
    !Number.isSafeInteger(value.line) ||
    !Number.isSafeInteger(value.character) ||
    Object.keys(value).some((key) => key !== "line" && key !== "character")
  ) {
    return undefined;
  }
  return { line: value.line, character: value.character };
}

function normalizeProtocolFoldingRange(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The folding-range schema validates every coordinate consumed by this normalizer.
  value: unknown,
  text: string,
  encoding: LspPositionEncoding,
) {
  if (!Value.Check(ProtocolFoldingRangeSchema, value)) return undefined;
  const start = convertLspProtocolPosition(
    text,
    { line: value.startLine, character: value.startCharacter ?? 0 },
    encoding,
  );
  const end = convertLspProtocolPosition(
    text,
    { line: value.endLine, character: value.endCharacter ?? 0 },
    encoding,
  );
  const normalized = {
    ...value,
    startLine: start.line,
    endLine: end.line,
  };
  if (value.startCharacter !== undefined && value.endCharacter !== undefined) {
    return { ...normalized, startCharacter: start.character, endCharacter: end.character };
  }
  if (value.startCharacter !== undefined) {
    return { ...normalized, startCharacter: start.character };
  }
  if (value.endCharacter !== undefined) return { ...normalized, endCharacter: end.character };
  return normalized;
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recursive protocol values are opaque except for locally validated positions, ranges, and URI fields.
  value: unknown,
  prepared: PreparedDocument | undefined,
  inheritedText?: string,
  inheritedEncoding?: LspPositionEncoding,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Normalization preserves dynamic payloads without claiming a method-specific result type.
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((entry) =>
        normalizeProtocolResult(entry, prepared, inheritedText, inheritedEncoding),
      ),
    );
  }
  if (value instanceof Map) {
    const entries: [unknown, unknown][] = [...value.entries()];
    return Promise.all(
      entries
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
        .map(async ([key, entryValue]) => ({
          uri:
            Value.Check(ProtocolStringSchema, key) && key.startsWith("file:")
              ? fileURLToPath(key)
              : key,
          value: await normalizeProtocolResult(
            entryValue,
            prepared,
            Value.Check(ProtocolStringSchema, key) ? await textForProtocolUri(key) : undefined,
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
  if (text !== undefined && positionEncoding !== undefined) {
    const foldingRange = normalizeProtocolFoldingRange(value, text, positionEncoding);
    if (foldingRange !== undefined) return foldingRange;
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
  // An incoming call's fromRanges sit in its caller's file, which its `from` item names.
  const callerUriValue =
    record.fromRanges === undefined ? undefined : protocolString(protocolRecord(record.from)?.uri);
  const callerText =
    callerUriValue === undefined ? undefined : await textForProtocolUri(callerUriValue);
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
          key === "fromRanges" && callerText !== undefined
            ? callerText
            : targetUriValue !== undefined && key === "originSelectionRange"
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

/**
 * The file holding each normalized outgoing call's `fromRanges`: the prepared item it was requested
 * for, which is not always the queried file. Kept beside the Structured Result, which does not name
 * that item, so the model-visible text can place the call sites.
 */
const OUTGOING_CALL_SITE_PATHS = new WeakMap<object, string>();

/** Normalize one prepared item's outgoing calls, converting call sites against that item's file. */
async function normalizeOutgoingCalls(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Outgoing-call responses stay opaque; normalization validates each position it rewrites.
  calls: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The prepared item is opaque except for its checked uri.
  item: unknown,
  prepared: PreparedDocument,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Normalization preserves dynamic payloads without claiming a method-specific result type.
): Promise<unknown> {
  const itemUri = protocolString(protocolRecord(item)?.uri);
  const itemText =
    itemUri === undefined || itemUri === prepared.document.uri
      ? undefined
      : await textForProtocolUri(itemUri);
  const normalized = await normalizeProtocolResult(calls, prepared, itemText);
  if (itemUri !== undefined && itemUri.startsWith("file:") && Array.isArray(normalized)) {
    const sitePath = fileURLToPath(itemUri);
    for (const call of normalized) {
      if (protocolRecord(call) !== undefined) OUTGOING_CALL_SITE_PATHS.set(call, sitePath);
    }
  }
  return normalized;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Protocol fields such as titles are opaque until checked here.
function protocolString(value: unknown): string | undefined {
  return Value.Check(ProtocolStringSchema, value) ? value : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Capability values may be booleans or provider objects; only resolveProvider is inspected.
function supportsResolveProvider(value: unknown): boolean {
  return protocolRecord(value)?.resolveProvider === true;
}

async function resolveProtocolItems(
  client: LspToolServerClient,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Resolve requests forward opaque server items after checking only their container shape.
  value: unknown,
  method: string,
  signal: AbortSignal | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Resolved protocol items remain opaque until rendering or mutation validation.
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => client.request(method, item, signal)));
  }
  const record = protocolRecord(value);
  if (record === undefined || !Array.isArray(record.items)) return value;
  return {
    ...record,
    items: await Promise.all(record.items.map((item) => client.request(method, item, signal))),
  };
}

async function resolveCodeActionItems(
  client: LspToolServerClient,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Code Action responses are raw until the command discriminator or edit parser establishes the consumed fields.
  actions: unknown,
  signal: AbortSignal | undefined,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Resolve responses are not assumed to satisfy the request's action shape.
): Promise<unknown> {
  if (!Array.isArray(actions)) return actions;
  return Promise.all(
    actions.map((action) => {
      const record = protocolRecord(action);
      return record !== undefined && Value.Check(ProtocolStringSchema, record.command)
        ? action
        : client.request(CodeActionResolveRequest.method, action, signal);
    }),
  );
}

function formattingOptions(
  parameters: Extract<
    LspToolParameters,
    { operation: "format_document" | "format_range" | "format_on_type" }
  >,
) {
  return {
    tabSize: parameters.tab_size,
    insertSpaces: parameters.insert_spaces,
    trimTrailingWhitespace: parameters.trim_trailing_whitespace,
    insertFinalNewline: parameters.insert_final_newline,
    trimFinalNewlines: parameters.trim_final_newlines,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Formatting responses become raw Workspace Edits; the preview store validates every edit before use.
function workspaceEditFromTextEdits(uri: string, edits: unknown) {
  const textEdits: readonly unknown[] = Array.isArray(edits) ? edits : [];
  return { changes: { [uri]: textEdits } };
}

function normalizeStoreMutationManifest(manifest: LspMutationManifest): MutationManifest {
  const entries = manifest.entries.map((entry) => {
    if (entry.operation === "rename") {
      return {
        operation: "rename",
        path: entry.path,
        destination_path: entry.destination_path,
      };
    }
    return { operation: entry.operation, path: entry.path };
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

/** Map each language ID to the file extensions and exact filenames routed to it. */
function statusLanguages(languages: readonly LspServerLanguage[]) {
  const patterns = new Map<string, readonly string[]>();
  for (const { languageId, extensions = [], fileNames = [] } of languages) {
    patterns.set(languageId, [...(patterns.get(languageId) ?? []), ...extensions, ...fileNames]);
  }
  return Object.fromEntries(patterns);
}

/**
 * Record a Workspace Edit Preview that the calling tool reports itself, with its canonical
 * Mutation Manifest.
 */
async function recordToolPreview(
  dependencies: LspToolDependencies,
  serverId: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The preview store owns validation of raw server Workspace Edits before filesystem inspection.
  edit: unknown,
  positionEncoding: PositionEncodingKind,
): Promise<{ preview: LspWorkspaceEditPreviewRecord; manifest: MutationManifest }> {
  const preview = await dependencies.workspaceEdits.createPreview({
    edit,
    serverId,
    positionEncoding,
  });
  dependencies.workspaceEdits.markPreviewReported(preview.preview_id);
  const manifest = normalizeStoreMutationManifest(
    dependencies.workspaceEdits.prepareMutationManifest(preview.preview_id),
  );
  return { preview, manifest };
}

async function workspacePreviewOutput(
  dependencies: LspToolDependencies,
  operation: "format_document" | "format_range" | "format_on_type" | "rename",
  route: LspServerRoute,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The preview store owns validation of raw server Workspace Edits before filesystem inspection.
  edit: unknown,
  positionEncoding: PositionEncodingKind,
  scope?: ServerInstanceScope,
): Promise<AgentToolResult<LspToolResultDetails>> {
  const { serverId, rootPath } = route;
  const { preview, manifest } = await recordToolPreview(
    dependencies,
    serverId,
    edit,
    positionEncoding,
  );
  // The scope leads the summary so that output truncation cannot hide it before lsp_apply.
  const scopeLines = scope === undefined ? [] : serverInstanceScopeLines([scope]);
  const summary = [scopeLines.join("\n"), preview.summary]
    .filter((part) => part !== "")
    .join("\n\n");
  const details: Extract<LspToolResultDetails, { kind: "workspace_edit_preview" }> = {
    kind: "workspace_edit_preview",
    preview_id: preview.preview_id,
    operation,
    summary,
    mutation_manifest: manifest,
    preview_record: preview,
    state: "available",
  };
  const text =
    manifest.length === 0
      ? `${NO_CHANGES_SUMMARY}: the edits from server ${serverId} change no file, so there is nothing to apply.`
      : `Workspace Edit Preview ${preview.preview_id}\n${summary}`;
  return createLspToolOutput(
    text,
    details,
    {
      preview_id: preview.preview_id,
      server_id: serverId,
      root_path: rootPath,
      summary,
      warnings: scope === undefined ? [] : serverInstanceScopeWarnings([scope]),
      mutation_manifest: manifest,
    },
    dependencies,
  );
}

async function executePositionRead(
  dependencies: LspToolDependencies,
  parameters: PositionReadParameters,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<PositionReadValue>> {
  const filePath = await documentFilePath(parameters.file_path, context);
  const methodByOperation = {
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
    requireMethod(capabilityMethod),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      const requested = { line: parameters.line, character: parameters.character };
      const position = protocolPosition(prepared, requested);
      const query = lspQueryPosition(filePath, prepared.document.text, requested);
      const textDocument = { uri: prepared.document.uri };
      let requestParameters: TextDocumentPositionParams | ReferenceParams = {
        textDocument,
        position,
      };
      if (parameters.operation === "find_references") {
        requestParameters = {
          ...requestParameters,
          context: { includeDeclaration: parameters.include_declaration ?? true },
        };
      }
      let value = await prepared.client.request(capabilityMethod, requestParameters, signal);

      if (parameters.operation === "outgoing_calls") {
        const preparedItems = Array.isArray(value) ? value : [];
        const noHierarchyItem = preparedItems.length === 0;
        const calls = await Promise.all(
          preparedItems.map(async (item) =>
            normalizeOutgoingCalls(
              await client.request(CallHierarchyOutgoingCallsRequest.method, { item }, signal),
              item,
              prepared,
            ),
          ),
        );
        return { response: calls.flat(), query, noHierarchyItem };
      }
      let noHierarchyItem = false;
      if (
        parameters.operation === "incoming_calls" ||
        parameters.operation === "supertypes" ||
        parameters.operation === "subtypes"
      ) {
        const followupMethod =
          parameters.operation === "incoming_calls"
            ? CallHierarchyIncomingCallsRequest.method
            : parameters.operation === "supertypes"
              ? TypeHierarchySupertypesRequest.method
              : TypeHierarchySubtypesRequest.method;
        const preparedItems = Array.isArray(value) ? value : [];
        noHierarchyItem = preparedItems.length === 0;
        value = (
          await Promise.all(
            preparedItems.map((item) => client.request(followupMethod, { item }, signal)),
          )
        ).flat();
      }

      return { response: await normalizeProtocolResult(value, prepared), query, noHierarchyItem };
    },
  );
}

/** One server's completions or workspace symbols, cut to the call's prefix and limit. */
interface BoundedServerItems extends LspBoundedItems {
  /** The prefix completions were filtered by. */
  readonly prefix?: string;
  /** What a completion's queried position held in the text sent to this server. */
  readonly query?: LspQueryPosition;
}

/**
 * Request completions and keep those starting with the call's prefix (by default the identifier
 * before the position), up to its limit. Only the kept items are resolved.
 */
async function executeCompletion(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "completion" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<BoundedServerItems>> {
  const filePath = await documentFilePath(parameters.file_path, context);
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    requireMethod(CompletionRequest.method),
    async (client, route): Promise<BoundedServerItems> => {
      const prepared = await prepareLspDocument(client, route, filePath);
      const position = protocolPosition(prepared, parameters);
      const prefix = parameters.prefix ?? completionPrefixAt(prepared.document.text, parameters);
      const bounded = boundLspCompletions(
        await client.request(
          CompletionRequest.method,
          { textDocument: { uri: prepared.document.uri }, position },
          signal,
        ),
        { prefix, limit: parameters.limit ?? DEFAULT_LSP_ITEM_LIMIT },
      );
      let value = bounded.value;
      if (supportsResolveProvider(client.capabilities.completionProvider)) {
        value = await resolveProtocolItems(client, value, CompletionResolveRequest.method, signal);
      }
      return {
        value: await normalizeProtocolResult(value, prepared),
        omitted: bounded.omitted,
        prefix,
        query: lspQueryPosition(filePath, prepared.document.text, parameters),
      };
    },
  );
}

async function executeFileRead(
  dependencies: LspToolDependencies,
  parameters: FileReadParameters,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<unknown>> {
  const filePath = await documentFilePath(parameters.file_path, context);
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
    method === "diagnostics" ? DOCUMENT_DIAGNOSTICS_CAPABILITY : requireMethod(method),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      if (parameters.operation === "diagnostics") {
        return normalizeProtocolResult(
          await client.documentDiagnostics(filePath, route.language.languageId, signal),
          prepared,
        );
      }
      let value = await client.request(
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
): Promise<LspServerReadResult<unknown>> {
  const filePath = await documentFilePath(parameters.file_path, context);
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    requireMethod(InlayHintRequest.method),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      let value = await client.request(
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
): Promise<LspServerReadResult<unknown>> {
  const filePath = await documentFilePath(parameters.file_path, context);
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    requireMethod(SelectionRangeRequest.method),
    async (client, route) => {
      const prepared = await prepareLspDocument(client, route, filePath);
      const value = await client.request(
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

async function executeWorkspaceDiagnostics(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "workspace_diagnostics" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<unknown>> {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    WORKSPACE_DIAGNOSTICS_CAPABILITY,
    async (client, route) => {
      const result = await client.workspaceDiagnostics(signal);
      if (result.status === "unsupported") {
        return {
          status: result.status,
          message: `Server ${route.serverId} publishes no workspace diagnostics; it reports diagnostics only for a requested file. Use lsp_diagnostics for each file.`,
        };
      }
      return normalizeProtocolResult(
        result,
        undefined,
        undefined,
        normalizeLspPositionEncoding(client.positionEncoding),
      );
    },
  );
}

/** Request workspace symbols up to the call's limit, in the server's order; only those are resolved. */
async function executeWorkspaceSymbols(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "workspace_symbols" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<LspServerReadResult<BoundedServerItems>> {
  const filePath = absoluteLspFilePath(parameters.file_path, context);
  return dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    requireMethod(WorkspaceSymbolRequest.method),
    async (client): Promise<BoundedServerItems> => {
      const bounded = boundLspWorkspaceSymbols(
        await client.request(WorkspaceSymbolRequest.method, { query: parameters.query }, signal),
        parameters.limit ?? DEFAULT_LSP_ITEM_LIMIT,
      );
      let value = bounded.value;
      if (supportsResolveProvider(client.capabilities.workspaceSymbolProvider)) {
        value = await resolveProtocolItems(
          client,
          value,
          WorkspaceSymbolResolveRequest.method,
          signal,
        );
      }
      return {
        value: await normalizeProtocolResult(
          value,
          undefined,
          undefined,
          normalizeLspPositionEncoding(client.positionEncoding),
        ),
        omitted: bounded.omitted,
      };
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
  const filePath = await documentFilePath(parameters.file_path, context);
  const method =
    parameters.operation === "format_document"
      ? DocumentFormattingRequest.method
      : parameters.operation === "format_range"
        ? DocumentRangeFormattingRequest.method
        : DocumentOnTypeFormattingRequest.method;
  const resolution = await dependencies.manager.resolveMutationClient(
    filePath,
    parameters.server_id,
    requireMethod(method),
  );
  if (resolution.kind === "failure") throw piLspFailureError([resolution.failure]);
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
  const edits = await client.request(method, requestParameters, signal);
  return workspacePreviewOutput(
    dependencies,
    parameters.operation,
    route,
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
  const filePath = await documentFilePath(parameters.file_path, context);
  const resolution = await dependencies.manager.resolveMutationClient(
    filePath,
    parameters.server_id,
    requireMethod(RenameRequest.method),
  );
  if (resolution.kind === "failure") throw piLspFailureError([resolution.failure]);
  const { client, route } = resolution.instance;
  const prepared = await prepareLspDocument(client, route, filePath);
  const edit = await client.request(
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
    route,
    edit,
    client.positionEncoding,
    await serverInstanceScope(dependencies, route.serverId, route.rootPath, context.cwd),
  );
}

function comparePositions(left: Position, right: Position): number {
  return left.line === right.line ? left.character - right.character : left.line - right.line;
}

/** Whether two protocol ranges share a position, counting touching endpoints. */
function rangesOverlap(left: Range, right: Range): boolean {
  return (
    comparePositions(left.start, right.end) <= 0 && comparePositions(right.start, left.end) <= 0
  );
}

/**
 * Select the Server Instance's current LSP Diagnostics that overlap a code-action range, so
 * diagnostic-dependent quick fixes are offered. Any diagnostics failure except cancellation sends
 * none: refactors and source actions still return, and a failed server surfaces on the
 * code-action request itself.
 */
async function codeActionDiagnostics(
  prepared: PreparedDocument,
  range: Range,
  signal: AbortSignal | undefined,
): Promise<Diagnostic[]> {
  let diagnostics: readonly Diagnostic[];
  try {
    diagnostics = await prepared.client.currentDocumentDiagnostics(prepared.document, signal);
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    return [];
  }
  return diagnostics.filter((diagnostic) => rangesOverlap(diagnostic.range, range));
}

/** One listed code action, named by the server that offered it. */
interface CodeActionResult {
  readonly server_id: string;
  readonly applicable: boolean;
  readonly command?: unknown;
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly mutation_manifest?: MutationManifest;
  readonly preview_id?: string;
  readonly summary?: string;
}

/** One server's listed code actions and the Workspace Edit Previews created for them. */
interface ServerCodeActions {
  readonly actions: readonly CodeActionResult[];
  readonly previewRecords: readonly LspWorkspaceEditPreviewRecord[];
}

/**
 * Whether a code-action kind is one of the requested kinds or a sub-kind of one. Kinds are
 * hierarchical with `.` as the separator, so `quickfix` matches `quickfix.import` but not
 * `quickfixes`.
 */
function matchesRequestedKind(kind: string | undefined, requested: readonly string[]): boolean {
  return (
    kind !== undefined &&
    requested.some(
      (requestedKind) => kind === requestedKind || kind.startsWith(`${requestedKind}.`),
    )
  );
}

/**
 * Request one Server Instance's code actions and preview every edit-bearing action. Servers may
 * ignore `only_kinds`, so the matching is repeated here before any preview is created.
 */
async function serverCodeActions(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "code_actions" }>,
  prepared: PreparedDocument,
  signal: AbortSignal | undefined,
): Promise<ServerCodeActions> {
  const { client, route } = prepared;
  const range: Range = {
    start: protocolPosition(prepared, parameters.range.start),
    end: protocolPosition(prepared, parameters.range.end),
  };
  const diagnostics = await codeActionDiagnostics(prepared, range, signal);
  const offered = await client.request(
    CodeActionRequest.method,
    {
      textDocument: { uri: prepared.document.uri },
      range,
      context: {
        diagnostics,
        only: parameters.only_kinds,
      },
    },
    signal,
  );
  // Servers may ignore only_kinds. Filter before resolving, so dropped actions cost no request.
  // The client advertises no resolveSupport, so a kind is already present before resolution.
  let actions: unknown = Array.isArray(offered)
    ? offered.filter(
        (action) =>
          parameters.only_kinds === undefined ||
          matchesRequestedKind(protocolString(protocolRecord(action)?.kind), parameters.only_kinds),
      )
    : offered;
  if (supportsResolveProvider(client.capabilities.codeActionProvider)) {
    actions = await resolveCodeActionItems(client, actions, signal);
  }
  const results: CodeActionResult[] = [];
  const previewRecords: LspWorkspaceEditPreviewRecord[] = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    const record = protocolRecord(action);
    if (record === undefined) continue;
    const kind = protocolString(record.kind);
    const title = protocolString(record.title);
    if (record.command !== undefined || record.edit === undefined) {
      results.push({
        server_id: route.serverId,
        applicable: false,
        command: record.command,
        kind,
        title,
      });
      continue;
    }
    const { preview, manifest } = await recordToolPreview(
      dependencies,
      route.serverId,
      record.edit,
      client.positionEncoding,
    );
    previewRecords.push(preview);
    results.push({
      server_id: route.serverId,
      applicable: true,
      kind,
      mutation_manifest: manifest,
      preview_id: preview.preview_id,
      summary: preview.summary,
      title,
    });
  }
  return { actions: results, previewRecords };
}

/**
 * List the code actions of every capable Server Instance, or only `server_id`'s. Like a read, a
 * failing server becomes a labeled warning while the others' actions remain.
 */
async function executeCodeActions(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "code_actions" }>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  const filePath = await documentFilePath(parameters.file_path, context);
  const result = await dependencies.manager.runRead(
    filePath,
    parameters.server_id,
    requireMethod(CodeActionRequest.method),
    async (client, route) =>
      serverCodeActions(
        dependencies,
        parameters,
        await prepareLspDocument(client, route, filePath),
        signal,
      ),
  );
  requireReadSuccess(result);
  const details = operationDetails(
    "code_actions",
    readOperationOutcomes(result),
    result.successes.flatMap(({ value }) => value.previewRecords),
  );
  const text = formatLspToolValue({
    actions: result.successes.flatMap(({ value }) => value.actions),
    warnings: result.failures.map(({ message }) => message),
  });
  return createLspToolOutput(text, details, lspStructuredFields(text), dependencies);
}

async function executeApplyPreview(
  dependencies: LspToolDependencies,
  parameters: Extract<LspToolParameters, { operation: "apply" }>,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<LspToolResultDetails>> {
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
    const changedPaths = [...cause.recoveryFailures].sort((left, right) =>
      left.localeCompare(right),
    );
    // A partial failure is an error at its source; scripts still receive the structured result.
    const output = await createLspToolOutput(
      cause.message,
      {
        kind: "workspace_edit_apply",
        preview_id: parameters.preview_id,
        mutation_manifest: canonicalManifest,
        changed_paths: changedPaths,
        state: "partial_failure",
      },
      {
        preview_id: parameters.preview_id,
        state: "partial_failure",
        changed_paths: changedPaths,
        mutation_manifest: canonicalManifest,
        message: cause.message,
      },
      dependencies,
    );
    return { ...output, isError: true };
  }
  const changedPaths = [
    ...result.changed_files,
    ...result.created_files,
    ...result.deleted_files,
    ...result.moved_files.flatMap((move) => [move.from, move.to]),
  ];
  const sortedChangedPaths = [...new Set(changedPaths)].sort((left, right) =>
    left.localeCompare(right),
  );
  const details: Extract<LspToolResultDetails, { kind: "workspace_edit_apply" }> = {
    kind: "workspace_edit_apply",
    preview_id: parameters.preview_id,
    mutation_manifest: canonicalManifest,
    changed_paths: sortedChangedPaths,
    state: result.state,
  };
  const text = formatLspToolValue(result);
  return createLspToolOutput(
    text,
    details,
    {
      ...lspStructuredFields(text),
      changed_paths: sortedChangedPaths,
      mutation_manifest: canonicalManifest,
    },
    dependencies,
  );
}

async function executeLspOperation(
  dependencies: LspToolDependencies,
  parameters: LspToolParameters,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<LspToolResultDetails>> {
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
      const text = formatLspToolValue({
        servers: status.servers.map((server) => ({
          error: server.error,
          languages: statusLanguages(server.languages),
          root_path: server.rootPath,
          server_id: server.serverId,
          state: server.state,
        })),
        warnings: status.warnings,
      });
      return createLspToolOutput(
        text,
        operationDetails("status", outcomes),
        lspStructuredFields(text),
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
      if (resolution.kind === "failure") throw piLspFailureError([resolution.failure]);
      const text = formatLspToolValue({
        capabilities: resolution.instance.client.capabilities,
        root_path: resolution.instance.route.rootPath,
        server_id: resolution.instance.route.serverId,
      });
      return createLspToolOutput(
        text,
        operationDetails(parameters.operation, [
          { server_id: resolution.instance.route.serverId, outcome: "success" },
        ]),
        lspStructuredFields(text),
        dependencies,
      );
    }
    case "completion":
      return itemListOutput(
        parameters.operation,
        executeCompletion(dependencies, parameters, context, signal),
        dependencies,
        readTextContext(parameters.file_path, context),
      );
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
    case "prepare_rename":
      return positionReadOutput(
        parameters.operation,
        executePositionRead(dependencies, parameters, context, signal),
        dependencies,
        readTextContext(parameters.file_path, context),
      );
    case "diagnostics":
    case "document_symbols":
    case "document_links":
    case "folding_ranges":
    case "code_lenses":
    case "document_colors":
      return readOutput(
        parameters.operation,
        executeFileRead(dependencies, parameters, context, signal),
        dependencies,
        readTextContext(parameters.file_path, context),
      );
    case "workspace_diagnostics":
      return readOutput(
        parameters.operation,
        executeWorkspaceDiagnostics(dependencies, parameters, context, signal),
        dependencies,
        readTextContext(parameters.file_path, context),
      );
    case "workspace_symbols":
      return itemListOutput(
        parameters.operation,
        executeWorkspaceSymbols(dependencies, parameters, context, signal),
        dependencies,
        readTextContext(parameters.file_path, context),
      );
    case "selection_ranges":
      return readOutput(
        parameters.operation,
        executeSelectionRanges(dependencies, parameters, context, signal),
        dependencies,
        { ...readTextContext(parameters.file_path, context), positions: parameters.positions },
      );
    case "inlay_hints":
      return readOutput(
        parameters.operation,
        executeInlayHints(dependencies, parameters, context, signal),
        dependencies,
        readTextContext(parameters.file_path, context),
      );
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
}

/**
 * Shared rules of every LSP tool. Pi lists namespace instructions only on request (codemode's
 * `describeNamespace()`), so the declared tools receive the same rules as one system-prompt
 * guideline, which Pi adds once however many LSP tools are active.
 */
const LSP_TOOL_RULES = [
  "Lines and characters, in arguments and results, are one-based and count Unicode code points. Paths may start with @.",
  "Location results list one `path:line:col  <source line>` line per location, with paths relative to the working directory (absolute outside it).",
  "Reads and lsp_code_actions query every matching server unless server_id narrows them; lsp_rename and lsp_format_* need server_id when several servers match.",
  "Model-visible output is limited to 2,000 lines or 50 KB; the complete output is saved as a Result Spill file named in the result. Structured results are capped at 1 MiB; a larger one is bounded, and truncated and spill_path then name the complete output.",
  "lsp_rename, lsp_code_actions, and lsp_format_* only create Workspace Edit Previews. Nothing changes until lsp_apply applies a preview_id.",
  'lsp_apply resolves to state "partial_failure" with an error result when rollback leaves files changed; changed_paths lists them.',
];

/**
 * The `lsp` tool namespace: a short listing description and the shared rules for scripts. It is
 * built without a `ToolNamespace` annotation because Pi 0.99's type has no `instructions` field
 * and would reject it as an excess property; Pi 1.0+ reads it, and 0.99 ignores it.
 */
export const LSP_TOOL_NAMESPACE = {
  name: "lsp",
  description: "Language-server navigation, diagnostics, and previewed edits",
  instructions: LSP_TOOL_RULES.map((rule) => `- ${rule}`).join("\n"),
};

/** One snippet puts a single line naming the lsp_* family in the system prompt's tool list. */
const LSP_PROMPT_SNIPPET_TOOL: LspOperationName = "diagnostics";
const LSP_PROMPT_SNIPPET =
  "Language-server diagnostics; the lsp_* tools also cover navigation and previewed edits";

/**
 * One system-prompt guideline shared by every LSP tool; Pi deduplicates identical guidelines. It is
 * the only channel through which direct tool callers see the shared rules, so it restates the
 * coordinate and output rules a call or its result cannot be read correctly without.
 */
export const LSP_TOOL_GUIDELINE =
  "Use the lsp_* tools for semantic code navigation and diagnostics. Their lines and characters, in arguments and results, are one-based Unicode code points, and paths may start with @. Location results list one path:line:col line per location, with paths relative to the working directory. Output over 2,000 lines or 50 KB is cut, and the complete output is saved to the Result Spill file named in the result. lsp_rename, lsp_code_actions, and lsp_format_* only create Workspace Edit Previews; call lsp_apply with a preview_id to change files.";

/** Operations declared to the model by default; every other operation is reachable through codemode (ADR-0003). */
const DIRECT_LSP_OPERATIONS: ReadonlySet<LspOperationName> = new Set([
  "status",
  "diagnostics",
  "goto_definition",
  "find_references",
  "hover",
  "document_symbols",
  "workspace_symbols",
  "rename",
  "code_actions",
  "apply",
]);

const LSP_TOOL_DESCRIPTIONS = {
  status:
    "Report each configured language server's state, workspace root, last error, and the file extensions it handles per language ID.",
  capabilities: "Start a server for a workspace and report its negotiated capabilities.",
  restart:
    "Restart a server for a workspace, clearing its unavailable state, and report its capabilities.",
  diagnostics: "Get fresh LSP Diagnostics for a file from every matching server.",
  workspace_diagnostics:
    "Get a server's diagnostics for its whole workspace, from workspace pull or cached push diagnostics. A server that publishes none reports status unsupported; use lsp_diagnostics per file.",
  completion:
    "List completions at a position, one `label (kind)  detail` line each. By default only those starting with the identifier before the position.",
  hover: "Get type information and documentation for the symbol at a position.",
  signature_help: "Get signature help for the call at a position.",
  declaration: "Find the declaration of the symbol at a position.",
  goto_definition: "Find the definition of the symbol at a position.",
  goto_type_definition: "Find the type definition of the symbol at a position.",
  goto_implementation: "Find the implementations of the symbol at a position.",
  find_references:
    "Find references to the symbol at a position. include_declaration defaults to true.",
  document_highlights: "Find the occurrences of the symbol at a position within its file.",
  document_symbols: "List the symbols declared in a file.",
  workspace_symbols:
    "Search the workspace's symbols by name, one `name (kind) path:line:col` line each.",
  document_links: "List the links in a file.",
  call_hierarchy: "Prepare call hierarchy items for the function at a position.",
  incoming_calls: "Find the calls to the function at a position.",
  outgoing_calls: "Find the calls made by the function at a position.",
  type_hierarchy: "Prepare type hierarchy items for the type at a position.",
  supertypes: "Find the supertypes of the type at a position.",
  subtypes: "Find the subtypes of the type at a position.",
  selection_ranges: "Get the nested selection ranges around positions.",
  folding_ranges: "List the folding ranges of a file.",
  code_lenses: "List the code lenses of a file.",
  inlay_hints: "List the inlay hints in a range.",
  document_colors: "List the color values in a file.",
  format_document: "Preview formatting a file. Apply the preview with lsp_apply.",
  format_range: "Preview formatting a range. Apply the preview with lsp_apply.",
  format_on_type:
    "Preview the formatting after typing trigger_character at a position. Apply the preview with lsp_apply.",
  prepare_rename: "Check whether the symbol at a position can be renamed, and get its range.",
  rename:
    "Preview renaming the symbol at a position across the workspace. Apply the preview with lsp_apply.",
  code_actions:
    "List code actions for a range from every matching server, each naming its server_id. Each action with an edit gets a Workspace Edit Preview to apply with lsp_apply; command-only actions cannot be applied.",
  apply:
    "Apply a Workspace Edit Preview by preview_id. Nothing changes if its files changed since the preview.",
} as const satisfies Record<LspOperationName, string>;

/**
 * Queries and `lsp_capabilities`: no file changes. `openWorldHint` is false for every tool because
 * the tools talk only to configured local language servers (ADR-0003).
 */
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Tools that record a Workspace Edit Preview; every call creates a new `preview_id`. */
const PREVIEW_OPERATIONS: ReadonlySet<LspOperationName> = new Set([
  "format_document",
  "format_range",
  "format_on_type",
  "rename",
  "code_actions",
]);

function lspToolAnnotations(operation: LspOperationName): ToolAnnotations {
  if (PREVIEW_OPERATIONS.has(operation)) {
    // Read-only: files change only through lsp_apply. Not idempotent: each call creates a new preview_id.
    return { ...READ_ONLY_ANNOTATIONS, idempotentHint: false };
  }
  if (operation === "apply") {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
  }
  if (operation === "restart") {
    // Restarting twice leaves the same running server, and no data changes.
    return {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }
  return READ_ONLY_ANNOTATIONS;
}

function lspToolOutputSchema(operation: LspOperationName): TSchema {
  switch (operation) {
    case "status":
      return LspStatusOutputSchema;
    case "capabilities":
    case "restart":
      return LspServerOutputSchema;
    case "format_document":
    case "format_range":
    case "format_on_type":
    case "rename":
      return LspPreviewOutputSchema;
    case "code_actions":
      return LspCodeActionsOutputSchema;
    case "apply":
      return LspApplyOutputSchema;
    default:
      return isLspPositionReadOperation(operation)
        ? LspPositionReadOutputSchema
        : LspReadOutputSchema;
  }
}

/** How the model reaches one LSP operation's tool. */
export function lspToolExposure(operation: LspOperationName): ToolExposure {
  return DIRECT_LSP_OPERATIONS.has(operation) ? "direct" : "codemode";
}

function prepareApplyArguments(
  getDependencies: () => LspToolDependencies,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Raw model arguments are checked before the canonical manifest replaces any supplied one.
  argumentsValue: unknown,
): LspOperationParameters<"apply"> {
  if (!Value.Check(ApplyPreviewArgumentsSchema, argumentsValue)) {
    return parseLspOperationParameters("apply", argumentsValue);
  }
  const applyArguments: ApplyPreviewArguments = argumentsValue;
  const storeManifest = getDependencies().workspaceEdits.prepareMutationManifest(
    applyArguments.preview_id,
  );
  return parseLspOperationParameters("apply", {
    ...applyArguments,
    mutation_manifest: normalizeStoreMutationManifest(storeManifest),
  });
}

function buildLspToolDefinition<TOperation extends LspOperationName>(
  operation: TOperation,
  getDependencies: () => LspToolDependencies,
): LspToolDefinition<TOperation> {
  const definition: LspToolDefinition<TOperation> = {
    name: lspToolName(operation),
    label: `LSP ${humanizeLspOperation(operation)}`,
    description: LSP_TOOL_DESCRIPTIONS[operation],
    promptGuidelines: [LSP_TOOL_GUIDELINE],
    parameters: LspOperationParametersSchemas[operation],
    outputSchema: lspToolOutputSchema(operation),
    exposure: lspToolExposure(operation),
    namespace: LSP_TOOL_NAMESPACE,
    annotations: lspToolAnnotations(operation),
    renderCall: (argumentsValue, theme, context) =>
      renderLspToolCall(operation, argumentsValue, theme, context.expanded, context.cwd),
    renderResult: (result, options, theme, context) =>
      renderLspToolResult(result, options, theme, context.isError),
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      const parameters = lspOperationCall(operation, parseLspOperationParameters(operation, input));
      return executeLspOperation(getDependencies(), parameters, context, signal);
    },
  };
  if (operation === LSP_PROMPT_SNIPPET_TOOL) definition.promptSnippet = LSP_PROMPT_SNIPPET;
  return definition;
}

/**
 * Create the strict `lsp_<operation>` ToolDefinition backed by the current session's runtime
 * owners. `lsp_apply` is excluded because it needs `prepareArguments`; use
 * `createLspApplyToolDefinition`.
 */
export function createLspToolDefinition<TOperation extends Exclude<LspOperationName, "apply">>(
  operation: TOperation,
  getDependencies: () => LspToolDependencies,
): LspToolDefinition<TOperation> {
  return buildLspToolDefinition(operation, getDependencies);
}

/** Create `lsp_apply`, whose prepared arguments carry the canonical Mutation Manifest. */
export function createLspApplyToolDefinition(
  getDependencies: () => LspToolDependencies,
): LspToolDefinition<"apply"> {
  return {
    ...buildLspToolDefinition("apply", getDependencies),
    // Permission hooks see the canonical Mutation Manifest before execution (ADR-0002).
    prepareArguments: (argumentsValue) => prepareApplyArguments(getDependencies, argumentsValue),
  };
}

/** Register one strict `lsp_<operation>` tool per LSP operation for the current Pi extension session. */
export function registerLspTools(
  pi: LspToolRegistrar,
  getDependencies: () => LspToolDependencies,
): void {
  for (const operation of LSP_OPERATION_NAMES) {
    if (operation === "apply") pi.registerTool(createLspApplyToolDefinition(getDependencies));
    else pi.registerTool(createLspToolDefinition(operation, getDependencies));
  }
}
