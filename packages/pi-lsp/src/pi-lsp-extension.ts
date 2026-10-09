import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
  type ExtensionFactory,
  type SessionEntry,
  type ToolCallEvent,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { expandEntryOnClick, noticeText } from "@ian-pascoe/pi-utils/ui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DocumentDiagnosticRequest,
  DocumentSymbolRequest,
  PositionEncodingKind,
  ReferencesRequest,
  type Diagnostic,
} from "vscode-languageserver-protocol/node";
import {
  capDependentFiles,
  DEPENDENT_SCAN_BUDGET_MS,
  groupErrorKeys,
  newDependentErrors,
  referencedFilePaths,
  touchedDeclarationPositions,
  touchedLinesOfEdit,
  type DependentBaseline,
  type TouchedLines,
} from "./lsp-dependent-diagnostics.js";
import {
  compareWithPreEditBaseline,
  preEditBaselineOf,
  type FileTexts,
  type PreEditBaseline,
} from "./lsp-pre-edit-baseline.js";
import {
  appendPostEditDiagnostics,
  type PostEditDiagnosticOutcome,
  type PostEditDiagnosticPath,
  type PostEditDiagnosticsResultPatch,
  type PostEditLspDiagnostic,
} from "./lsp-post-edit-diagnostics.js";
import {
  createPostEditDiagnosticsEntryData,
  POST_EDIT_DIAGNOSTICS_ENTRY_TYPE,
  PostEditDiagnosticsEntryDataSchema,
  renderPostEditDiagnosticsEntry,
} from "./lsp-post-edit-diagnostics-rendering.js";
import {
  convertLspProtocolPosition,
  normalizeLspPositionEncoding,
  type LspPositionEncoding,
} from "./lsp-position-encoding.js";
import {
  completeLspCommandArguments,
  formatLspCommandStatus,
  knownLspServerRoots,
  notifyLspCommand,
  parseLspCommandArguments,
  selectLspCommand,
} from "./lsp-command.js";
import { LspServerClient } from "./lsp-server-client.js";
import { writeLspEnablement } from "./lsp-settings-store.js";
import {
  LspServerManager,
  normalizeLspFilePath,
  type LspServerFailure,
} from "./lsp-server-manager.js";
import { createLspSessionFiles, type LspSessionFiles } from "./lsp-session-files.js";
import {
  LSP_RESULT_TOOL_NAMES,
  LspToolResultDetailsSchema,
  type LspWorkspaceEditPreviewRecord,
} from "./lsp-tool-contract.js";
import { registerLspTools } from "./lsp-tool.js";
import { truncateLspOutputText } from "./lsp-tool-output.js";
import { LspWorkspaceEditStore } from "./lsp-workspace-edit.js";
import { resolveLspSettings, type LspServerEnablement } from "./pi-lsp-settings.js";

/** Runtime construction effects kept narrow so lifecycle tests can select an isolated Pi agent directory. */
export interface PiLspLifecycleEffects {
  /** Return Pi's trust-aware global settings directory. */
  getAgentDirectory(): string;
  /** Time one edit call's pre-edit work (Pre-edit Baseline pull and dependent scan) may take; defaults to 20 seconds. */
  readonly dependentScanBudgetMs?: number;
}

interface ActivePiLspSession {
  readonly cwd: string;
  configuredEnablement: ReadonlyMap<string, LspServerEnablement>;
  readonly includeHintDiagnostics: boolean;
  readonly manager: LspServerManager<LspServerClient>;
  readonly sessionFiles: LspSessionFiles;
  readonly workspaceEdits: LspWorkspaceEditStore;
}

const productionPiLspLifecycleEffects: PiLspLifecycleEffects = {
  getAgentDirectory: getAgentDir,
};
const ENABLEMENT_ENTRY_TYPE = "pi-lsp-enablement";
const EnablementEntrySchema = Type.Object(
  { serverId: Type.String({ minLength: 1 }), enabled: Type.Boolean() },
  { additionalProperties: false },
);

function branchEnablement(entries: readonly SessionEntry[]): ReadonlyMap<string, boolean> {
  const overrides = new Map<string, boolean>();
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === ENABLEMENT_ENTRY_TYPE &&
      Value.Check(EnablementEntrySchema, entry.data)
    ) {
      overrides.set(entry.data.serverId, entry.data.enabled);
    }
  }
  return overrides;
}

