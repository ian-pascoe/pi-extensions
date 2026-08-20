import type {
  AgentContext,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { validateToolArguments, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { parseCodeModeJsonValue, type CodeModeJsonValue } from "./codemode-tool-contract.js";
import type { CapturedPiAgentSession } from "./pi-agent-session-capture.js";

const PI_TOOL_BRIDGE_RESULT_LIMIT_BYTES = 8 * 1024 * 1024;

/** Stable nested Pi tool failure categories exposed to the CodeMode guest bridge. */
export type CodeModeToolErrorCode =
  | "blocked"
  | "cancellation"
  | "execution"
  | "serialization"
  | "termination"
  | "unknown-tool"
  | "validation";

/** Catchable nested Pi tool failure, except when terminate is true and the session owner tears down the guest. */
export class CodeModeToolError extends Error {
  /** Stable guest-facing failure category. */
  readonly code: CodeModeToolErrorCode;
  /** Whether this failure must terminate the complete CodeMode Session. */
  readonly terminate: boolean;

  /** Creates one nested Pi tool failure without exposing the original host error object. */
  constructor(
    code: CodeModeToolErrorCode,
    message: string,
    options: { readonly terminate?: boolean } = {},
  ) {
    super(message);
    this.name = "CodeModeToolError";
    this.code = code;
    this.terminate = options.terminate ?? false;
  }
}

/** One guest-originated exact Pi tool call in a fixed-point bridge batch. */
export interface PiToolBridgeCall {
  readonly callId: string;
  readonly input: Record<string, CodeModeJsonValue>;
  readonly name: string;
}

/** JSON-safe text or image content returned to a Deno Cell. */
export type PiToolBridgeContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

/** JSON-safe nested Pi tool value resolved inside the Deno Cell. */
export interface PiToolBridgeValue {
  readonly content: readonly PiToolBridgeContent[];
  readonly details?: CodeModeJsonValue;
}

/** One successfully translated nested Pi tool call. */
export interface PiToolBridgeCallSuccess {
  readonly callId: string;
  readonly ok: true;
  readonly value: PiToolBridgeValue;
}

/** One catchable or terminating nested Pi tool call failure. */
export interface PiToolBridgeCallFailure {
  readonly callId: string;
  readonly error: CodeModeToolError;
  readonly ok: false;
}

/** Ordered outcome for one supplied nested Pi tool call. */
export type PiToolBridgeCallOutcome = PiToolBridgeCallSuccess | PiToolBridgeCallFailure;

/** Parent-only bounded presentation facts for one nested Pi tool call. */
export interface PiToolBridgeCallPresentation {
  readonly callId: string;
  /** Parent wall-clock elapsed time from preparation through final hooks, in milliseconds. */
  readonly elapsedMs: number;
  /** Exact registered Pi tool name; arguments and output are deliberately absent. */
  readonly name: string;
  readonly outcome: "success" | "failed" | "cancelled";
}

/** Complete nested batch output plus metadata forwarded by the outer CodeMode tool. */
export interface PiToolBridgeBatchResult {
  readonly addedToolNames: readonly string[];
  readonly calls: readonly PiToolBridgeCallOutcome[];
  readonly presentation: readonly PiToolBridgeCallPresentation[];
  readonly terminate: boolean;
  readonly usage?: Usage;
}

/** Inputs that keep one synthetic hook message and one Cell signal across a nested batch. */
export interface ExecutePiToolBridgeBatchOptions {
  readonly calls: readonly PiToolBridgeCall[];
  /** Injected parent wall clock used only for clamped presentation durations. */
  readonly now: () => number;
  readonly onTerminate: () => void;
  readonly onUpdate?: (callId: string, result: AgentToolResult<unknown>) => void;
  readonly outerAssistantMessage?: AssistantMessage;
  readonly signal: AbortSignal;
}

type PreparedPiToolCall = {
  readonly args: unknown;
  readonly kind: "prepared";
  readonly tool: AgentTool;
  readonly toolCall: AgentToolCall;
};

type FinalizedPiToolCall = {
  readonly addedToolNames: readonly string[];
  readonly outcome: PiToolBridgeCallOutcome;
  readonly terminate: boolean;
  readonly usage?: Usage;
};

type PreparedOrFinalizedPiToolCall =
  | PreparedPiToolCall
  | { readonly kind: "finalized"; readonly value: FinalizedPiToolCall };

type FinalizedPiToolMetadata = {
  readonly addedToolNames: readonly string[];
  readonly usage?: Usage;
};

type TimedFinalizedPiToolCall = {
  readonly finalized: FinalizedPiToolCall;
  readonly presentation: PiToolBridgeCallPresentation;
};

function normalizeThrownMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function createBridgeFailure(
  callId: string,
  code: CodeModeToolErrorCode,
  message: string,
  options: { readonly terminate?: boolean } = {},
): FinalizedPiToolCall {
  const terminate = options.terminate ?? false;
  return {
    addedToolNames: [],
    outcome: {
      callId,
      error: new CodeModeToolError(code, message, options),
      ok: false,
    },
    terminate,
  };
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

function bridgeToolCall(call: PiToolBridgeCall): AgentToolCall {
  return {
    type: "toolCall",
    id: call.callId,
    name: call.name,
    arguments: call.input,
  };
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createSyntheticAssistantMessage(
  captured: CapturedPiAgentSession,
  calls: readonly PiToolBridgeCall[],
  outerAssistantMessage: AssistantMessage | undefined,
): AssistantMessage {
  const model = captured.agent.state.model;
  return {
    role: "assistant",
    content: calls.map(bridgeToolCall),
    api: outerAssistantMessage?.api ?? model.api,
    provider: outerAssistantMessage?.provider ?? model.provider,
    model: outerAssistantMessage?.model ?? model.id,
    usage: outerAssistantMessage?.usage ?? zeroUsage(),
    stopReason: "toolUse",
    timestamp: outerAssistantMessage?.timestamp ?? 0,
  };
}

function currentAgentContext(captured: CapturedPiAgentSession): AgentContext {
  const state = captured.agent.state;
  return {
    systemPrompt: state.systemPrompt,
    messages: state.messages,
    tools: state.tools,
  };
}

function preparePiToolCall(
  captured: CapturedPiAgentSession,
  call: PiToolBridgeCall,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  signal: AbortSignal,
): Promise<PreparedOrFinalizedPiToolCall> {
  const toolCall = bridgeToolCall(call);
  const tool = captured.getToolRegistry().get(call.name);
  if (tool === undefined) {
    return Promise.resolve({
      kind: "finalized",
      value: createBridgeFailure(
        call.callId,
        "unknown-tool",
        `Pi CodeMode tool not found: ${call.name}`,
      ),
    });
  }

  return (async () => {
    try {
      const preparedArguments =
        tool.prepareArguments === undefined ? call.input : tool.prepareArguments(call.input);
      // SAFETY: Pi defines prepareArguments as producing the tool-call argument representation; its exact schema validator remains authoritative below.
      const preparedToolArguments = preparedArguments as AgentToolCall["arguments"];
      const preparedToolCall =
        preparedArguments === call.input
          ? toolCall
          : { ...toolCall, arguments: preparedToolArguments };
      const validatedArgs: unknown = validateToolArguments(tool, preparedToolCall);
      const beforeResult = await captured.agent.beforeToolCall?.(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context,
        },
        signal,
      );
      if (signal.aborted) {
        return {
          kind: "finalized",
          value: createBridgeFailure(call.callId, "cancellation", "Operation aborted"),
        };
      }
      if (beforeResult?.block === true) {
        return {
          kind: "finalized",
          value: createBridgeFailure(
            call.callId,
            beforeResult.terminate === true ? "termination" : "blocked",
            beforeResult.reason ?? "Tool execution was blocked",
            { terminate: beforeResult.terminate === true },
          ),
        };
      }
      return {
        kind: "prepared",
        toolCall,
        tool,
        args: validatedArgs,
      };
    } catch (cause) {
      return {
        kind: "finalized",
        value: createBridgeFailure(call.callId, "validation", normalizeThrownMessage(cause)),
      };
    }
  })();
}

async function executePreparedPiToolCall(
  prepared: PreparedPiToolCall,
  signal: AbortSignal,
  onUpdate: ((callId: string, result: AgentToolResult<unknown>) => void) | undefined,
): Promise<{ readonly isError: boolean; readonly result: AgentToolResult<unknown> }> {
  let acceptingUpdates = true;
  try {
    // SAFETY: Pi's own validator above parsed this value against this exact wrapper's parameter schema.
    const validatedArgs = prepared.args as never;
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      validatedArgs,
      signal,
      (partialResult) => {
        if (!acceptingUpdates) return;
        onUpdate?.(prepared.toolCall.id, partialResult);
      },
    );
    acceptingUpdates = false;
    return { result, isError: false };
  } catch (cause) {
    acceptingUpdates = false;
    return {
      result: createErrorToolResult(normalizeThrownMessage(cause)),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
}

async function finalizeExecutedPiToolCall(
  captured: CapturedPiAgentSession,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  prepared: PreparedPiToolCall,
  executed: {
    readonly isError: boolean;
    readonly result: AgentToolResult<unknown>;
  },
  signal: AbortSignal,
): Promise<FinalizedPiToolCall> {
  let result = executed.result;
  let isError = executed.isError;

  try {
    const afterResult = await captured.agent.afterToolCall?.(
      {
        assistantMessage,
        toolCall: prepared.toolCall,
        args: prepared.args,
        result,
        isError,
        context,
      },
      signal,
    );
    if (afterResult !== undefined) {
      const mergedResult: AgentToolResult<unknown> = {
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
      };
      const usage = afterResult.usage ?? result.usage;
      if (usage !== undefined) mergedResult.usage = usage;
      if (result.addedToolNames !== undefined) {
        mergedResult.addedToolNames = result.addedToolNames;
      }
      const terminate = afterResult.terminate ?? result.terminate;
      if (terminate !== undefined) mergedResult.terminate = terminate;
      result = mergedResult;
      isError = afterResult.isError ?? isError;
    }
  } catch (cause) {
    result = createErrorToolResult(normalizeThrownMessage(cause));
    isError = true;
  }

  const terminate = result.terminate === true;
  const metadata: FinalizedPiToolMetadata =
    result.usage === undefined
      ? { addedToolNames: result.addedToolNames ?? [] }
      : {
          addedToolNames: result.addedToolNames ?? [],
          usage: result.usage,
        };
  if (terminate) {
    return {
      ...metadata,
      outcome: {
        callId: prepared.toolCall.id,
        error: new CodeModeToolError(
          "termination",
          resultErrorMessage(result, prepared.toolCall.name),
          { terminate: true },
        ),
        ok: false,
      },
      terminate: true,
    };
  }
  if (isError) {
    return {
      ...metadata,
      outcome: {
        callId: prepared.toolCall.id,
        error: new CodeModeToolError(
          "execution",
          resultErrorMessage(result, prepared.toolCall.name),
        ),
        ok: false,
      },
      terminate: false,
    };
  }

  const translated = translatePiToolResult(result);
  if (!translated.ok) {
    return {
      ...metadata,
      outcome: {
        callId: prepared.toolCall.id,
        error: new CodeModeToolError("serialization", translated.message),
        ok: false,
      },
      terminate: false,
    };
  }
  return {
    ...metadata,
    outcome: {
      callId: prepared.toolCall.id,
      ok: true,
      value: translated.value,
    },
    terminate: false,
  };
}

function resultErrorMessage(result: AgentToolResult<unknown>, toolName: string): string {
  for (const content of result.content ?? []) {
    if (content.type === "text" && content.text.length > 0) return content.text;
  }
  return `Pi CodeMode tool failed: ${toolName}`;
}

function isJsonObject(
  value: CodeModeJsonValue,
): value is { readonly [key: string]: CodeModeJsonValue } {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This predicate parses the recursive JSON union into its object domain arm.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBridgeContent(value: CodeModeJsonValue): PiToolBridgeContent | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The JSON-safe object is parsed into the supported text/image content contract here.
  if (!isJsonObject(value) || typeof value.type !== "string") return undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The JSON-safe object is parsed into the supported text content contract here.
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (
    value.type === "image" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The JSON-safe object is parsed into the supported image content contract here.
    typeof value.data === "string" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The JSON-safe object is parsed into the supported image content contract here.
    typeof value.mimeType === "string"
  ) {
    return { type: "image", data: value.data, mimeType: value.mimeType };
  }
  return undefined;
}

function translatePiToolResult(
  result: AgentToolResult<unknown>,
):
  | { readonly ok: true; readonly value: PiToolBridgeValue }
  | { readonly ok: false; readonly message: string } {
  const wireCandidate =
    result.details === undefined
      ? { content: result.content ?? [] }
      : { content: result.content ?? [], details: result.details };
  const parsed = parseCodeModeJsonValue(wireCandidate, {
    maxBytes: PI_TOOL_BRIDGE_RESULT_LIMIT_BYTES,
    normalizeUndefinedForJsonTransport: true,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      message: `Pi CodeMode tool result is not JSON-safe: ${parsed.message}`,
    };
  }
  if (parsed.value === undefined || !isJsonObject(parsed.value)) {
    return { ok: false, message: "Pi CodeMode tool result is not a JSON object" };
  }
  const contentValue = parsed.value.content;
  if (!Array.isArray(contentValue)) {
    return { ok: false, message: "Pi CodeMode tool result content is not an array" };
  }
  const content: PiToolBridgeContent[] = [];
  for (const entry of contentValue) {
    const parsedContent = parseBridgeContent(entry);
    if (parsedContent === undefined) {
      return {
        ok: false,
        message: "Pi CodeMode tool result contains unsupported content",
      };
    }
    content.push(parsedContent);
  }
  const details = parsed.value.details;
  return {
    ok: true,
    value: details === undefined ? { content } : { content, details },
  };
}

function addUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (right === undefined) return left;
  if (left === undefined) return right;
  const reasoning =
    left.reasoning === undefined && right.reasoning === undefined
      ? undefined
      : (left.reasoning ?? 0) + (right.reasoning ?? 0);
  const cacheWrite1h =
    left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
      ? undefined
      : (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0);
  const combined: Usage = {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
  if (cacheWrite1h !== undefined) combined.cacheWrite1h = cacheWrite1h;
  if (reasoning !== undefined) combined.reasoning = reasoning;
  return combined;
}

function terminatedPiToolCall(callId: string): FinalizedPiToolCall {
  return createBridgeFailure(
    callId,
    "termination",
    "CodeMode Session terminated by a sibling Pi tool call",
    { terminate: true },
  );
}

function presentationOutcome(
  outcome: PiToolBridgeCallOutcome,
): PiToolBridgeCallPresentation["outcome"] {
  if (outcome.ok) return "success";
  return outcome.error.code === "cancellation" || outcome.error.code === "termination"
    ? "cancelled"
    : "failed";
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  const elapsed = Math.round(finishedAt - startedAt);
  if (!Number.isFinite(elapsed)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed));
}

function timedFinalizedPiToolCall(
  call: PiToolBridgeCall,
  finalized: FinalizedPiToolCall,
  startedAt: number,
  now: () => number,
): TimedFinalizedPiToolCall {
  return {
    finalized,
    presentation: {
      callId: call.callId,
      elapsedMs: elapsedMilliseconds(startedAt, now()),
      name: call.name,
      outcome: presentationOutcome(finalized.outcome),
    },
  };
}

function cancelledPiToolCallPresentation(call: PiToolBridgeCall): TimedFinalizedPiToolCall {
  return {
    finalized: terminatedPiToolCall(call.callId),
    presentation: { callId: call.callId, elapsedMs: 0, name: call.name, outcome: "cancelled" },
  };
}

function collectPiToolBridgeBatch(
  timedCalls: readonly TimedFinalizedPiToolCall[],
): PiToolBridgeBatchResult {
  let usage: Usage | undefined;
  const addedToolNames: string[] = [];
  const seenToolNames = new Set<string>();
  for (const { finalized } of timedCalls) {
    usage = addUsage(usage, finalized.usage);
    for (const toolName of finalized.addedToolNames) {
      if (seenToolNames.has(toolName)) continue;
      seenToolNames.add(toolName);
      addedToolNames.push(toolName);
    }
  }
  const batch = {
    addedToolNames,
    calls: timedCalls.map(({ finalized }) => finalized.outcome),
    presentation: timedCalls.map(({ presentation }) => presentation),
    terminate: timedCalls.some(({ finalized }) => finalized.terminate),
  };
  return usage === undefined ? batch : { ...batch, usage };
}

/** Executes one nested Pi tool batch with Pi 0.84.2 preparation, hook, wrapper, and merge order. */
export async function executePiToolBridgeBatch(
  captured: CapturedPiAgentSession,
  options: ExecutePiToolBridgeBatchOptions,
): Promise<PiToolBridgeBatchResult> {
  const assistantMessage = createSyntheticAssistantMessage(
    captured,
    options.calls,
    options.outerAssistantMessage,
  );
  const context = currentAgentContext(captured);
  const terminationCompletion = Promise.withResolvers<void>();
  let acceptingBatchUpdates = true;
  let terminationNotified = false;
  const notifyTermination = (): void => {
    if (terminationNotified) return;
    terminationNotified = true;
    acceptingBatchUpdates = false;
    terminationCompletion.resolve();
    options.onTerminate();
  };
  const forwardUpdate =
    options.onUpdate === undefined
      ? undefined
      : (callId: string, result: AgentToolResult<unknown>): void => {
          if (acceptingBatchUpdates) options.onUpdate?.(callId, result);
        };
  const finalizePrepared = async (prepared: PreparedPiToolCall): Promise<FinalizedPiToolCall> => {
    if (terminationNotified) return terminatedPiToolCall(prepared.toolCall.id);
    const executed = await executePreparedPiToolCall(prepared, options.signal, forwardUpdate);
    if (terminationNotified) return terminatedPiToolCall(prepared.toolCall.id);
    const finalized = await finalizeExecutedPiToolCall(
      captured,
      assistantMessage,
      context,
      prepared,
      executed,
      options.signal,
    );
    return terminationNotified ? terminatedPiToolCall(prepared.toolCall.id) : finalized;
  };

  const hasSequentialCall = options.calls.some(
    (call) => captured.getToolRegistry().get(call.name)?.executionMode === "sequential",
  );
  if (hasSequentialCall) {
    const finalizedCalls: TimedFinalizedPiToolCall[] = [];
    for (const [index, call] of options.calls.entries()) {
      if (terminationNotified) {
        finalizedCalls.push(cancelledPiToolCallPresentation(call));
        continue;
      }
      const startedAt = options.now();
      const preparation = await preparePiToolCall(
        captured,
        call,
        assistantMessage,
        context,
        options.signal,
      );
      const finalized =
        preparation.kind === "finalized" ? preparation.value : await finalizePrepared(preparation);
      finalizedCalls.push(timedFinalizedPiToolCall(call, finalized, startedAt, options.now));
      if (finalized.terminate) {
        notifyTermination();
        for (const sibling of options.calls.slice(index + 1)) {
          finalizedCalls.push(cancelledPiToolCallPresentation(sibling));
        }
        break;
      }
    }
    acceptingBatchUpdates = false;
    return collectPiToolBridgeBatch(finalizedCalls);
  }

  const preparations = await Promise.all(
    options.calls.map(async (call) => {
      const startedAt = options.now();
      const preparation = await preparePiToolCall(
        captured,
        call,
        assistantMessage,
        context,
        options.signal,
      );
      return { call, preparation, startedAt };
    }),
  );
  const terminatingPreparation = preparations.find(
    ({ preparation }) => preparation.kind === "finalized" && preparation.value.terminate,
  );
  if (terminatingPreparation !== undefined) {
    notifyTermination();
    return collectPiToolBridgeBatch(
      preparations.map(({ call, preparation, startedAt }) =>
        preparation.kind === "finalized" && preparation.value.terminate
          ? timedFinalizedPiToolCall(call, preparation.value, startedAt, options.now)
          : cancelledPiToolCallPresentation(call),
      ),
    );
  }

  const finalizedSlots: Array<TimedFinalizedPiToolCall | undefined> = Array.from({
    length: preparations.length,
  });
  const trackedFinalizations = preparations.map(({ call, preparation, startedAt }, index) => {
    const callId =
      preparation.kind === "prepared" ? preparation.toolCall.id : preparation.value.outcome.callId;
    const finalization =
      preparation.kind === "finalized"
        ? Promise.resolve(preparation.value)
        : finalizePrepared(preparation);
    return finalization
      .catch((cause) => createBridgeFailure(callId, "execution", normalizeThrownMessage(cause)))
      .then((finalized) => {
        const timed = timedFinalizedPiToolCall(call, finalized, startedAt, options.now);
        finalizedSlots[index] = timed;
        if (finalized.terminate) notifyTermination();
        return timed;
      });
  });
  const settled = await Promise.race([
    Promise.all(trackedFinalizations).then(
      (finalizedCalls) => ({ kind: "complete", finalizedCalls }) as const,
    ),
    terminationCompletion.promise.then(() => ({ kind: "termination" }) as const),
  ]);
  acceptingBatchUpdates = false;
  return settled.kind === "complete"
    ? collectPiToolBridgeBatch(settled.finalizedCalls)
    : collectPiToolBridgeBatch(
        options.calls.map(
          (call, index) => finalizedSlots[index] ?? cancelledPiToolCallPresentation(call),
        ),
      );
}
