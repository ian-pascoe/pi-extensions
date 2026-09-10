import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { resolveKnownToolOutputSchema } from "./codemode-known-output-schemas.js";
import {
  renderCodeModeToolCatalogue,
  searchCodeModeToolCatalogue,
  type CodeModeToolCatalogue,
  type CodeModeToolCatalogueTool,
  type CodeModeToolSchema,
} from "./codemode-tool-catalog.js";
import { CodeModeObserverUiController } from "./codemode-observer-ui.js";
import {
  CODEMODE_NESTED_TOOLS_ENTRY_TYPE,
  CodeModeNestedToolsTranscriptSchema,
  captureCodeModeNestedToolCall,
  completeCodeModeNestedToolCall,
  codeModeNestedToolResultData,
  renderCodeModeNestedToolsTranscript,
  type CodeModeNestedToolSnapshot,
} from "./codemode-nested-tool-rendering.js";
import {
  CodeModeSessionCoordinator,
  type CodeModeNestedToolBatch,
  type CodeModeNestedToolBatchResult,
  type CodeModeNestedToolResult,
  type CodeModeObserverSnapshot,
} from "./codemode-session-coordinator.js";
import { CODEMODE_SYSTEM_RUNTIME } from "./codemode-runtime.js";
import { createCodeModeSessionFiles, type CodeModeSessionFiles } from "./codemode-session-files.js";
import {
  CODEMODE_SEARCH_TOOL_NAME,
  CodeModeResultDetailsSchema,
  createCodeModeFailure,
  createCodeModePending,
  isCodeModeJsonObject,
  parseCodeModeJsonValue,
  type CodeModeJsonValue,
  type CodeModeResultDetails,
  type CodeModeToolOperations,
} from "./codemode-tool-contract.js";
import { createRenderedCodeModeToolDefinitions } from "./codemode-tool-rendering.js";
import {
  decideCodeModeToolExposure,
  installCodeModeToolExposure,
  type CodeModeToolExposureDecision,
  type InstalledCodeModeToolExposure,
} from "./codemode-tool-exposure.js";
import { capturePiAgentSession, type CapturedPiAgentSession } from "./pi-agent-session-capture.js";
import { resolveCodeModeSettings } from "./pi-codemode-settings.js";
import {
  executePiToolBridgeBatch,
  type ExecutePiToolBridgeBatchOptions,
  type PiToolBridgeCall,
  type PiToolBridgeValue,
} from "./pi-tool-bridge.js";

const CODEMODE_EXECUTE_DESCRIPTION =
  "Execute a TypeScript Cell in a persistent isolated Deno CodeMode Session. Reuse a Session ID to retain Notebook Bindings; an unknown supplied ID creates that Session. A new Session reclaims the least-recently-used idle Session at capacity. Use the read-only tools object for registered Pi tools. Return final result data with a top-level return statement. Reserve console.log, console.info, console.warn, console.error, and console.debug for diagnostics; captured output arrives only with terminal results. Discover tools with direct codemode_search before a Cell or tools.codemode_search inside one. Search an intent for exact flat names, then search an exact name for its complete declaration. Call tools[name](input).";
const CODEMODE_SEARCH_BATCH_LIMIT = 20;
const CodeModeToolSchemaMetadataSchema = Type.Union([
  Type.Boolean(),
  Type.Object({}, { additionalProperties: true }),
]);

type MutableCatalogueTool = {
  -readonly [Key in keyof CodeModeToolCatalogueTool]: CodeModeToolCatalogueTool[Key];
};
type MutableBridgeOptions = {
  -readonly [Key in keyof ExecutePiToolBridgeBatchOptions]: ExecutePiToolBridgeBatchOptions[Key];
};
type MutableNestedToolBatchResult = {
  -readonly [Key in keyof CodeModeNestedToolBatchResult]: CodeModeNestedToolBatchResult[Key];
};

type PendingCodeModeTranscript = {
  readonly ref: string;
  readonly cellOrdinal: number;
  readonly branchRevision: number;
  readonly originLeafId: string | null;
  readonly calls: Map<string, CodeModeNestedToolSnapshot>;
};