const DiagnosticMarkupContentSchema = Type.Object(
  {
    kind: Type.String(),
    value: Type.String(),
  },
  { additionalProperties: false },
);
const AppendedTextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: false },
);
function branchLspToolResultDetails(
  entries: readonly SessionEntry[],
): readonly LspWorkspaceEditPreviewRecord[] {
  const records = new Map<string, LspWorkspaceEditPreviewRecord>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    // Results of the legacy `lsp` tool stay recognized so resumed sessions keep their previews.
    if (message.role !== "toolResult" || !LSP_RESULT_TOOL_NAMES.has(message.toolName)) continue;
    if (!Value.Check(LspToolResultDetailsSchema, message.details)) continue;
    const details = message.details;
    for (const record of details.preview_records ?? []) {
      records.set(record.preview_id, record);
    }
    if (details.kind === "workspace_edit_preview") {
      records.set(details.preview_record.preview_id, details.preview_record);
      continue;
    }
    if (details.kind === "operation") continue;
    const applied = records.get(details.preview_id);
    if (applied !== undefined) {
      records.set(details.preview_id, { ...applied, state: "applied" });
    }
  }
  return [...records.values()];
}

const DiagnosticCodeSchema = Type.Union([Type.String(), Type.Number()]);

/**
 * Normalize one protocol Diagnostic; a missing severity is an Error, so default hint filtering
 * keeps it. A `source` or `code` that breaks the protocol's types is left out.
 */
export function normalizedDiagnosticOutcome(
  diagnostic: Diagnostic,
  serverId: string,
  filePath: string,
  documentText: string,
  positionEncoding: LspPositionEncoding,
): PostEditDiagnosticOutcome {
  const start = convertLspProtocolPosition(documentText, diagnostic.range.start, positionEncoding);
  const end = convertLspProtocolPosition(documentText, diagnostic.range.end, positionEncoding);
  const normalized: PostEditLspDiagnostic = {
    serverId,
    path: filePath,
    line: start.line,
    character: start.character,
    endLine: end.line,
    endCharacter: end.character,
    // LSP leaves a missing severity to the client; treat it as an Error, like vscode-languageclient.
    severity: diagnostic.severity ?? 1,
    message: Value.Check(Type.String(), diagnostic.message)
      ? diagnostic.message
      : Value.Parse(DiagnosticMarkupContentSchema, diagnostic.message).value,
  };
  if (Value.Check(Type.String(), diagnostic.source)) normalized.source = diagnostic.source;
  if (Value.Check(DiagnosticCodeSchema, diagnostic.code)) normalized.code = diagnostic.code;
  return { kind: "diagnostic", diagnostic: normalized };
}

/** Classify a reportable Post-edit Diagnostics server failure by its failure code. */
export function failureDiagnosticOutcome(
  path: string,
  failure: LspServerFailure,
): PostEditDiagnosticOutcome {
  if (failure.code === "no-matching-server") {
    return { kind: "no_configured_server", path };
  }
  if (failure.code === "request-timeout") {
    return { kind: "timeout", path, serverId: failure.serverId };
  }
  return { kind: "unavailable_server", path, serverId: failure.serverId };
}

class ManagerPostEditDiagnosticsRunner {
  private readonly documentTexts = new Map<string, string>();

