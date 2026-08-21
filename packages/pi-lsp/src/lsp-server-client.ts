import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  ApplyWorkspaceEditRequest,
  CancellationTokenSource,
  ConfigurationRequest,
  createProtocolConnection,
  DiagnosticRefreshRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DocumentDiagnosticReportKind,
  DocumentDiagnosticRequest,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  LogMessageNotification,
  PositionEncodingKind,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  ShutdownRequest,
  ShowMessageNotification,
  ShowMessageRequest,
  TextDocumentSyncKind,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
  WorkspaceDiagnosticRequest,
  WorkspaceFoldersRequest,
  type ApplyWorkspaceEditParams,
  type ApplyWorkspaceEditResult,
  type Diagnostic,
  type DocumentDiagnosticReport,
  type InitializeResult,
  type LSPAny,
  type Position,
  type ProtocolConnection,
  type Registration,
  type ServerCapabilities,
  type Unregistration,
  type WorkspaceDiagnosticReport,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol/node";
import {
  documentLines,
  measureLspPositionCharacters,
  normalizeLspPositionEncoding,
  type LspPositionEncoding,
} from "./lsp-position-encoding.js";
import type { LspTimeouts } from "./pi-lsp-settings.js";

const MAX_OPEN_DOCUMENTS = 100;
const MAX_STDERR_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LspJsonObjectSchema = Type.Record(Type.String(), Type.Unsafe<LSPAny>({}));
const TextDocumentSyncOptionsSchema = Type.Object(
  {
    change: Type.Optional(Type.Integer()),
    save: Type.Optional(
      Type.Union([Type.Boolean(), Type.Object({}, { additionalProperties: true })]),
    ),
  },
  { additionalProperties: true },
);
const DynamicDiagnosticRegistrationSchema = Type.Object(
  {
    identifier: Type.Optional(Type.String()),
    workspaceDiagnostics: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
const PrepareRenameProviderSchema = Type.Object(
  { prepareProvider: Type.Literal(true) },
  { additionalProperties: true },
);

/** Time budgets, in milliseconds, for one language-server process. */
export type LspServerClientTimeouts = LspTimeouts;

/** Launch and protocol configuration for one language-server process. */
export interface LspServerClientOptions {
  /** Stable configured server ID. */
  readonly serverId: string;
  /** Absolute root used as process cwd and workspace folder. */
  readonly rootPath: string;
  /** Installed executable resolved by cross-spawn without a shell. */
  readonly command: string;
  /** Executable arguments passed without shell interpretation. */
  readonly args: readonly string[];
  /** Complete child environment after settings resolution. */
  readonly environment: NodeJS.ProcessEnv;
  /** Opaque value sent only in the initialize request. */
  readonly initializationOptions: LSPAny;
  /** Opaque value served through workspace configuration. */
  readonly settings: LSPAny;
  /** Per-operation time budgets. */
  readonly timeouts: LspServerClientTimeouts;
  /** Mode-safe session file that retains the latest 1 MB of server stderr. */
  readonly stderrPath: string;
  /** Convert a server-initiated edit into a Workspace Edit Preview. */
  readonly onWorkspaceEdit?: (workspaceEdit: WorkspaceEdit) => Promise<string>;
  /** Mark the owning Server Instance unavailable after its first terminal process/protocol failure. */
  readonly onUnavailable?: (error: LspServerClientError) => void;
}

/** A valid UTF-8 document synchronized with one server instance. */
export interface LspSynchronizedDocument {
  /** File URI sent to the server. */
  readonly uri: string;
  /** Monotonic document version local to this server instance. */
  readonly version: number;
  /** Decoded text, including an initial UTF-8 BOM when present. */
  readonly text: string;
}

/** Fresh diagnostics or a distinct timeout outcome. */
export type LspDocumentDiagnosticResult =
  | {
      readonly status: "fresh";
      readonly source: "push" | "document_pull";
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly status: "timeout"; readonly diagnostics: readonly [] };

/** Workspace diagnostics grouped by URI, with cached push fallback only when pull is unsupported. */
export type LspWorkspaceDiagnosticResult =
  | {
      readonly status: "fresh";
      readonly source: "workspace_pull" | "push_cache";
      readonly diagnosticsByUri: ReadonlyMap<string, readonly Diagnostic[]>;
    }
  | { readonly status: "timeout"; readonly diagnosticsByUri: ReadonlyMap<string, never> };

/** Classified process, protocol, timeout, cancellation, and UTF-8 client failure. */
export class LspServerClientError extends Error {
  /** Construct a stable Pi LSP client failure that always names the stderr capture. */
  constructor(
    readonly kind:
      | "cancelled"
      | "exit"
      | "initialize"
      | "invalid_utf8"
      | "protocol"
      | "spawn"
      | "timeout",
    readonly serverId: string,
    readonly stderrPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Pi LSP: ${message} (server ${serverId}; stderr ${stderrPath})`, options);
  }
}

interface OpenDocumentState extends LspSynchronizedDocument {
  readonly languageId: string;
}

interface PushDiagnosticsState {
  readonly diagnostics: readonly Diagnostic[];
  readonly revision: number;
  readonly version?: number;
}

interface PullDiagnosticsState {
  readonly diagnostics: readonly Diagnostic[];
  readonly resultId?: string;
}

interface DynamicDiagnosticRegistration {
  readonly identifier?: string;
  readonly workspaceDiagnostics: boolean;
}

function isProcessWithStdio(
  childProcess: ReturnType<typeof spawn>,
): childProcess is ChildProcessWithoutNullStreams {
  return (
    childProcess.stdin !== null && childProcess.stdout !== null && childProcess.stderr !== null
  );
}

function syncKindFromCapabilities(capabilities: ServerCapabilities): TextDocumentSyncKind {
  const sync = capabilities.textDocumentSync;
  if (!Value.Check(TextDocumentSyncOptionsSchema, sync)) {
    return sync ?? TextDocumentSyncKind.None;
  }
  const change = sync.change;
  return change === TextDocumentSyncKind.Full || change === TextDocumentSyncKind.Incremental
    ? change
    : TextDocumentSyncKind.None;
}

function serverWantsSave(capabilities: ServerCapabilities): boolean {
  const sync = capabilities.textDocumentSync;
  return (
    Value.Check(TextDocumentSyncOptionsSchema, sync) &&
    sync.save !== undefined &&
    sync.save !== false
  );
}

function protocolLineEndPosition(text: string, encoding: LspPositionEncoding): Position {
  const lines = documentLines(text);
  const lineText = lines.at(-1) ?? "";
  return {
    line: lines.length - 1,
    character: measureLspPositionCharacters(lineText, encoding),
  };
}

function configurationSectionValue(settings: LSPAny, section: string | undefined): LSPAny {
  if (section === undefined || section.length === 0) return settings;
  let current: LSPAny = settings;
  for (const part of section.split(".")) {
    if (!Value.Check(LspJsonObjectSchema, current) || !(part in current)) return null;
    current = current[part] ?? null;
  }
  return current;
}

function appendTail(previous: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([previous, chunk]);
  return combined.length <= MAX_STDERR_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_STDERR_BYTES);
}

function abortError(options: LspServerClientOptions): LspServerClientError {
  return new LspServerClientError(
    "cancelled",
    options.serverId,
    options.stderrPath,
    "request cancelled",
  );
}

function timeoutError(options: LspServerClientOptions, operation: string): LspServerClientError {
  return new LspServerClientError(
    "timeout",
    options.serverId,
    options.stderrPath,
    `${operation} timed out`,
  );
}

/** Own one stdio LSP process, connection, synchronized-document cache, and diagnostics state. */
export class LspServerClient {
  private capabilitiesValue: ServerCapabilities = {};
  private serverInfoValue: InitializeResult["serverInfo"];
  private positionEncodingValue: LspPositionEncoding = "utf-16";
  private textDocumentSyncKind: TextDocumentSyncKind = TextDocumentSyncKind.None;
  private readonly openDocuments = new Map<string, OpenDocumentState>();
  private readonly documentSynchronizations = new Map<string, Promise<LspSynchronizedDocument>>();
  private readonly pushDiagnostics = new Map<string, PushDiagnosticsState>();
  private readonly pullDiagnostics = new Map<string, PullDiagnosticsState>();
  private readonly dynamicRegistrations = new Map<string, Registration>();
  private readonly diagnosticWaiters = new Map<string, Set<() => void>>();
  private diagnosticsRevision = 0;
  private stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private stderrWrite = Promise.resolve();
  private closing = false;
  private closed = false;
  private terminalError: LspServerClientError | undefined;
  private resolveTerminalError: ((error: LspServerClientError) => void) | undefined;
  private readonly terminalErrorPromise: Promise<LspServerClientError>;

  private constructor(
    private readonly options: LspServerClientOptions,
    private readonly childProcess: ChildProcessWithoutNullStreams,
    private readonly connection: ProtocolConnection,
  ) {
    this.terminalErrorPromise = new Promise((resolveTerminalError) => {
      this.resolveTerminalError = resolveTerminalError;
    });
  }

  /** Spawn and initialize one configured language server over stdio. */
  static async start(options: LspServerClientOptions): Promise<LspServerClient> {
    await mkdir(dirname(options.stderrPath), { recursive: true, mode: 0o700 });
    await writeFile(options.stderrPath, "", { mode: 0o600 });

    const childProcess = spawn(options.command, [...options.args], {
      cwd: options.rootPath,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!isProcessWithStdio(childProcess)) {
      childProcess.kill();
      throw new LspServerClientError(
        "spawn",
        options.serverId,
        options.stderrPath,
        "spawn did not provide stdio pipes",
      );
    }

    const connection = createProtocolConnection(childProcess.stdout, childProcess.stdin);
    const client = new LspServerClient(options, childProcess, connection);
    client.bindProcessLifecycle();
    client.bindProtocolHandlers();
    connection.listen();

    try {
      await client.initialize();
      return client;
    } catch (cause) {
      await client.forceStop();
      if (cause instanceof LspServerClientError) throw cause;
      throw new LspServerClientError(
        "initialize",
        options.serverId,
        options.stderrPath,
        "initialization failed",
        { cause },
      );
    }
  }

  /** Child process identifier while the server is running. */
  get processId(): number | undefined {
    return this.childProcess.pid;
  }

  /** Whether the child has not exited and shutdown has not started. */
  get isRunning(): boolean {
    return (
      !this.closing &&
      !this.closed &&
      this.childProcess.exitCode === null &&
      this.childProcess.signalCode === null
    );
  }

  /** Stable configured server ID. */
  get serverId(): string {
    return this.options.serverId;
  }

  /** Absolute workspace root for this process. */
  get rootPath(): string {
    return this.options.rootPath;
  }

  /** Server capabilities after initialization plus dynamic registrations. */
  get capabilities(): Readonly<ServerCapabilities> {
    return this.capabilitiesValue;
  }

  /** Optional server implementation name and version returned during initialization. */
  get serverInfo(): InitializeResult["serverInfo"] {
    return this.serverInfoValue;
  }

  /** Position encoding negotiated with the server, defaulting to UTF-16. */
  get positionEncoding(): LspPositionEncoding {
    return this.positionEncodingValue;
  }

  /** Session stderr capture path included in every client failure. */
  get stderrPath(): string {
    return this.options.stderrPath;
  }

  /** Whether a static or dynamically registered LSP method is available. */
  hasCapability(method: string): boolean {
    if (
      [...this.dynamicRegistrations.values()].some((registration) => registration.method === method)
    ) {
      return true;
    }
    const capabilities = this.capabilitiesValue;
    switch (method) {
      case "textDocument/completion":
        return capabilities.completionProvider !== undefined;
      case "textDocument/hover":
        return capabilities.hoverProvider !== undefined && capabilities.hoverProvider !== false;
      case "textDocument/signatureHelp":
        return capabilities.signatureHelpProvider !== undefined;
      case "textDocument/declaration":
        return (
          capabilities.declarationProvider !== undefined &&
          capabilities.declarationProvider !== false
        );
      case "textDocument/definition":
        return (
          capabilities.definitionProvider !== undefined && capabilities.definitionProvider !== false
        );
      case "textDocument/typeDefinition":
        return (
          capabilities.typeDefinitionProvider !== undefined &&
          capabilities.typeDefinitionProvider !== false
        );
      case "textDocument/implementation":
        return (
          capabilities.implementationProvider !== undefined &&
          capabilities.implementationProvider !== false
        );
      case "textDocument/references":
        return (
          capabilities.referencesProvider !== undefined && capabilities.referencesProvider !== false
        );
      case "textDocument/documentHighlight":
        return (
          capabilities.documentHighlightProvider !== undefined &&
          capabilities.documentHighlightProvider !== false
        );
      case "textDocument/documentSymbol":
        return (
          capabilities.documentSymbolProvider !== undefined &&
          capabilities.documentSymbolProvider !== false
        );
      case "workspace/symbol":
        return (
          capabilities.workspaceSymbolProvider !== undefined &&
          capabilities.workspaceSymbolProvider !== false
        );
      case "textDocument/documentLink":
        return capabilities.documentLinkProvider !== undefined;
      case "textDocument/prepareCallHierarchy":
        return (
          capabilities.callHierarchyProvider !== undefined &&
          capabilities.callHierarchyProvider !== false
        );
      case "textDocument/prepareTypeHierarchy":
        return (
          capabilities.typeHierarchyProvider !== undefined &&
          capabilities.typeHierarchyProvider !== false
        );
      case "textDocument/selectionRange":
        return (
          capabilities.selectionRangeProvider !== undefined &&
          capabilities.selectionRangeProvider !== false
        );
      case "textDocument/foldingRange":
        return (
          capabilities.foldingRangeProvider !== undefined &&
          capabilities.foldingRangeProvider !== false
        );
      case "textDocument/codeLens":
        return capabilities.codeLensProvider !== undefined;
      case "textDocument/inlayHint":
        return (
          capabilities.inlayHintProvider !== undefined && capabilities.inlayHintProvider !== false
        );
      case "textDocument/documentColor":
        return capabilities.colorProvider !== undefined && capabilities.colorProvider !== false;
      case "textDocument/formatting":
        return (
          capabilities.documentFormattingProvider !== undefined &&
          capabilities.documentFormattingProvider !== false
        );
      case "textDocument/rangeFormatting":
        return (
          capabilities.documentRangeFormattingProvider !== undefined &&
          capabilities.documentRangeFormattingProvider !== false
        );
      case "textDocument/onTypeFormatting":
        return capabilities.documentOnTypeFormattingProvider !== undefined;
      case "textDocument/prepareRename":
        return (
          Value.Check(PrepareRenameProviderSchema, capabilities.renameProvider) ||
          [...this.dynamicRegistrations.values()].some(
            (registration) =>
              registration.method === "textDocument/rename" &&
              Value.Check(PrepareRenameProviderSchema, registration.registerOptions),
          )
        );
      case "textDocument/rename":
        return capabilities.renameProvider !== undefined && capabilities.renameProvider !== false;
      case "textDocument/codeAction":
        return (
          capabilities.codeActionProvider !== undefined && capabilities.codeActionProvider !== false
        );
      case DocumentDiagnosticRequest.method:
        return this.documentPullRegistration() !== undefined;
      case WorkspaceDiagnosticRequest.method:
        return this.workspacePullRegistration() !== undefined;
      default:
        return false;
    }
  }

  /** Send a capability-specific request with the configured timeout and JSON-RPC cancellation. */
  async request<TResult>(
    method: string,
    parameters: LSPAny,
    signal?: AbortSignal,
  ): Promise<TResult> {
    return this.sendRequestWithBudget<TResult>(
      method,
      parameters,
      this.options.timeouts.requestMs,
      method,
      signal,
    );
  }

  /** Open or update a valid UTF-8 file and maintain the 100-document LRU. */
  async synchronizeDocument(
    filePath: string,
    languageId: string,
  ): Promise<LspSynchronizedDocument> {
    const absolutePath = resolve(filePath);
    const uri = pathToFileURL(absolutePath).href;
    const activeSynchronization = this.documentSynchronizations.get(uri);
    const waitForActiveSynchronization =
      activeSynchronization?.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve();
    const synchronization = waitForActiveSynchronization.then(() =>
      this.synchronizeDocumentOnce(absolutePath, uri, languageId),
    );
    this.documentSynchronizations.set(uri, synchronization);
    try {
      return await synchronization;
    } finally {
      if (this.documentSynchronizations.get(uri) === synchronization) {
        this.documentSynchronizations.delete(uri);
      }
    }
  }

  private async synchronizeDocumentOnce(
    absolutePath: string,
    uri: string,
    languageId: string,
  ): Promise<LspSynchronizedDocument> {
    this.throwIfUnavailable();
    let text: string;
    try {
      const bytes = await readFile(absolutePath);
      text = UTF8_DECODER.decode(bytes);
    } catch (cause) {
      if (cause instanceof TypeError) {
        throw new LspServerClientError(
          "invalid_utf8",
          this.serverId,
          this.stderrPath,
          `document is not valid UTF-8: ${absolutePath}`,
          { cause },
        );
      }
      throw cause;
    }

    const existing = this.openDocuments.get(uri);
    if (existing?.text === text && existing.languageId === languageId) {
      this.openDocuments.delete(uri);
      this.openDocuments.set(uri, existing);
      return existing;
    }
    const next: OpenDocumentState = {
      uri,
      version: (existing?.version ?? 0) + 1,
      text,
      languageId,
    };

    if (this.textDocumentSyncKind !== TextDocumentSyncKind.None) {
      if (existing === undefined) {
        await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: { uri, languageId, version: next.version, text },
        });
      } else if (existing.text !== text || existing.languageId !== languageId) {
        const contentChanges =
          this.textDocumentSyncKind === TextDocumentSyncKind.Incremental
            ? [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: protocolLineEndPosition(existing.text, this.positionEncodingValue),
                  },
                  text,
                },
              ]
            : [{ text }];
        await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: next.version },
          contentChanges,
        });
        if (serverWantsSave(this.capabilitiesValue)) {
          await this.connection.sendNotification(DidSaveTextDocumentNotification.type, {
            textDocument: { uri },
            text,
          });
        }
      }
    }

    this.openDocuments.delete(uri);
    this.openDocuments.set(uri, next);
    await this.evictOldDocuments();
    return next;
  }

  /** Close an open document if this client currently owns it. */
  async closeDocument(filePath: string): Promise<void> {
    const uri = pathToFileURL(resolve(filePath)).href;
    if (!this.openDocuments.delete(uri)) return;
    if (this.textDocumentSyncKind !== TextDocumentSyncKind.None) {
      await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      });
    }
    this.pushDiagnostics.delete(uri);
    this.pullDiagnostics.delete(uri);
  }

  /** Synchronize a document, then wait for authoritative fresh push or pull diagnostics. */
  async documentDiagnostics(
    filePath: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<LspDocumentDiagnosticResult> {
    const uri = pathToFileURL(resolve(filePath)).href;
    const previousRevision = this.pushDiagnostics.get(uri)?.revision ?? 0;
    const document = await this.synchronizeDocument(filePath, languageId);
    const candidates: Array<Promise<LspDocumentDiagnosticResult>> = [
      this.waitForPushDiagnostics(document.uri, document.version, previousRevision, signal),
    ];
    const registration = this.documentPullRegistration();
    if (registration !== undefined) {
      candidates.push(this.pullDocumentDiagnostics(document.uri, registration.identifier, signal));
    }

    try {
      return await this.raceBudget(
        Promise.any(candidates),
        this.options.timeouts.diagnosticsMs,
        "diagnostics",
        signal,
      );
    } catch (cause) {
      if (cause instanceof LspServerClientError) {
        if (cause.kind === "cancelled") throw cause;
        if (cause.kind === "timeout") return { status: "timeout", diagnostics: [] };
      }
      if (cause instanceof AggregateError) {
        const cancellation = cause.errors.find(
          (error) => error instanceof LspServerClientError && error.kind === "cancelled",
        );
        if (cancellation instanceof LspServerClientError) throw cancellation;
        if (
          cause.errors.length > 0 &&
          cause.errors.every(
            (error) => error instanceof LspServerClientError && error.kind === "timeout",
          )
        ) {
          return { status: "timeout", diagnostics: [] };
        }
        const clientError = cause.errors.find((error) => error instanceof LspServerClientError);
        if (clientError instanceof LspServerClientError) throw clientError;
      }
      throw cause;
    }
  }

  /** Pull workspace diagnostics when supported, otherwise return cached push diagnostics only. */
  async workspaceDiagnostics(signal?: AbortSignal): Promise<LspWorkspaceDiagnosticResult> {
    const registration = this.workspacePullRegistration();
    if (registration === undefined) {
      return {
        status: "fresh",
        source: "push_cache",
        diagnosticsByUri: new Map(
          [...this.pushDiagnostics]
            .filter(([uri, state]) => {
              const version = this.openDocuments.get(uri)?.version;
              return (
                state.version === undefined || (version !== undefined && state.version === version)
              );
            })
            .map(([uri, state]) => [uri, state.diagnostics]),
        ),
      };
    }

    try {
      const report = await this.sendRequestWithBudget<WorkspaceDiagnosticReport>(
        WorkspaceDiagnosticRequest.method,
        {
          identifier: registration.identifier,
          previousResultIds: [...this.pullDiagnostics]
            .filter(([, state]) => state.resultId !== undefined)
            .map(([uri, state]) => ({ uri, value: state.resultId ?? "" })),
        },
        this.options.timeouts.diagnosticsMs,
        WorkspaceDiagnosticRequest.method,
        signal,
      );
      const diagnosticsByUri = this.acceptWorkspaceDiagnosticReport(report);
      return { status: "fresh", source: "workspace_pull", diagnosticsByUri };
    } catch (cause) {
      if (cause instanceof LspServerClientError && cause.kind === "timeout") {
        return {
          status: "timeout",
          diagnosticsByUri: new Map<string, never>(),
        };
      }
      throw cause;
    }
  }

  /** Gracefully shut down within the configured budget, then terminate the process. */
  async shutdown(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      if (this.childProcess.exitCode === null && this.childProcess.signalCode === null) {
        await this.sendRequestWithBudget<null>(
          ShutdownRequest.method,
          null,
          this.options.timeouts.shutdownMs,
          ShutdownRequest.method,
        ).catch(() => null);
        await this.connection.sendNotification(ExitNotification.type).catch(() => undefined);
        await this.waitForProcessExit(this.options.timeouts.shutdownMs).catch(() => undefined);
      }
    } finally {
      await this.forceStop();
    }
  }

  private bindProcessLifecycle(): void {
    this.childProcess.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = appendTail(this.stderrTail, chunk);
      const snapshot = this.stderrTail;
      this.stderrWrite = this.stderrWrite.then(() =>
        writeFile(this.stderrPath, snapshot, { mode: 0o600 }),
      );
    });
    this.childProcess.once("error", (cause) => {
      this.markTerminalError(
        new LspServerClientError(
          "spawn",
          this.serverId,
          this.stderrPath,
          "process failed to start",
          { cause },
        ),
      );
    });
    this.childProcess.once("exit", (code, processSignal) => {
      if (this.closed || this.closing) return;
      this.markTerminalError(
        new LspServerClientError(
          "exit",
          this.serverId,
          this.stderrPath,
          `process exited unexpectedly with ${processSignal ?? `code ${code ?? "unknown"}`}`,
        ),
      );
    });
    this.connection.onError(([cause]) => {
      this.markTerminalError(
        new LspServerClientError(
          "protocol",
          this.serverId,
          this.stderrPath,
          "JSON-RPC connection failed",
          { cause },
        ),
      );
    });
    this.connection.onClose(() => {
      if (this.closed || this.closing) return;
      this.markTerminalError(
        new LspServerClientError(
          "protocol",
          this.serverId,
          this.stderrPath,
          "JSON-RPC connection closed unexpectedly",
        ),
      );
    });
  }

  private bindProtocolHandlers(): void {
    this.connection.onNotification(PublishDiagnosticsNotification.type, (parameters) => {
      this.diagnosticsRevision++;
      const state: PushDiagnosticsState = {
        diagnostics: parameters.diagnostics,
        revision: this.diagnosticsRevision,
      };
      if (parameters.version !== undefined) {
        const stateWithVersion: PushDiagnosticsState = {
          ...state,
          version: parameters.version,
        };
        this.pushDiagnostics.set(parameters.uri, stateWithVersion);
      } else {
        this.pushDiagnostics.set(parameters.uri, state);
      }
      for (const notify of this.diagnosticWaiters.get(parameters.uri) ?? []) notify();
    });
    this.connection.onRequest(ConfigurationRequest.type, (parameters) =>
      parameters.items.map((item) =>
        configurationSectionValue(this.options.settings, item.section),
      ),
    );
    this.connection.onRequest(WorkspaceFoldersRequest.type, () => [
      { name: this.serverId, uri: pathToFileURL(this.rootPath).href },
    ]);
    this.connection.onRequest(RegistrationRequest.type, (parameters) => {
      for (const registration of parameters.registrations) {
        this.dynamicRegistrations.set(registration.id, registration);
      }
    });
    this.connection.onRequest(UnregistrationRequest.type, (parameters) => {
      for (const registration of parameters.unregisterations) {
        this.removeDynamicRegistration(registration);
      }
    });
    this.connection.onRequest(WorkDoneProgressCreateRequest.type, () => undefined);
    this.connection.onRequest(DiagnosticRefreshRequest.type, () => undefined);
    this.connection.onRequest(ApplyWorkspaceEditRequest.type, async (parameters) =>
      this.rejectServerWorkspaceEdit(parameters),
    );
    this.connection.onRequest(ShowMessageRequest.type, () => null);
    this.connection.onNotification(LogMessageNotification.type, () => undefined);
    this.connection.onNotification(ShowMessageNotification.type, () => undefined);
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.rootPath).href;
    let result: InitializeResult;
    try {
      result = await this.sendRequestWithBudget<InitializeResult>(
        InitializeRequest.method,
        {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ name: this.serverId, uri: rootUri }],
          initializationOptions: this.options.initializationOptions,
          capabilities: {
            general: {
              positionEncodings: [
                PositionEncodingKind.UTF8,
                PositionEncodingKind.UTF16,
                PositionEncodingKind.UTF32,
              ],
            },
            window: { workDoneProgress: true },
            workspace: {
              applyEdit: true,
              configuration: true,
              workspaceFolders: true,
              didChangeWatchedFiles: { dynamicRegistration: false },
              diagnostics: { refreshSupport: true },
              workspaceEdit: {
                documentChanges: true,
                resourceOperations: ["create", "rename", "delete"],
                failureHandling: "undo",
              },
            },
            textDocument: {
              synchronization: { didOpen: true, didClose: true, didSave: true },
              publishDiagnostics: { relatedInformation: true, versionSupport: true },
              diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
              completion: { dynamicRegistration: true },
              hover: { dynamicRegistration: true },
              signatureHelp: { dynamicRegistration: true },
              declaration: { dynamicRegistration: true, linkSupport: true },
              definition: { dynamicRegistration: true, linkSupport: true },
              typeDefinition: { dynamicRegistration: true, linkSupport: true },
              implementation: { dynamicRegistration: true, linkSupport: true },
              references: { dynamicRegistration: true },
              documentHighlight: { dynamicRegistration: true },
              documentSymbol: {
                dynamicRegistration: true,
                hierarchicalDocumentSymbolSupport: true,
              },
              documentLink: { dynamicRegistration: true, tooltipSupport: true },
              callHierarchy: { dynamicRegistration: true },
              typeHierarchy: { dynamicRegistration: true },
              selectionRange: { dynamicRegistration: true },
              foldingRange: { dynamicRegistration: true },
              codeLens: { dynamicRegistration: true },
              inlayHint: { dynamicRegistration: true },
              colorProvider: { dynamicRegistration: true },
              formatting: { dynamicRegistration: true },
              rangeFormatting: { dynamicRegistration: true },
              onTypeFormatting: { dynamicRegistration: true },
              rename: { dynamicRegistration: true, prepareSupport: true },
              codeAction: { dynamicRegistration: true, isPreferredSupport: true },
            },
          },
        },
        this.options.timeouts.initializeMs,
        InitializeRequest.method,
      );
    } catch (cause) {
      if (cause instanceof LspServerClientError) throw cause;
      throw new LspServerClientError(
        "initialize",
        this.serverId,
        this.stderrPath,
        "initialize request failed",
        { cause },
      );
    }

    this.capabilitiesValue = result.capabilities;
    this.serverInfoValue = result.serverInfo;
    this.positionEncodingValue = normalizeLspPositionEncoding(result.capabilities.positionEncoding);
    this.textDocumentSyncKind = syncKindFromCapabilities(result.capabilities);
    await this.connection.sendNotification(InitializedNotification.type, {});
    await this.connection.sendNotification(DidChangeConfigurationNotification.type, {
      settings: this.options.settings,
    });
  }

  private async sendRequestWithBudget<TResult>(
    method: string,
    parameters: LSPAny,
    budgetMs: number,
    operation: string,
    signal?: AbortSignal,
  ): Promise<TResult> {
    this.throwIfUnavailable();
    if (signal?.aborted === true) throw abortError(this.options);

    const cancellation = new CancellationTokenSource();
    try {
      return await Promise.race([
        this.raceBudget(
          this.connection.sendRequest<TResult>(method, parameters, cancellation.token),
          budgetMs,
          operation,
          signal,
          () => cancellation.cancel(),
        ),
        this.terminalErrorPromise.then((error) => {
          throw error;
        }),
      ]);
    } catch (cause) {
      if (cause instanceof LspServerClientError) throw cause;
      throw new LspServerClientError(
        "protocol",
        this.serverId,
        this.stderrPath,
        `${operation} request failed`,
        { cause },
      );
    } finally {
      cancellation.dispose();
    }
  }

  private async waitForPushDiagnostics(
    uri: string,
    version: number,
    previousRevision: number,
    signal?: AbortSignal,
  ): Promise<LspDocumentDiagnosticResult> {
    const deadline = Date.now() + this.options.timeouts.diagnosticsMs;
    for (;;) {
      const current = this.pushDiagnostics.get(uri);
      if (
        current !== undefined &&
        current.revision > previousRevision &&
        (current.version === undefined || current.version === version)
      ) {
        return { status: "fresh", source: "push", diagnostics: current.diagnostics };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw timeoutError(this.options, "diagnostics");
      let notifyWaiter: (() => void) | undefined;
      const notification = new Promise<void>((resolveNotification) => {
        notifyWaiter = resolveNotification;
        const waiters = this.diagnosticWaiters.get(uri) ?? new Set();
        waiters.add(resolveNotification);
        this.diagnosticWaiters.set(uri, waiters);
      });
      try {
        await this.raceBudget(notification, remainingMs, "diagnostics", signal);
      } finally {
        if (notifyWaiter !== undefined) {
          const waiters = this.diagnosticWaiters.get(uri);
          waiters?.delete(notifyWaiter);
          if (waiters?.size === 0) this.diagnosticWaiters.delete(uri);
        }
      }
    }
  }

  private async pullDocumentDiagnostics(
    uri: string,
    identifier: string | undefined,
    signal?: AbortSignal,
  ): Promise<LspDocumentDiagnosticResult> {
    const previous = this.pullDiagnostics.get(uri);
    const report = await this.sendRequestWithBudget<DocumentDiagnosticReport>(
      DocumentDiagnosticRequest.method,
      {
        textDocument: { uri },
        identifier,
        previousResultId: previous?.resultId,
      },
      this.options.timeouts.diagnosticsMs,
      DocumentDiagnosticRequest.method,
      signal,
    );
    if (report.kind === DocumentDiagnosticReportKind.Unchanged) {
      return {
        status: "fresh",
        source: "document_pull",
        diagnostics: previous?.diagnostics ?? [],
      };
    }
    const state: PullDiagnosticsState = { diagnostics: report.items };
    this.pullDiagnostics.set(
      uri,
      report.resultId === undefined ? state : { ...state, resultId: report.resultId },
    );
    if (report.relatedDocuments !== undefined) {
      for (const [relatedUri, related] of Object.entries(report.relatedDocuments)) {
        if (related.kind === DocumentDiagnosticReportKind.Unchanged) continue;
        const relatedState: PullDiagnosticsState = { diagnostics: related.items };
        this.pullDiagnostics.set(
          relatedUri,
          related.resultId === undefined
            ? relatedState
            : { ...relatedState, resultId: related.resultId },
        );
      }
    }
    return { status: "fresh", source: "document_pull", diagnostics: report.items };
  }

  private async raceBudget<TResult>(
    value: Promise<TResult>,
    budgetMs: number,
    operation: string,
    signal?: AbortSignal,
    onCancel?: () => void,
  ): Promise<TResult> {
    if (signal?.aborted === true) throw abortError(this.options);
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        onCancel?.();
        reject(timeoutError(this.options, operation));
      }, budgetMs);
      timeout.unref();
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return;
      abortListener = () => {
        onCancel?.();
        reject(abortError(this.options));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([value, timeoutPromise, abortPromise]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (signal !== undefined && abortListener !== undefined) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private documentPullRegistration(): DynamicDiagnosticRegistration | undefined {
    const dynamic = [...this.dynamicRegistrations.values()].find(
      (registration) => registration.method === DocumentDiagnosticRequest.method,
    );
    if (dynamic !== undefined) return this.parseDiagnosticRegistration(dynamic);
    if (this.capabilitiesValue.diagnosticProvider === undefined) return undefined;
    const provider = this.capabilitiesValue.diagnosticProvider;
    const staticRegistration: DynamicDiagnosticRegistration = {
      workspaceDiagnostics: provider.workspaceDiagnostics === true,
    };
    return provider.identifier === undefined
      ? staticRegistration
      : { ...staticRegistration, identifier: provider.identifier };
  }

  private workspacePullRegistration(): DynamicDiagnosticRegistration | undefined {
    const registration = this.documentPullRegistration();
    return registration?.workspaceDiagnostics === true ? registration : undefined;
  }

  private parseDiagnosticRegistration(registration: Registration): DynamicDiagnosticRegistration {
    const options = registration.registerOptions;
    if (!Value.Check(DynamicDiagnosticRegistrationSchema, options)) {
      return { workspaceDiagnostics: false };
    }
    const registrationOptions: DynamicDiagnosticRegistration = {
      workspaceDiagnostics: options.workspaceDiagnostics === true,
    };
    return options.identifier === undefined
      ? registrationOptions
      : { ...registrationOptions, identifier: options.identifier };
  }

  private acceptWorkspaceDiagnosticReport(
    report: WorkspaceDiagnosticReport,
  ): ReadonlyMap<string, readonly Diagnostic[]> {
    const diagnosticsByUri = new Map<string, readonly Diagnostic[]>();
    for (const item of report.items) {
      if (item.kind === DocumentDiagnosticReportKind.Unchanged) {
        diagnosticsByUri.set(item.uri, this.pullDiagnostics.get(item.uri)?.diagnostics ?? []);
        continue;
      }
      const state: PullDiagnosticsState = { diagnostics: item.items };
      this.pullDiagnostics.set(
        item.uri,
        item.resultId === undefined ? state : { ...state, resultId: item.resultId },
      );
      diagnosticsByUri.set(item.uri, item.items);
    }
    return diagnosticsByUri;
  }

  private removeDynamicRegistration(unregistration: Unregistration): void {
    const registration = this.dynamicRegistrations.get(unregistration.id);
    if (registration?.method === unregistration.method) {
      this.dynamicRegistrations.delete(unregistration.id);
    }
  }

  private async rejectServerWorkspaceEdit(
    parameters: ApplyWorkspaceEditParams,
  ): Promise<ApplyWorkspaceEditResult> {
    if (this.options.onWorkspaceEdit === undefined) {
      return { applied: false, failureReason: "Pi LSP: workspace edit requires a preview" };
    }
    try {
      const previewId = await this.options.onWorkspaceEdit(parameters.edit);
      return {
        applied: false,
        failureReason: `Pi LSP: workspace edit captured as preview ${previewId}`,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        applied: false,
        failureReason: `Pi LSP: workspace edit preview rejected: ${message}`,
      };
    }
  }

  private async evictOldDocuments(): Promise<void> {
    while (this.openDocuments.size > MAX_OPEN_DOCUMENTS) {
      const oldestUri = this.openDocuments.keys().next().value;
      if (oldestUri === undefined) return;
      this.openDocuments.delete(oldestUri);
      await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: oldestUri },
      });
      this.pushDiagnostics.delete(oldestUri);
      this.pullDiagnostics.delete(oldestUri);
    }
  }

  private markTerminalError(error: LspServerClientError): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    this.resolveTerminalError?.(error);
    try {
      this.options.onUnavailable?.(error);
    } catch {
      // The client failure remains authoritative when an outer status callback fails.
    }
  }

  private throwIfUnavailable(): void {
    if (this.terminalError !== undefined) throw this.terminalError;
    if (this.closed) {
      throw new LspServerClientError("exit", this.serverId, this.stderrPath, "client is shut down");
    }
  }

  private async waitForProcessExit(timeoutMs: number): Promise<void> {
    if (this.childProcess.exitCode !== null || this.childProcess.signalCode !== null) return;
    await this.raceBudget(
      new Promise<void>((resolveExit) => this.childProcess.once("exit", () => resolveExit())),
      timeoutMs,
      "process exit",
    );
  }

  private async forceStop(): Promise<void> {
    this.closed = true;
    if (this.childProcess.exitCode === null && this.childProcess.signalCode === null) {
      this.childProcess.kill();
      await new Promise<void>((resolveExit) => {
        const timeout = setTimeout(
          () => {
            this.childProcess.kill("SIGKILL");
            resolveExit();
          },
          Math.min(this.options.timeouts.shutdownMs, 1000),
        );
        timeout.unref();
        this.childProcess.once("exit", () => {
          clearTimeout(timeout);
          resolveExit();
        });
      });
    }
    this.connection.dispose();
    await this.stderrWrite.catch(() => undefined);
  }
}
