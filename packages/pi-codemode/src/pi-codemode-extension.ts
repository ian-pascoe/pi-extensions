import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { renderCodeModeToolCatalogue } from "./codemode-tool-catalog.js";
import { CodeModeObserverUiController } from "./codemode-observer-ui.js";
import {
  CodeModeSessionCoordinator,
  type CodeModeNestedToolBatch,
  type CodeModeNestedToolBatchResult,
  type CodeModeNestedToolResult,
} from "./codemode-session-coordinator.js";
import { CODEMODE_SYSTEM_RUNTIME } from "./codemode-runtime.js";
import { createCodeModeSessionFiles, type CodeModeSessionFiles } from "./codemode-session-files.js";
import {
  createCodeModeFailure,
  createCodeModePending,
  isCodeModeJsonObject,
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
  type PiToolBridgeCall,
  type PiToolBridgeValue,
} from "./pi-tool-bridge.js";

const CODEMODE_EXECUTE_DESCRIPTION =
  "Execute a TypeScript Cell in a persistent isolated Deno CodeMode Session. Top-level declarations become Notebook Bindings. Use the read-only tools object for registered Pi tools.";

type PiCodeModeGeneration = {
  readonly captured: CapturedPiAgentSession;
  readonly context: ExtensionContext;
  readonly coordinator: CodeModeSessionCoordinator;
  readonly observer: CodeModeObserverUiController;
  readonly sessionFiles: CodeModeSessionFiles;
  readonly operations: CodeModeToolOperations;
  exposure?: InstalledCodeModeToolExposure;
  decision: CodeModeToolExposureDecision;
  executeDescription: string;
  active: boolean;
  toolsRegistered: boolean;
  synchronizing: boolean;
  synchronizationPending: boolean;
  catalogueWarningShown: boolean;
};

function catalogueDescription(catalogue: string): string {
  return `${CODEMODE_EXECUTE_DESCRIPTION}\n\nCurrent CodeMode tool declarations:\n\n\`\`\`ts\n${catalogue}\`\`\``;
}