  constructor(
    private readonly session: ActivePiLspSession,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /**
   * The text each file with findings had when its positions were converted, so a finding's
   * identity reads the same line its position points at.
   */
  get texts(): FileTexts {
    return this.documentTexts;
  }

  /**
   * Pull each path's diagnostics from every capable Server Instance. `onServerOutcomes` sees each
   * server's outcomes as soon as it answers, before slower servers finish.
   */
  async run(
    paths: readonly PostEditDiagnosticPath[],
    onServerOutcomes?: (outcomes: readonly PostEditDiagnosticOutcome[]) => void,
  ): Promise<readonly PostEditDiagnosticOutcome[]> {
    const outcomes: PostEditDiagnosticOutcome[] = [];
    for (const { path } of paths) {
      const filePath = resolve(this.session.cwd, normalizeLspFilePath(path));
      const result = await this.session.manager.runRead(
        filePath,
        undefined,
        {
          method: DocumentDiagnosticRequest.method,
          isSupportedBy: (client) => client.hasCapability(DocumentDiagnosticRequest.method),
        },
        async (client, route): Promise<readonly PostEditDiagnosticOutcome[]> => {
          const serverOutcomes = await this.pullServer(
            client,
            route.serverId,
            route.language.languageId,
            filePath,
          );
          onServerOutcomes?.(serverOutcomes);
          return serverOutcomes;
        },
      );
      const successfulOutcomes = result.successes.flatMap(({ value }) => value);
      outcomes.push(...successfulOutcomes);
      outcomes.push(
        ...result.failures.flatMap((failure) =>
          failure.code === "no-capable-server" || failure.code === "server-disabled"
            ? []
            : [failureDiagnosticOutcome(filePath, failure)],
        ),
      );
    }
    return outcomes;
  }

  private async pullServer(
    client: LspServerClient,
    serverId: string,
    languageId: string,
    filePath: string,
  ): Promise<readonly PostEditDiagnosticOutcome[]> {
    const diagnostics = await client.documentDiagnostics(filePath, languageId, this.signal);
    if (diagnostics.status === "timeout") {
      return [{ kind: "timeout", path: filePath, serverId }];
    }
    if (diagnostics.diagnostics.length === 0) {
      return [{ kind: "no_diagnostics", path: filePath, serverId }];
    }
    const documentText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(filePath),
    );
    this.documentTexts.set(filePath, documentText);
    const encoding = normalizeLspPositionEncoding(client.positionEncoding);
    return diagnostics.diagnostics.map((diagnostic) =>
      normalizedDiagnosticOutcome(diagnostic, serverId, filePath, documentText, encoding),
    );
  }
}

/** A file a native mutation tool call is about to change, its text before, and the lines it touches. */
interface PreEditTarget {
  readonly path: string;
  readonly text: string;
  readonly touched: TouchedLines;
}

/**
 * Locate what a native `edit` or `write` call will change before it runs; other tools have no
 * pre-edit work.
 */
async function preEditTarget(
  event: ToolCallEvent,
  cwd: string,
): Promise<PreEditTarget | undefined> {
  if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
  const { input } = event;
  if (!Value.Check(Type.Object({ path: Type.String() }, { additionalProperties: true }), input)) {
    return undefined;
  }
  const path = resolve(cwd, normalizeLspFilePath(input.path));
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(path),
    );
    return {
      path,
      text,
      touched: event.toolName === "edit" ? touchedLinesOfEdit(text, input) : "all",
    };
  } catch {
    // A new file has no baseline or dependents, and an unreadable one has no text to key them by.
    return undefined;
  }
}

/**
 * Pull the changed file's diagnostics before the edit from every server that reports after it,
 * collecting each server's outcomes as it answers, so a slow server costs only its own baseline.
 */
async function pullPreEditBaseline(
  session: ActivePiLspSession,
  target: PreEditTarget,
  signal: AbortSignal,
  collected: PostEditDiagnosticOutcome[],
): Promise<void> {
  const runner = new ManagerPostEditDiagnosticsRunner(session, signal);
  await runner.run([{ path: target.path }], (outcomes) => collected.push(...outcomes));
}

/**
 * Before an edit runs, find the files that reference the declarations it touches and record the
 * errors they already have, so the result reports only what the edit newly breaks. A pull-only
 * server such as `tsc --lsp` publishes no workspace diagnostics, has opened none of the dependents,
 * and cannot be asked who imports a file, but it answers `textDocument/references`. The scan is
 * bounded by declaration, file, and time caps.
 */
