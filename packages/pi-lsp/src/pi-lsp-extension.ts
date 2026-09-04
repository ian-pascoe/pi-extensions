import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionEntry,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  DocumentDiagnosticRequest,
  PositionEncodingKind,
  type Diagnostic,
} from "vscode-languageserver-protocol/node";
import {
  appendPostEditDiagnostics,
  type PostEditDiagnosticOutcome,
  type PostEditDiagnosticPath,
  type PostEditDiagnosticsResultPatch,
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
import { LspServerClient } from "./lsp-server-client.js";
import { LspServerManager, normalizeLspFilePath } from "./lsp-server-manager.js";
import { createLspSessionFiles, type LspSessionFiles } from "./lsp-session-files.js";
import {
  LspToolResultDetailsSchema,
  type LspWorkspaceEditPreviewRecord,
} from "./lsp-tool-contract.js";
import { registerLspTool } from "./lsp-tool.js";
import { truncateLspOutputText } from "./lsp-tool-output.js";
import { LspWorkspaceEditStore } from "./lsp-workspace-edit.js";
import { resolveLspSettings } from "./pi-lsp-settings.js";

/** Runtime construction effects kept narrow so lifecycle tests can select an isolated Pi agent directory. */
export interface PiLspLifecycleEffects {
  /** Return Pi's trust-aware global settings directory. */
  getAgentDirectory(): string;
}

interface ActivePiLspSession {
  readonly cwd: string;
  readonly manager: LspServerManager<LspServerClient>;
  readonly sessionFiles: LspSessionFiles;
  readonly workspaceEdits: LspWorkspaceEditStore;
}

const productionPiLspLifecycleEffects: PiLspLifecycleEffects = {
  getAgentDirectory: getAgentDir,
};
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
    if (message.role !== "toolResult" || message.toolName !== "lsp") continue;
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

function normalizedDiagnosticOutcome(
  diagnostic: Diagnostic,
  serverId: string,
  filePath: string,
  documentText: string,
  positionEncoding: LspPositionEncoding,
): PostEditDiagnosticOutcome {
  const position = convertLspProtocolPosition(
    documentText,
    diagnostic.range.start,
    positionEncoding,
  );
  return {
    kind: "diagnostic",
    diagnostic: {
      serverId,
      path: filePath,
      line: position.line,
      character: position.character,
      severity: diagnostic.severity ?? 4,
      message: Value.Check(Type.String(), diagnostic.message)
        ? diagnostic.message
        : Value.Parse(DiagnosticMarkupContentSchema, diagnostic.message).value,
    },
  };
}

function failureDiagnosticOutcome(
  path: string,
  failure: { readonly code: string; readonly message: string; readonly serverId: string },
): PostEditDiagnosticOutcome {
  if (failure.code === "no-matching-server") {
    return { kind: "no_configured_server", path };
  }
  if (failure.message.toLowerCase().includes("timed out")) {
    return { kind: "timeout", path, serverId: failure.serverId };
  }
  return { kind: "unavailable_server", path, serverId: failure.serverId };
}

class ManagerPostEditDiagnosticsRunner {
  constructor(
    private readonly session: ActivePiLspSession,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async run(
    paths: readonly PostEditDiagnosticPath[],
  ): Promise<readonly PostEditDiagnosticOutcome[]> {
    const outcomes: PostEditDiagnosticOutcome[] = [];
    for (const { path } of paths) {
      const filePath = resolve(this.session.cwd, normalizeLspFilePath(path));
      const result = await this.session.manager.runRead(
        filePath,
        undefined,
        (client) => client.hasCapability(DocumentDiagnosticRequest.method),
        async (client, route): Promise<readonly PostEditDiagnosticOutcome[]> => {
          const diagnostics = await client.documentDiagnostics(
            filePath,
            route.language.languageId,
            this.signal,
          );
          if (diagnostics.status === "timeout") {
            return [{ kind: "timeout", path: filePath, serverId: route.serverId }];
          }
          if (diagnostics.diagnostics.length === 0) {
            return [{ kind: "no_diagnostics", path: filePath }];
          }
          const documentText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            await readFile(filePath),
          );
          const encoding = normalizeLspPositionEncoding(client.positionEncoding);
          return diagnostics.diagnostics.map((diagnostic) =>
            normalizedDiagnosticOutcome(
              diagnostic,
              route.serverId,
              filePath,
              documentText,
              encoding,
            ),
          );
        },
      );
      const successfulOutcomes = result.successes.flatMap(({ value }) => value);
      outcomes.push(...successfulOutcomes);
      outcomes.push(
        ...result.failures.flatMap((failure) =>
          failure.code === "no-capable-server" ||
          (failure.code === "no-matching-server" &&
            this.session.manager.hasConfiguredLanguageServerForFile(filePath))
            ? []
            : [failureDiagnosticOutcome(filePath, failure)],
        ),
      );
    }
    return outcomes;
  }
}

async function appendSessionPostEditDiagnostics(
  event: ToolResultEvent,
  session: ActivePiLspSession,
  context: ExtensionContext,
): Promise<PostEditDiagnosticsResultPatch | undefined> {
  const patch = await appendPostEditDiagnostics(event, (paths) =>
    new ManagerPostEditDiagnosticsRunner(session, context.signal).run(paths),
  );
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
  const partialApplyFailure =
    event.toolName === "lsp" &&
    Value.Check(LspToolResultDetailsSchema, event.details) &&
    event.details.kind === "workspace_edit_apply" &&
    event.details.state === "partial_failure";
  return {
    ...patch,
    content: [...event.content, appended],
    isError: partialApplyFailure || patch.isError,
  };
}

/** Own settings, tool registration, replay, diagnostics middleware, and resource shutdown for one extension instance. */
export class PiLspLifecycleController {
  private readonly pendingPostEditDiagnosticOutcomes: PostEditDiagnosticOutcome[] = [];
  private session: ActivePiLspSession | undefined;
  private shutdownPromise: Promise<void> | undefined;

  /** Bind one lifecycle controller to Pi and production or test construction effects. */
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly effects: PiLspLifecycleEffects,
  ) {}

  /** Register Pi LSP lifecycle handlers and model-invisible diagnostics entry rendering. */
  register(): void {
    registerLspTool(this.pi, () => this.activeSession());
    this.pi.registerEntryRenderer(POST_EDIT_DIAGNOSTICS_ENTRY_TYPE, (entry, { expanded }, theme) =>
      Value.Check(PostEditDiagnosticsEntryDataSchema, entry.data)
        ? renderPostEditDiagnosticsEntry(entry.data, expanded, theme)
        : undefined,
    );
    this.pi.on("session_start", (_event, context) => this.startSession(context));
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
      context.ui.notify(`Pi LSP settings:\n- ${settings.warnings.join("\n- ")}`, "warning");
    }

    const sessionFiles = await createLspSessionFiles(context.sessionManager.getSessionDir());
    const workspaceEdits = new LspWorkspaceEditStore();
    const replay = workspaceEdits.replayPreviewRecords(
      branchLspToolResultDetails(context.sessionManager.getBranch()),
    );
    if (replay > 0) {
      context.ui.notify(
        `Pi LSP ignored ${replay} invalid Workspace Edit Preview record${replay === 1 ? "" : "s"} on the active session branch.`,
        "warning",
      );
    }

    const manager = new LspServerManager<LspServerClient>({
      cwd: context.cwd,
      settings,
      startClient: async ({ definition, onUnavailable, rootPath, timeouts }) => {
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
    this.session = { cwd: context.cwd, manager, sessionFiles, workspaceEdits };
  }

  private activeSession(): ActivePiLspSession {
    if (this.session === undefined) throw new Error("Pi LSP: session runtime is inactive");
    return this.session;
  }

  private handleToolResult(
    event: ToolResultEvent,
    context: ExtensionContext,
  ):
    | Promise<
        | {
            readonly content: ToolResultEvent["content"];
            readonly details: ToolResultEvent["details"];
            readonly isError: boolean;
          }
        | undefined
      >
    | undefined {
    const session = this.session;
    if (session === undefined) return undefined;
    return appendSessionPostEditDiagnostics(event, session, context).then((patch) => {
      if (patch === undefined) return undefined;
      this.pendingPostEditDiagnosticOutcomes.push(...patch.outcomes);
      return { content: patch.content, details: patch.details, isError: patch.isError };
    });
  }

  private flushPostEditDiagnosticsEntry(): void {
    const session = this.session;
    const outcomes = this.pendingPostEditDiagnosticOutcomes.splice(0);
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