function renderGenerationCatalogue(
  captured: CapturedPiAgentSession,
  decision: CodeModeToolExposureDecision,
) {
  const registry = captured.getToolRegistry();
  return renderCodeModeToolCatalogue(
    decision.codeModeNames.flatMap((name) => {
      const tool = registry.get(name);
      return tool === undefined
        ? []
        : [{ name, description: tool.description, inputSchema: tool.parameters }];
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

  /** Creates inert lifecycle wiring around one Pi extension registration interface. */
  constructor(private readonly pi: ExtensionAPI) {}

  /** Registers inert lifecycle handlers; no process or public tool exists before session start. */
  register(): void {
    this.pi.on("session_start", async (_event, context) => this.startSession(context));
    this.pi.on("before_agent_start", () => this.synchronizeCurrentGeneration());
    this.pi.on("tool_execution_end", () => this.synchronizeCurrentGeneration());
    this.pi.on("session_shutdown", async (event) => this.shutdownSession(event.reason));
  }

  private async startSession(context: ExtensionContext): Promise<void> {
    await this.shutdownSession("replacement");
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
    if (!initialCatalogue.ok) {
      this.notifyWarning(
        context,
        "Pi CodeMode disabled: registered tool names exceed the 1 MiB catalogue limit",
      );
      return;
    }

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
      onSnapshotChange: (snapshot) => observer.onSnapshotChange(snapshot),
      onUnexpectedFailure: (failure) => observer.onUnexpectedFailure(failure),
      getToolNames: () =>
        generation.active && this.generation === generation
          ? generation.decision.codeModeNames
          : [],
      executeToolBatch: (batch) => this.executeNestedToolBatch(generation, batch),
    });
    const operations: CodeModeToolOperations = {
      execute: async (input, signal, onUpdate) => {
        if (!generation.active || this.generation !== generation) {
          return {
            result: createCodeModeFailure(
              input.sessionId ?? "inactive",
              "runtime",
              "Pi CodeMode session generation is inactive",
            ),
          };
        }
        return coordinator.execute(
          input,
          signal,
          onUpdate === undefined
            ? undefined
            : (update) => {
                // SAFETY: executeNestedToolBatch is the only update producer and replaces nested details with a schema-valid CodeMode pending result.
                onUpdate(update as AgentToolResult<CodeModeResultDetails>);
              },
        );
      },
      result: async (input) => coordinator.result(input.sessionId),
      cancel: async (input) => coordinator.cancel(input.sessionId),
    };
    generation = {
      captured,
      context,
      coordinator,
      observer,
      sessionFiles,
      operations,
      decision: initialDecision,
      executeDescription: catalogueDescription(initialCatalogue.text),
      active: true,
      toolsRegistered: false,
      synchronizing: false,
      synchronizationPending: false,
      catalogueWarningShown: false,
    };
    this.generation = generation;

    try {
      generation.exposure = installCodeModeToolExposure(
        captured.session,
        () => captured.getToolRegistry().keys(),
        settings.rules,
        (decision) => {
          generation.decision = decision;
          this.synchronizeGeneration(generation);
        },
        (decision) => this.acceptExposureDecision(generation, decision),
      );
    } catch (cause) {
      generation.active = false;
      try {
        observer.dispose();
      } catch {
        // Observer cleanup is presentation-only; execution resources still require release.
      }
      await coordinator.shutdown("startup failure");
      await sessionFiles.close();
      if (this.generation === generation) this.generation = undefined;
      this.notifyWarning(
        context,
        `Pi CodeMode disabled: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }

    for (const definition of createRenderedCodeModeToolDefinitions(
      operations,
      generation.executeDescription,
      (sessionId) => coordinator.formatSessionPrefix(sessionId),
    )) {
      this.pi.registerTool(definition);
    }
    generation.toolsRegistered = true;
    this.synchronizeGeneration(generation);
  }

  private acceptExposureDecision(
    generation: PiCodeModeGeneration,
    decision: CodeModeToolExposureDecision,
  ): boolean {
    if (!generation.active || this.generation !== generation) return false;
    const catalogue = renderGenerationCatalogue(generation.captured, decision);
    if (catalogue.ok) return true;
    if (!generation.catalogueWarningShown) {
      generation.catalogueWarningShown = true;
      this.notifyWarning(
        generation.context,
        "Pi CodeMode retained its previous exposure because registered tool names exceed the 1 MiB catalogue limit",
      );
    }
    return false;
  }

  private synchronizeCurrentGeneration(): void {
    const generation = this.generation;
    if (generation !== undefined) this.synchronizeGeneration(generation);
  }

  private synchronizeGeneration(generation: PiCodeModeGeneration): void {
    if (!generation.active || this.generation !== generation) return;
    if (generation.synchronizing) {
      generation.synchronizationPending = true;
      return;
    }
    generation.synchronizing = true;
    try {
      do {
        generation.synchronizationPending = false;
        const decision = generation.exposure?.getDecision() ?? generation.decision;
        const catalogue = renderGenerationCatalogue(generation.captured, decision);
        if (!catalogue.ok) continue;
        generation.decision = decision;
        const description = catalogueDescription(catalogue.text);
        if (description === generation.executeDescription) continue;
        generation.executeDescription = description;
        if (!generation.toolsRegistered) continue;
        const executeDefinition = createRenderedCodeModeToolDefinitions(
          generation.operations,
          description,
          (sessionId) => generation.coordinator.formatSessionPrefix(sessionId),
        )[0];
        if (executeDefinition !== undefined) this.pi.registerTool(executeDefinition);
      } while (generation.synchronizationPending);
    } finally {
      generation.synchronizing = false;
    }
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

    const exposedNames = new Set(generation.decision.codeModeNames);
    const registry = generation.captured.getToolRegistry();
    const earlyResults = new Map<string, CodeModeNestedToolResult>();
    const bridgeCalls: PiToolBridgeCall[] = [];
    for (const call of batch.calls) {
      if (!exposedNames.has(call.toolName) || !registry.has(call.toolName)) {
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
    const bridgeOptions = {
      calls: bridgeCalls,
      now: CODEMODE_SYSTEM_RUNTIME.now,
      signal: AbortSignal.any([batch.signal, terminationController.signal]),
      onTerminate: () => terminationController.abort(),
    };
    if (outerAssistantMessage !== undefined) {
      Object.assign(bridgeOptions, { outerAssistantMessage });
    }
    if (batch.onUpdate !== undefined) {
      Object.assign(bridgeOptions, {
        onUpdate: (_callId: string, update: AgentToolResult<unknown>) => {
          const outerUpdate: AgentToolResult<CodeModeResultDetails> = {
            content: update.content,
            details: createCodeModePending(batch.sessionId),
          };
          batch.onUpdate?.(outerUpdate);
        },
      });
    }
    const bridged = await executePiToolBridgeBatch(bridgeCaptured, bridgeOptions);
    const bridgedResults = new Map<string, CodeModeNestedToolResult>(
      bridged.calls.map((outcome) => [
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
    const batchResult = { results, presentation: bridged.presentation };
    if (bridged.usage !== undefined) Object.assign(batchResult, { usage: bridged.usage });
    if (bridged.addedToolNames.length > 0) {
      Object.assign(batchResult, { addedToolNames: bridged.addedToolNames });
    }
    if (bridged.terminate) Object.assign(batchResult, { terminate: true });
    return batchResult;
  }

  private async shutdownSession(reason: string): Promise<void> {
    const generation = this.generation;
    if (generation === undefined || !generation.active) return;
    generation.active = false;
    try {
      generation.observer.dispose();
    } catch {
      // Observer cleanup is presentation-only; execution resources still require release.
    }
    try {
      await generation.coordinator.shutdown(reason);
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