async function scanDependentFiles(
  session: ActivePiLspSession,
  target: PreEditTarget,
  signal: AbortSignal,
): Promise<DependentBaseline | undefined> {
  const read = await session.manager.runRead(
    target.path,
    undefined,
    {
      method: ReferencesRequest.method,
      // The dependents' diagnostics are pulled, so a server without document diagnostics (one that
      // only pushes) would pay for the scan and report nothing.
      isSupportedBy: (client) =>
        client.hasCapability(ReferencesRequest.method) &&
        client.hasCapability(DocumentSymbolRequest.method) &&
        client.hasCapability(DocumentDiagnosticRequest.method),
    },
    async (client, route): Promise<readonly string[]> => {
      const document = await client.synchronizeDocument(target.path, route.language.languageId);
      const symbols = await client.request<unknown>(
        DocumentSymbolRequest.method,
        { textDocument: { uri: document.uri } },
        signal,
      );
      const found = new Set<string>();
      for (const position of touchedDeclarationPositions(symbols, target.touched)) {
        const references = await client.request<unknown>(
          ReferencesRequest.method,
          { textDocument: { uri: document.uri }, position, context: { includeDeclaration: false } },
          signal,
        );
        for (const path of referencedFilePaths(references, new Set([target.path]))) found.add(path);
      }
      return [...found];
    },
  );
  const candidates = [...new Set(read.successes.flatMap(({ value }) => value))];
  if (candidates.length === 0) return undefined;
  const { files, omittedFiles } = capDependentFiles(candidates);
  const { outcomes, texts } = await pullDependentFiles(
    new ManagerPostEditDiagnosticsRunner(session, signal),
    files,
  );
  const { keys, unchecked } = groupErrorKeys(files, outcomes, texts);
  return {
    files: files.filter((file) => keys.has(file)),
    omittedFiles: omittedFiles + unchecked,
    errorKeys: keys,
    scanTimedOut: false,
  };
}

/** The result of pulling diagnostics for dependent files, with the text each finding's line is read from. */
interface DependentPull {
  readonly outcomes: readonly PostEditDiagnosticOutcome[];
  readonly texts: FileTexts;
}

/** Pull the dependent files' diagnostics concurrently. */
async function pullDependentFiles(
  runner: ManagerPostEditDiagnosticsRunner,
  files: readonly string[],
): Promise<DependentPull> {
  const outcomes = (await Promise.all(files.map((path) => runner.run([{ path }])))).flat();
  return { outcomes, texts: runner.texts };
}

/** What a native `edit` or `write` call recorded before it ran, until its result arrives. */
interface PreEditWork {
  /** The changed file's Pre-edit Baseline. */
  readonly baseline: PreEditBaseline;
  /** The dependent files' Pre-edit Baseline, when the scan found dependents or ran out of time. */
  readonly dependents?: DependentBaseline;
}

async function appendSessionPostEditDiagnostics(
  event: ToolResultEvent,
  session: ActivePiLspSession,
  context: ExtensionContext,
  work: PreEditWork | undefined,
): Promise<PostEditDiagnosticsResultPatch | undefined> {
  const dependents = work?.dependents;
  const runner = new ManagerPostEditDiagnosticsRunner(session, context.signal);
  const patch = await appendPostEditDiagnostics(event, (paths) => runner.run(paths), session.cwd, {
    includeHints: session.includeHintDiagnostics,
    preEditBaseline:
      work === undefined
        ? undefined
        : async (outcomes) => compareWithPreEditBaseline(work.baseline, outcomes, runner.texts),
    dependentDiagnostics:
      dependents === undefined
        ? undefined
        : async (paths: readonly PostEditDiagnosticPath[]) => {
            const changed = new Set(
              paths.map(({ path }) => resolve(session.cwd, normalizeLspFilePath(path))),
            );
            const files = dependents.files.filter((file) => !changed.has(file));
            const { outcomes, texts } = await pullDependentFiles(runner, files);
            return newDependentErrors(dependents, files, outcomes, texts);
          },
  });
  if (patch === undefined) return undefined;
  const appendedValue = patch.content.at(-1);
  if (!Value.Check(AppendedTextContentSchema, appendedValue)) return undefined;
  let appended: Static<typeof AppendedTextContentSchema> = appendedValue;
  const truncation = await truncateLspOutputText(
    appended.text,
    session.sessionFiles,
    "diagnostics",
  );
  if (truncation.spillPath !== undefined) {
    appended = { type: "text", text: truncation.text };
  }
  return { ...patch, content: [...event.content, appended] };
}