type PiCodeModeGeneration = {
  readonly captured: CapturedPiAgentSession;
  readonly context: ExtensionContext;
  readonly coordinator: CodeModeSessionCoordinator;
  readonly observer: CodeModeObserverUiController;
  readonly sessionFiles: CodeModeSessionFiles;
  readonly transcripts: Map<string, PendingCodeModeTranscript>;
  readonly transcriptRefs: Map<string, string>;
  readonly transcriptInvalidators: Map<string, () => void>;
  branchRevision: number;
  requestRender: () => void;
  exposure?: InstalledCodeModeToolExposure;
  decision: CodeModeToolExposureDecision;
  catalogue: CodeModeToolCatalogue;
  active: boolean;
};

type RegisteredToolDefinition = ReturnType<CapturedPiAgentSession["session"]["getToolDefinition"]>;

function codeModeToolCatalogueGroup(name: string, source: string | undefined): string {
  const mcpPrefix = "mcp__";
  if (name.startsWith(mcpPrefix)) {
    const serverEnd = name.indexOf("__", mcpPrefix.length);
    if (serverEnd > mcpPrefix.length) return `mcp:${name.slice(mcpPrefix.length, serverEnd)}`;
  }
  return source === undefined || source.length === 0 ? "registered" : source;
}

function registeredOutputSchema(
  definition: RegisteredToolDefinition,
): CodeModeToolSchema | undefined {
  if (definition === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(definition, "outputSchema");
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return Value.Check(CodeModeToolSchemaMetadataSchema, descriptor.value)
    ? descriptor.value
    : undefined;
}

function renderGenerationCatalogue(
  captured: CapturedPiAgentSession,
  decision: CodeModeToolExposureDecision,
) {
  const registry = captured.getToolRegistry();
  const toolInfoByName = new Map(
    captured.session.getAllTools().map((toolInfo) => [toolInfo.name, toolInfo]),
  );
  return renderCodeModeToolCatalogue(
    decision.codeModeNames.flatMap((name) => {
      const tool = registry.get(name);
      const toolInfo = toolInfoByName.get(name);
      const outputSchema =
        registeredOutputSchema(captured.session.getToolDefinition(name)) ??
        (toolInfo === undefined ? undefined : resolveKnownToolOutputSchema(toolInfo));
      if (tool === undefined) return [];
      const catalogueTool: MutableCatalogueTool = {
        name,
        group: codeModeToolCatalogueGroup(name, toolInfo?.sourceInfo.source),
        description: tool.description,
        inputSchema: tool.parameters,
      };
      if (outputSchema !== undefined) catalogueTool.outputSchema = outputSchema;
      return [catalogueTool];
    }),
  );
}

function latestCodeModeAssistantMessage(
  captured: CapturedPiAgentSession,
): AssistantMessage | undefined {
  for (const message of captured.agent.state.messages.toReversed()) {
    if (
      message.role === "assistant" &&
      message.content.some(
        (content) =>
          content.type === "toolCall" &&
          (content.name === "codemode_execute" ||
            content.name === "codemode_result" ||
            content.name === "codemode_cancel"),
      )
    ) {
      return message;
    }
  }
  return undefined;
}

function unavailableNestedResult(
  callId: string,
  code: string,
  message: string,
): CodeModeNestedToolResult {
  return { callId, outcome: "error", error: { code, message } };
}

function codeModeNestedBridgeValue(value: PiToolBridgeValue): CodeModeJsonValue {
  const content: CodeModeJsonValue[] = value.content.map((entry) =>
    entry.type === "text"
      ? { type: "text", text: entry.text }
      : { type: "image", data: entry.data, mimeType: entry.mimeType },
  );
  return value.details === undefined ? { content } : { content, details: value.details };
}

/** Owns Pi CodeMode startup, exposure/catalogue synchronization, and resource shutdown. */
class PiCodeModeLifecycleController {
  private generation: PiCodeModeGeneration | undefined;
  private readonly operations: CodeModeToolOperations = {
    execute: async (input, signal, onUpdate) => {
      const generation = this.generation;
      if (generation === undefined || !generation.active) {
        return {
          result: createCodeModeFailure(
            input.sessionId ?? "inactive",
            "runtime",
            "Pi CodeMode session generation is inactive",
          ),
        };
      }
      const operation = await generation.coordinator.execute(
        input,
        signal,
        onUpdate === undefined
          ? undefined
          : (update) => {
              // SAFETY: executeNestedToolBatch is the only update producer and replaces nested details with a schema-valid CodeMode pending result.
              onUpdate(update as AgentToolResult<CodeModeResultDetails>);
            },
      );
      if (operation.presentation === undefined) return operation;
      const key = `${operation.result.sessionId}:${operation.presentation.cell_ordinal}`;
      const ref = generation.transcriptRefs.get(key);
      // Async tools can finish while Pi is still awaiting an outer result hook.
      if (input.wait !== false) generation.transcriptRefs.delete(key);
      return ref === undefined
        ? operation
        : {
            ...operation,
            presentation: { ...operation.presentation, nested_transcript_ref: ref },
          };
    },
    result: async (input) => {
      const generation = this.generation;
      return generation === undefined || !generation.active
        ? {
            result: createCodeModeFailure(
              input.sessionId,
              "runtime",
              "Pi CodeMode session generation is inactive",
            ),
          }
        : generation.coordinator.result(input.sessionId);
    },
    cancel: async (input) => {
      const generation = this.generation;
      return generation === undefined || !generation.active
        ? {
            result: createCodeModeFailure(
              input.sessionId,
              "runtime",
              "Pi CodeMode session generation is inactive",
            ),
          }
        : generation.coordinator.cancel(input.sessionId);
    },
    sessions: async () => ({
      result: "success",
      sessions: [...(this.generation?.coordinator.listSessions() ?? [])],
    }),
    search: async (input) => {
      const generation = this.generation;
      if (generation === undefined || !generation.active) {
        throw new Error("Pi CodeMode session generation is inactive");
      }
      this.synchronizeGeneration(generation);
      const searched = searchCodeModeToolCatalogue(generation.catalogue.searchEntries, input);
      if (!searched.ok) throw new Error(searched.message);
      return searched.page;
    },
  };

  /** Creates inert lifecycle wiring around one Pi extension registration interface. */
  constructor(private readonly pi: ExtensionAPI) {}

  /** Registers stable public tools and inert lifecycle handlers without starting a process. */
  register(): void {
    this.pi.registerEntryRenderer(CODEMODE_NESTED_TOOLS_ENTRY_TYPE, (entry, options, theme) => {
      const data = entry.data;
      if (Value.Check(CodeModeNestedToolsTranscriptSchema, data) && data.ref !== undefined) {
        const liveOwner = [...(this.generation?.transcriptRefs.values() ?? [])].includes(data.ref);
        const savedOwner = this.generation?.context.sessionManager
          .buildContextEntries()
          .some(
            (item) =>
              item.type === "message" &&
              item.message.role === "toolResult" &&
              item.message.toolName === "codemode_execute" &&
              Value.Check(CodeModeResultDetailsSchema, item.message.details) &&
              item.message.details.presentation?.nested_transcript_ref === data.ref,
          );
        if (liveOwner || savedOwner) return undefined;
      }
      return renderCodeModeNestedToolsTranscript(
        data,
        options,
        theme,
        (name) => this.generation?.captured.session.getToolDefinition(name),
        () => this.generation?.requestRender(),
      );
    });
    this.pi.on("agent_end", () => this.generation?.transcriptRefs.clear());
    this.pi.on("session_tree", () => {
      if (this.generation !== undefined) {
        this.generation.branchRevision += 1;
        this.generation.transcriptRefs.clear();
        this.generation.transcriptInvalidators.clear();
      }
    });
    const [executeTool, resultTool, cancelTool, sessionsTool, searchTool] =
      createRenderedCodeModeToolDefinitions(
        this.operations,
        CODEMODE_EXECUTE_DESCRIPTION,
        undefined,
        this.renderNestedTranscript,
      );
    this.pi.registerTool(executeTool);
    this.pi.registerTool(resultTool);
    this.pi.registerTool(cancelTool);
    this.pi.registerTool(sessionsTool);
    this.pi.registerTool(searchTool);
    this.pi.on("session_start", async (_event, context) => this.startSession(context));
    this.pi.on("before_agent_start", () => this.synchronizeCurrentGeneration());
    this.pi.on("tool_execution_end", () => this.synchronizeCurrentGeneration());
    this.pi.on("session_shutdown", async () => this.shutdownSession());
  }

  private async startSession(context: ExtensionContext): Promise<void> {
    await this.shutdownSession();
    const capturedResult = capturePiAgentSession(this.pi);
    if (!capturedResult.ok) {
      this.notifyWarning(context, capturedResult.warning);
      return;
    }
    const captured = capturedResult.capabilities;
    const settings = resolveCodeModeSettings(captured.settingsManager);
    if (!settings.enabled) {
      this.notifyWarning(context, `Pi CodeMode disabled: ${settings.warning}`);
      return;
    }

    const registryNames = [...captured.getToolRegistry().keys()];
    const initialDecision = decideCodeModeToolExposure(
      registryNames,
      captured.session.getActiveToolNames(),
      settings.rules,
    );
    const initialCatalogue = renderGenerationCatalogue(captured, initialDecision);

    let sessionFiles: CodeModeSessionFiles;
    try {
      sessionFiles = await createCodeModeSessionFiles(context.sessionManager.getSessionDir());
    } catch (cause) {
      this.notifyWarning(
        context,
        `Pi CodeMode disabled: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }

    let generation: PiCodeModeGeneration;
    const observer = new CodeModeObserverUiController(context, CODEMODE_SYSTEM_RUNTIME);
    const coordinator = new CodeModeSessionCoordinator({
      maxSessions: settings.maxSessions,
      runtime: CODEMODE_SYSTEM_RUNTIME,
      resultSpillWriter: sessionFiles,
      onSnapshotChange: (snapshot) => {
        this.recordTranscriptTransitions(generation, snapshot);
        observer.onSnapshotChange(snapshot);
      },
      onUnexpectedFailure: (failure) => observer.onUnexpectedFailure(failure),
      getToolSnapshot: () => {
        if (!generation.active || this.generation !== generation) {
          return { names: [], searchEntries: [] };
        }
        this.synchronizeGeneration(generation);
        return {
          names: [
            CODEMODE_SEARCH_TOOL_NAME,
            ...generation.catalogue.searchEntries.map(({ name }) => name),
          ],
          searchEntries: generation.catalogue.searchEntries,
        };
      },
      executeToolBatch: (batch) => this.executeNestedToolBatch(generation, batch),
    });
    generation = {
      captured,
      context,
      coordinator,
      observer,
      sessionFiles,
      transcripts: new Map(),
      transcriptRefs: new Map(),
      transcriptInvalidators: new Map(),
      branchRevision: 0,
      requestRender: () => {},
      decision: initialDecision,
      catalogue: initialCatalogue,
      active: true,
    };
    this.generation = generation;
    if (context.mode === "tui") {
      // Entry renderers receive no TUI. Borrow only redraw through its public widget factory,
      // then remove the zero-line widget before a frame can display it.
      try {
        context.ui.setWidget("pi-codemode-transcript-render", (tui) => {
          generation.requestRender = () => {
            if (generation.active) tui.requestRender();
          };
          return { render: () => [], invalidate: () => {} };
        });
        context.ui.setWidget("pi-codemode-transcript-render", undefined);
      } catch {
        // Missing redraw support cannot disable CodeMode execution.
      }
    }

    try {
      generation.exposure = installCodeModeToolExposure(
        captured.session,
        () => captured.getToolRegistry().keys(),
        settings.rules,
        (decision) => {
          generation.decision = decision;
        },
      );
    } catch (cause) {
      generation.active = false;
      try {
        observer.dispose();
      } catch {
        // Observer cleanup is presentation-only; execution resources still require release.
      }
      await coordinator.shutdown();
      await sessionFiles.close();
      if (this.generation === generation) this.generation = undefined;
      this.notifyWarning(
        context,
        `Pi CodeMode disabled: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }

    const [executeTool, resultTool, cancelTool, sessionsTool, searchTool] =
      createRenderedCodeModeToolDefinitions(
        this.operations,
        CODEMODE_EXECUTE_DESCRIPTION,
        (sessionId) => coordinator.formatSessionPrefix(sessionId),
        this.renderNestedTranscript,
      );
    this.pi.registerTool(executeTool);
    this.pi.registerTool(resultTool);
    this.pi.registerTool(cancelTool);
    this.pi.registerTool(sessionsTool);
    this.pi.registerTool(searchTool);
    this.synchronizeGeneration(generation);
  }

  private readonly renderNestedTranscript = (
    ref: string,
    options: ToolRenderResultOptions,
    theme: Theme,
    invalidate: () => void,
  ) => {
    const entry = this.generation?.context.sessionManager
      .getBranch()
      .find(
        (item) =>
          item.type === "custom" &&
          item.customType === CODEMODE_NESTED_TOOLS_ENTRY_TYPE &&
          Value.Check(CodeModeNestedToolsTranscriptSchema, item.data) &&
          item.data.ref === ref,
      );
    if (entry?.type !== "custom") {
      const generation = this.generation;
      if (
        generation !== undefined &&
        [...generation.transcripts.values()].some((cell) => cell.ref === ref)
      ) {
        generation.transcriptInvalidators.set(ref, invalidate);
      }
      return undefined;
    }
    return renderCodeModeNestedToolsTranscript(
      entry.data,
      options,
      theme,
      (name) => this.generation?.captured.session.getToolDefinition(name),
      () => this.generation?.requestRender(),
    );
  };

  private recordTranscriptTransitions(
    generation: PiCodeModeGeneration,
    snapshot: CodeModeObserverSnapshot,
  ): void {
    if (!generation.active || this.generation !== generation) return;
    for (const session of snapshot.sessions) {
      const transcript = generation.transcripts.get(session.sessionId);
      if (session.current_cell !== undefined) {
        if (transcript?.cellOrdinal !== session.current_cell.ordinal) {
          const ref = CODEMODE_SYSTEM_RUNTIME.createSessionId();
          generation.transcriptRefs.set(
            `${session.sessionId}:${session.current_cell.ordinal}`,
            ref,
          );
          generation.transcripts.set(session.sessionId, {
            ref,
            cellOrdinal: session.current_cell.ordinal,
            branchRevision: generation.branchRevision,
            originLeafId: generation.context.sessionManager.getLeafId(),
            calls: new Map(),
          });
        }
      } else if (
        transcript !== undefined &&
        session.last_cell?.ordinal === transcript.cellOrdinal
      ) {
        generation.transcripts.delete(session.sessionId);
        const invalidate = generation.transcriptInvalidators.get(transcript.ref);
        generation.transcriptInvalidators.delete(transcript.ref);
        if (transcript.calls.size === 0 || transcript.branchRevision !== generation.branchRevision)
          continue;
        if (
          transcript.originLeafId !== null &&
          !generation.context.sessionManager
            .getBranch()
            .some((entry) => entry.id === transcript.originLeafId)
        )
          continue;
        this.pi.appendEntry(CODEMODE_NESTED_TOOLS_ENTRY_TYPE, {
          version: 1,
          ref: transcript.ref,
          sessionId: session.sessionId,
          cellOrdinal: transcript.cellOrdinal,
          cwd: generation.context.cwd,
          calls: [...transcript.calls.values()],
        });
        invalidate?.();
      }
    }
  }

  private synchronizeCurrentGeneration(): void {
    const generation = this.generation;
    if (generation !== undefined) this.synchronizeGeneration(generation);
  }

  private synchronizeGeneration(generation: PiCodeModeGeneration): void {
    if (!generation.active || this.generation !== generation) return;
    generation.exposure?.refreshToolExposure();
    const decision = generation.exposure?.getDecision() ?? generation.decision;
    const catalogue = renderGenerationCatalogue(generation.captured, decision);
    generation.decision = decision;
    generation.catalogue = catalogue;
  }

  private async executeNestedToolBatch(
    generation: PiCodeModeGeneration,
    batch: CodeModeNestedToolBatch,
  ): Promise<CodeModeNestedToolBatchResult> {
    if (!generation.active || this.generation !== generation) {
      return {
        results: batch.calls.map((call) =>
          unavailableNestedResult(
            call.callId,
            "cancellation",
            "Pi CodeMode session generation is inactive",
          ),
        ),
      };
    }

    const transcript = generation.transcripts.get(batch.sessionId);
    const completeTranscriptCall = (
      callId: string,
      result: AgentToolResult<unknown>,
      isError: boolean,
    ): void => {
      if (
        !generation.active ||
        this.generation !== generation ||
        transcript === undefined ||
        transcript.cellOrdinal !== batch.cellOrdinal ||
        generation.transcripts.get(batch.sessionId) !== transcript
      )
        return;
      const call = transcript.calls.get(callId);
      if (call === undefined) return;
      let completed = completeCodeModeNestedToolCall(call, result, isError);
      if (completed.resultPreview !== undefined) {
        try {
          const parsed = parseCodeModeJsonValue(codeModeNestedToolResultData(result), {
            maxBytes: 8 * 1024 * 1024,
            normalizeUndefinedForJsonTransport: true,
          });
          if (parsed.ok && parsed.value !== undefined) {
            const spill = generation.sessionFiles.writeResultSpill(
              JSON.stringify(parsed.value, null, 2),
            );
            completed = { ...completed, spillPath: spill.path };
            void spill.completion.catch(() => undefined);
          }
        } catch {
          // Preserve the completed snapshot even when Result Spill capture or writing fails.
        }
      }
      transcript.calls.set(callId, completed);
    };
    if (transcript?.cellOrdinal === batch.cellOrdinal) {
      for (const call of batch.calls) {
        transcript.calls.set(
          call.callId,
          captureCodeModeNestedToolCall(call.callId, call.toolName, call.input),
        );
      }
    }

    const exposedNames = new Set(generation.decision.codeModeNames);
    const registry = generation.captured.getToolRegistry();
    const earlyResults = new Map<string, CodeModeNestedToolResult>();
    const bridgeCalls: PiToolBridgeCall[] = [];
    let searchCallCount = 0;
    for (const call of batch.calls) {
      if (call.toolName === CODEMODE_SEARCH_TOOL_NAME) {
        searchCallCount += 1;
        if (searchCallCount > CODEMODE_SEARCH_BATCH_LIMIT) {
          earlyResults.set(
            call.callId,
            unavailableNestedResult(
              call.callId,
              "validation",
              `Pi CodeMode accepts at most ${CODEMODE_SEARCH_BATCH_LIMIT} searches in one batch`,
            ),
          );
        } else {
          const searched = searchCodeModeToolCatalogue(batch.searchEntries, call.input);
          earlyResults.set(
            call.callId,
            searched.ok
              ? { callId: call.callId, outcome: "success", result: searched.page }
              : unavailableNestedResult(call.callId, searched.code, searched.message),
          );
        }
      } else if (!exposedNames.has(call.toolName) || !registry.has(call.toolName)) {
        earlyResults.set(
          call.callId,
          unavailableNestedResult(
            call.callId,
            "unknown-tool",
            `Pi CodeMode tool is not currently exposed: ${call.toolName}`,
          ),
        );
      } else {
        if (!isCodeModeJsonObject(call.input)) {
          earlyResults.set(
            call.callId,
            unavailableNestedResult(
              call.callId,
              "validation",
              `Pi CodeMode tool input must be an object: ${call.toolName}`,
            ),
          );
        } else {
          bridgeCalls.push({ callId: call.callId, name: call.toolName, input: call.input });
        }
      }
    }

    for (const result of earlyResults.values()) {
      completeTranscriptCall(
        result.callId,
        {
          content: [
            {
              type: "text",
              text:
                result.outcome === "success" ? JSON.stringify(result.result) : result.error.message,
            },
          ],
          details: result.outcome === "success" ? result.result : undefined,
        },
        result.outcome === "error",
      );
    }

    const bridgeCaptured: CapturedPiAgentSession = {
      agent: generation.captured.agent,
      session: generation.captured.session,
      settingsManager: generation.captured.settingsManager,
      getToolRegistry: () => {
        const currentExposedNames = new Set(generation.decision.codeModeNames);
        return new Map(
          [...generation.captured.getToolRegistry()].filter(([name]) =>
            currentExposedNames.has(name),
          ),
        );
      },
    };
    const outerAssistantMessage = latestCodeModeAssistantMessage(generation.captured);
    const terminationController = new AbortController();
    const bridgeOptions: MutableBridgeOptions = {
      calls: bridgeCalls,
      now: CODEMODE_SYSTEM_RUNTIME.now,
      signal: AbortSignal.any([batch.signal, terminationController.signal]),
      onTerminate: () => terminationController.abort(),
      onResult: completeTranscriptCall,
    };
    if (outerAssistantMessage !== undefined) {
      bridgeOptions.outerAssistantMessage = outerAssistantMessage;
    }
    if (batch.onUpdate !== undefined) {
      bridgeOptions.onUpdate = (_callId, update) => {
        const outerUpdate: AgentToolResult<CodeModeResultDetails> = {
          content: update.content,
          details: createCodeModePending(batch.sessionId),
        };
        batch.onUpdate?.(outerUpdate);
      };
    }
    const bridged =
      bridgeCalls.length === 0
        ? undefined
        : await executePiToolBridgeBatch(bridgeCaptured, bridgeOptions);
    for (const outcome of bridged?.calls ?? []) {
      if (
        !outcome.ok &&
        outcome.error.code !== "cancellation" &&
        outcome.error.code !== "termination" &&
        transcript?.calls.get(outcome.callId)?.outcome === "unknown"
      ) {
        completeTranscriptCall(
          outcome.callId,
          {
            content: [{ type: "text", text: outcome.error.message }],
            details: undefined,
          },
          true,
        );
      }
    }
    const bridgedResults = new Map<string, CodeModeNestedToolResult>(
      (bridged?.calls ?? []).map((outcome) => [
        outcome.callId,
        outcome.ok
          ? {
              callId: outcome.callId,
              outcome: "success",
              result: codeModeNestedBridgeValue(outcome.value),
            }
          : {
              callId: outcome.callId,
              outcome: "error",
              error: { code: outcome.error.code, message: outcome.error.message },
            },
      ]),
    );
    const results = batch.calls.map(
      (call) =>
        earlyResults.get(call.callId) ??
        bridgedResults.get(call.callId) ??
        unavailableNestedResult(
          call.callId,
          "runtime",
          "Pi CodeMode nested tool returned no result",
        ),
    );
    const result: MutableNestedToolBatchResult = { results };
    if (bridged !== undefined && bridged.presentation.length > 0) {
      result.presentation = bridged.presentation;
    }
    if (bridged?.usage !== undefined) result.usage = bridged.usage;
    if (bridged !== undefined && bridged.addedToolNames.length > 0) {
      result.addedToolNames = bridged.addedToolNames;
    }
    if (bridged?.terminate === true) result.terminate = true;
    return result;
  }

  private async shutdownSession(): Promise<void> {
    const generation = this.generation;
    if (generation === undefined || !generation.active) return;
    generation.active = false;
    try {
      generation.observer.dispose();
    } catch {
      // Observer cleanup is presentation-only; execution resources still require release.
    }
    try {
      await generation.coordinator.shutdown();
    } finally {
      try {
        await generation.sessionFiles.close();
      } finally {
        generation.exposure?.restore();
        if (this.generation === generation) this.generation = undefined;
      }
    }
  }

  private notifyWarning(context: ExtensionContext, message: string): void {
    context.ui.notify(message, "warning");
  }
}

/** Creates the source-TypeScript CodeMode extension without startup side effects. */
export function createPiCodeModeExtension(): ExtensionFactory {
  return (pi) => new PiCodeModeLifecycleController(pi).register();
}

const piCodeModeExtension = createPiCodeModeExtension();

export default piCodeModeExtension;