/** Own settings, tool registration, replay, diagnostics middleware, and resource shutdown for one extension instance. */
export class PiLspLifecycleController {
  private readonly pendingPostEditDiagnosticOutcomes: PostEditDiagnosticOutcome[] = [];
  private readonly preEditWork = new Map<string, PreEditWork>();
  private session: ActivePiLspSession | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private historyRevision = 0;

  /** Bind one lifecycle controller to Pi and production or test construction effects. */
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly effects: PiLspLifecycleEffects,
  ) {}

  /** Register Pi LSP lifecycle handlers and model-invisible diagnostics entry rendering. */
  register(): void {
    registerLspTools(this.pi, () => this.activeSession());
    this.pi.registerCommand("lsp", {
      description: "Manage language-server enablement and Instances",
      getArgumentCompletions: (prefix) =>
        completeLspCommandArguments(prefix, this.session?.manager),
      handler: (args, context) => this.handleCommand(args, context),
    });
    this.pi.registerEntryRenderer(
      POST_EDIT_DIAGNOSTICS_ENTRY_TYPE,
      expandEntryOnClick((entry, options, theme) =>
        Value.Check(PostEditDiagnosticsEntryDataSchema, entry.data)
          ? renderPostEditDiagnosticsEntry(entry.data, options, theme)
          : undefined,
      ),
    );
    this.pi.on("session_start", (_event, context) => this.startSession(context));
    this.pi.on("session_tree", (_event, context) => {
      this.historyRevision += 1;
      return this.restoreEnablement(context);
    });
    this.pi.on("tool_call", (event, context) => this.handleToolCall(event, context));
    this.pi.on("tool_result", (event, context) => this.handleToolResult(event, context));
    this.pi.on("turn_end", () => this.flushPostEditDiagnosticsEntry());
    this.pi.on("session_shutdown", () => this.shutdownSession());
  }

  private async startSession(context: ExtensionContext): Promise<void> {
    await this.shutdownSession();
    this.pendingPostEditDiagnosticOutcomes.length = 0;
    const settingsManager = SettingsManager.create(context.cwd, this.effects.getAgentDirectory(), {
      projectTrusted: context.isProjectTrusted(),
    });
    const settings = resolveLspSettings(settingsManager);
    if (settings.warnings.length > 0) {
      context.ui.notify(
        noticeText("LSP", `settings:\n- ${settings.warnings.join("\n- ")}`),
        "warning",
      );
    }

    const sessionFiles = await createLspSessionFiles(context.sessionManager.getSessionDir());
    const workspaceEdits = new LspWorkspaceEditStore();
    const replay = workspaceEdits.replayPreviewRecords(
      branchLspToolResultDetails(context.sessionManager.getBranch()),
    );
    if (replay > 0) {
      context.ui.notify(
        noticeText(
          "LSP",
          `ignored ${replay} invalid Workspace Edit Preview record${replay === 1 ? "" : "s"} on the active session branch.`,
        ),
        "warning",
      );
    }

    const manager = new LspServerManager<LspServerClient>({
      cwd: context.cwd,
      settings,
      startClient: async ({ definition, onUnavailable, rootPath, timeouts, signal }) => {
        let client: LspServerClient | undefined;
        client = await LspServerClient.start({
          serverId: definition.id,
          rootPath,
          command: definition.command,
          args: definition.args,
          environment: { ...definition.environment },
          initializationOptions: definition.initializationOptions ?? null,
          settings: definition.settings ?? null,
          timeouts,
          signal,
          stderrPath: await sessionFiles.getServerStderrPath(`${definition.id}\u0000${rootPath}`),
          onUnavailable,
          onWorkspaceEdit: async (edit) =>
            (
              await workspaceEdits.createPreview({
                edit,
                serverId: definition.id,
                positionEncoding: client?.positionEncoding ?? PositionEncodingKind.UTF16,
              })
            ).preview_id,
        });
        return client;
      },
    });
    this.session = {
      cwd: context.cwd,
      configuredEnablement: settings.enablement,
      includeHintDiagnostics: settings.includeHintDiagnostics,
      manager,
      sessionFiles,
      workspaceEdits,
    };
    await this.restoreEnablement(context);
  }

  private restoreEnablement(context: ExtensionContext): Promise<void> | undefined {
    const session = this.session;
    if (session === undefined) return undefined;
    return session.manager.setEnablement(
      session.configuredEnablement,
      branchEnablement(context.sessionManager.getBranch()),
    );
  }

  private async handleCommand(args: string, context: ExtensionCommandContext): Promise<void> {
    const session = this.session;
    const revision = this.historyRevision;
    const isCurrent = () => this.session === session && this.historyRevision === revision;
    try {
      if (session === undefined) throw new Error("Pi LSP: session runtime is inactive");
      if (args.trim() === "" && !context.hasUI) {
        notifyLspCommand(context, formatLspCommandStatus(session.manager), "info");
        return;
      }
      const command =
        args.trim() === ""
          ? await selectLspCommand(session.manager, context, isCurrent)
          : parseLspCommandArguments(args);
      if (command === undefined || !isCurrent()) return;
      if (
        !session.manager.getStatus().servers.some(({ serverId }) => serverId === command.serverId)
      ) {
        throw new Error(`Pi LSP: unknown Server Definition ${command.serverId}`);
      }
      if (command.action === "stop") {
        const roots = knownLspServerRoots(session.manager, command.serverId);
        let rootPath =
          command.rootPath === undefined
            ? roots[0]
            : resolve(session.cwd, normalizeLspFilePath(command.rootPath));
        if (command.rootPath === undefined && roots.length > 1) {
          if (!context.hasUI)
            throw new Error(
              `Pi LSP: multiple roots for ${command.serverId}; use /lsp stop <server-id> <root>: ${roots.join(", ")}`,
            );
          rootPath = await context.ui.select(
            `Stop ${command.serverId}: select workspace root`,
            roots,
          );
          if (rootPath === undefined || !isCurrent()) return;
        }
        if (rootPath === undefined || !roots.includes(rootPath))
          throw new Error(
            `Pi LSP: no known Instance for ${command.serverId} at ${rootPath ?? "any root"}`,
          );
        await session.manager.stopServer(command.serverId, rootPath);
        if (isCurrent())
          notifyLspCommand(
            context,
            `Stopped ${command.serverId} at ${rootPath}; ${session.manager.getEnablement(command.serverId).enabled ? "lazy startup remains permitted" : "the Server Definition remains disabled"}.`,
            "info",
          );
        return;
      }
      const enabled = command.action === "enable";
      if (command.scope === "session") {
        this.pi.appendEntry(ENABLEMENT_ENTRY_TYPE, { serverId: command.serverId, enabled });
      } else {
        await writeLspEnablement({
          agentDirectory: this.effects.getAgentDirectory(),
          cwd: session.cwd,
          projectTrusted: context.isProjectTrusted(),
          scope: command.scope,
          serverId: command.serverId,
          enabled,
        });
        if (this.session !== session) return;
        session.configuredEnablement = resolveLspSettings(
          SettingsManager.create(session.cwd, this.effects.getAgentDirectory(), {
            projectTrusted: context.isProjectTrusted(),
          }),
        ).enablement;
      }
      await this.restoreEnablement(context);
      if (!isCurrent()) return;
      const effective = session.manager.getEnablement(command.serverId);
      const masked = effective.scope !== command.scope;
      notifyLspCommand(
        context,
        `${command.serverId} ${enabled ? "enabled" : "disabled"} at ${command.scope} scope.${masked ? ` Change masked by ${effective.scope} override; effectively ${effective.enabled ? "enabled" : "disabled"}.` : ""}`,
        masked ? "warning" : "info",
      );
    } catch (error) {
      if (isCurrent())
        notifyLspCommand(context, error instanceof Error ? error.message : String(error), "error");
    }
  }

  private activeSession(): ActivePiLspSession {
    if (this.session === undefined) throw new Error("Pi LSP: session runtime is inactive");
    return this.session;
  }

  /**
   * Before a native edit runs, pull the changed file's Pre-edit Baseline and scan for dependent
   * files, concurrently under one time budget. It never blocks or alters the call. A server whose
   * baseline pull fails or has not answered when the budget runs out has no baseline, and a scan
   * that runs out of time is reported by the result.
   */
  private async handleToolCall(
    event: ToolCallEvent,
    context: ExtensionContext,
  ): Promise<undefined> {
    const session = this.session;
    if (session === undefined || (event.toolName !== "edit" && event.toolName !== "write")) {
      return undefined;
    }
    try {
      const target = await preEditTarget(event, session.cwd);
      if (target === undefined) return undefined;
      const budget = AbortSignal.timeout(
        this.effects.dependentScanBudgetMs ?? DEPENDENT_SCAN_BUDGET_MS,
      );
      const signal =
        context.signal === undefined ? budget : AbortSignal.any([context.signal, budget]);
      const timedOut = new Promise<"timed-out">((resolveTimeout) =>
        budget.addEventListener("abort", () => resolveTimeout("timed-out"), { once: true }),
      );
      const withinBudget = <T>(work: Promise<T>): Promise<T | "timed-out"> => {
        // Work that outlives the budget is aborted; whatever it settles with later is dropped.
        work.catch(() => undefined);
        return Promise.race([work, timedOut]);
      };
      const preEditOutcomes: PostEditDiagnosticOutcome[] = [];
      const [, scan] = await Promise.allSettled([
        withinBudget(pullPreEditBaseline(session, target, signal, preEditOutcomes)),
        withinBudget(scanDependentFiles(session, target, signal)),
      ]);
      if (this.session !== session) return undefined;
      // Servers that had not answered by now have no baseline. Pi runs a batch's `tool_call`s
      // before executing any of them, so the text read before the pull is the text it saw.
      const baseline = preEditBaselineOf(target.path, preEditOutcomes, target.text);
      const dependents: DependentBaseline | undefined =
        scan.status === "rejected"
          ? undefined
          : scan.value === "timed-out"
            ? { files: [], omittedFiles: 0, errorKeys: new Map(), scanTimedOut: true }
            : scan.value;
      this.preEditWork.set(
        event.toolCallId,
        dependents === undefined ? { baseline } : { baseline, dependents },
      );
    } catch {
      // The edit proceeds without a Pre-edit Baseline or dependent-file feedback.
    }
    return undefined;
  }

  private handleToolResult(
    event: ToolResultEvent,
    context: ExtensionContext,
  ): Promise<ToolResultEventResult | undefined> | undefined {
    const session = this.session;
    const work = this.preEditWork.get(event.toolCallId);
    this.preEditWork.delete(event.toolCallId);
    if (session === undefined) return undefined;
    return appendSessionPostEditDiagnostics(event, session, context, work).then((patch) => {
      if (patch === undefined) return undefined;
      this.pendingPostEditDiagnosticOutcomes.push(...patch.outcomes);
      const result: ToolResultEventResult = {
        content: patch.content,
        details: patch.details,
        isError: patch.isError,
      };
      // Pi drops structured content whose content was replaced unless the handler returns it.
      if (patch.structuredContent !== undefined) result.structuredContent = patch.structuredContent;
      return result;
    });
  }

  private flushPostEditDiagnosticsEntry(): void {
    const session = this.session;
    const outcomes = this.pendingPostEditDiagnosticOutcomes.splice(0);
    // A call that never produced a result (blocked or aborted) leaves its pre-edit work behind.
    this.preEditWork.clear();
    if (session === undefined) return;
    const entry = createPostEditDiagnosticsEntryData(session.cwd, outcomes);
    if (entry !== undefined) this.pi.appendEntry(POST_EDIT_DIAGNOSTICS_ENTRY_TYPE, entry);
  }

  private async shutdownSession(): Promise<void> {
    if (this.session === undefined) {
      await this.shutdownPromise;
      return;
    }
    const session = this.session;
    this.session = undefined;
    this.pendingPostEditDiagnosticOutcomes.length = 0;
    this.preEditWork.clear();
    const shutdown = (async () => {
      try {
        await session.manager.shutdown();
      } finally {
        await session.sessionFiles.close();
      }
    })();
    this.shutdownPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = undefined;
    }
  }
}

/** Compose the source-TypeScript Pi LSP extension without starting a language server at load time. */
export function createPiLspExtension(
  effects: PiLspLifecycleEffects = productionPiLspLifecycleEffects,
): ExtensionFactory {
  return (pi) => new PiLspLifecycleController(pi, effects).register();
}

const piLspExtension = createPiLspExtension();

export default piLspExtension;
