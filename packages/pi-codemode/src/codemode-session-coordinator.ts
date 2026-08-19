import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { transformCodeModeCell } from "./codemode-cell-transform.js";
import { CodeModeWorkerProcess } from "./codemode-deno-process.js";
import type { CodeModeRuntime, CodeModeTimerHandle } from "./codemode-runtime.js";
import {
  createCodeModeFailure,
  createCodeModePending,
  createCodeModeSuccess,
  parseCodeModeJsonValue,
  type CodeModeErrorCode,
  type CodeModeExecuteParameters,
  type CodeModeJsonValue,
  type CodeModeResult,
  type CodeModeToolOperationMetadata,
} from "./codemode-tool-contract.js";
import {
  CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
  type CodeModeWorkerRequest,
  type CodeModeWorkerResponse,
  type CodeModeWorkerToolSettlement,
} from "./codemode-worker-protocol.js";

const CODEMODE_MAX_TERMINAL_RECORDS = 64;
const CODEMODE_WATCHDOG_GRACE_MS = 100;
const INVALID_CODEMODE_SESSION_ID = "invalid-session-id";

/** Branded identifier for one retained CodeMode Session. */
export type CodeModeSessionId = string & { readonly CodeModeSessionId: unique symbol };

/** One guest-originated nested Pi tool call in a Deno microtask batch. */
export type CodeModeNestedToolCall = {
  readonly callId: string;
  readonly toolName: string;
  readonly input: CodeModeJsonValue;
};

/** One catchable nested Pi tool outcome returned to the guest. */
export type CodeModeNestedToolResult =
  | { readonly callId: string; readonly outcome: "success"; readonly result: CodeModeJsonValue }
  | {
      readonly callId: string;
      readonly outcome: "error";
      readonly error: { readonly code: string; readonly message: string };
    };

/** Recording/update callback supplied to a nested Pi tool batch executor. */
export type CodeModeNestedToolUpdate = AgentToolResult<unknown>;

/** One complete guest batch plus its Cell-scoped cancellation and update capabilities. */
export type CodeModeNestedToolBatch = {
  readonly sessionId: CodeModeSessionId;
  readonly batchId: string;
  readonly calls: readonly CodeModeNestedToolCall[];
  readonly signal: AbortSignal;
  readonly onUpdate?: (update: CodeModeNestedToolUpdate) => void;
};

/** Nested Pi results and metadata accumulated onto the next outer terminal result. */
export type CodeModeNestedToolBatchResult = {
  readonly results: readonly CodeModeNestedToolResult[];
  readonly usage?: Usage;
  readonly addedToolNames?: readonly string[];
  readonly terminate?: boolean;
};

/** Callback seam that adapts one guest job-drain batch to Pi's wrapped tool bridge. */
export type ExecuteCodeModeNestedToolBatch = (
  batch: CodeModeNestedToolBatch,
) => Promise<CodeModeNestedToolBatchResult>;

/** Metadata attached to the next outer CodeMode tool result, never its public details. */
export type CodeModeOuterToolMetadata = CodeModeToolOperationMetadata;

/** One coordinator operation result plus one-shot outer Pi metadata when available. */
export type CodeModeSessionOperationResult = {
  readonly result: CodeModeResult;
  readonly metadata?: CodeModeOuterToolMetadata;
};

/** Construction capabilities and limits for one CodeMode Session coordinator. */
export type CodeModeSessionCoordinatorOptions = {
  readonly maxSessions: number;
  readonly getToolNames: () => readonly string[];
  readonly executeToolBatch: ExecuteCodeModeNestedToolBatch;
  /** Explicit parent clock and Session-ID capabilities. */
  readonly runtime: CodeModeRuntime;
};

type CodeModeMetadataAccumulator = {
  usage?: Usage;
  readonly addedToolNames: Set<string>;
  terminate: boolean;
};

type MutableCodeModeOuterToolMetadata = {
  usage?: Usage;
  addedToolNames?: readonly string[];
  terminate?: boolean;
};

type ActiveCodeModeCell = {
  readonly cellId: string;
  readonly abortController: AbortController;
  readonly completion: Promise<CodeModeResult>;
  readonly resolveCompletion: (result: CodeModeResult) => void;
  readonly metadata: CodeModeMetadataAccumulator;
  acceptsUpdates: boolean;
  settled: boolean;
  watchdog?: CodeModeTimerHandle;
};

type LiveCodeModeSession = {
  readonly state: "live";
  readonly sessionId: CodeModeSessionId;
  readonly worker: CodeModeWorkerProcess;
  lastAccess: number;
  latestResult?: CodeModeResult;
  currentCell?: ActiveCodeModeCell;
  availableMetadata?: CodeModeOuterToolMetadata;
};

type TerminalCodeModeSession = {
  readonly state: "terminal";
  readonly sessionId: CodeModeSessionId;
  lastAccess: number;
  readonly latestResult: CodeModeResult;
  availableMetadata?: CodeModeOuterToolMetadata;
};

type CodeModeSessionRecord = LiveCodeModeSession | TerminalCodeModeSession;

type LocateCodeModeSessionResult = {
  readonly record?: CodeModeSessionRecord;
  readonly failure: CodeModeResult;
};

type FatalCodeModeSessionFailure = {
  readonly code: Extract<CodeModeErrorCode, "timeout" | "cancellation" | "termination" | "runtime">;
  readonly message: string;
};

type ParseCodeModeSessionIdResult =
  | { readonly ok: true; readonly value: CodeModeSessionId }
  | { readonly ok: false };

function parseCodeModeSessionId(value: string): ParseCodeModeSessionIdResult {
  if (value.length === 0) return { ok: false };
  // SAFETY: This parser establishes the only CodeMode Session ID invariant (non-empty) before applying the domain brand.
  return { ok: true, value: value as CodeModeSessionId };
}

function invalidCodeModeSessionResult(): CodeModeSessionOperationResult {
  return {
    result: createCodeModeFailure(
      INVALID_CODEMODE_SESSION_ID,
      "unknown",
      "Invalid CodeMode Session ID",
    ),
  };
}

function emptyMetadataAccumulator(): CodeModeMetadataAccumulator {
  return { addedToolNames: new Set(), terminate: false };
}

function combineCodeModeUsage(left: Usage | undefined, right: Usage): Usage {
  if (left === undefined) {
    return {
      ...right,
      cost: { ...right.cost },
    };
  }
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
  if (left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined) {
    combined.cacheWrite1h = (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0);
  }
  if (left.reasoning !== undefined || right.reasoning !== undefined) {
    combined.reasoning = (left.reasoning ?? 0) + (right.reasoning ?? 0);
  }
  return combined;
}

function mergeCodeModeOuterMetadata(
  accumulator: CodeModeMetadataAccumulator,
  metadata: CodeModeOuterToolMetadata,
): void {
  if (metadata.usage !== undefined) {
    accumulator.usage = combineCodeModeUsage(accumulator.usage, metadata.usage);
  }
  for (const name of metadata.addedToolNames ?? []) accumulator.addedToolNames.add(name);
  if (metadata.terminate === true) accumulator.terminate = true;
}

function finalizeCodeModeMetadata(
  accumulator: CodeModeMetadataAccumulator,
): CodeModeOuterToolMetadata | undefined {
  const addedToolNames = [...accumulator.addedToolNames];
  if (accumulator.usage === undefined && addedToolNames.length === 0 && !accumulator.terminate)
    return undefined;
  const metadata: MutableCodeModeOuterToolMetadata = {};
  if (accumulator.usage !== undefined) metadata.usage = accumulator.usage;
  if (addedToolNames.length > 0) metadata.addedToolNames = addedToolNames;
  if (accumulator.terminate) metadata.terminate = true;
  return metadata;
}

/** Owns bounded CodeMode Session records and one isolated Deno process per live Session. */
export class CodeModeSessionCoordinator {
  private readonly records = new Map<CodeModeSessionId, CodeModeSessionRecord>();
  private readonly runtime: CodeModeRuntime;
  private accessSequence = 0;
  private cellSequence = 0;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly activeUpdateCallbacks = new WeakMap<
    ActiveCodeModeCell,
    (update: CodeModeNestedToolUpdate) => void
  >();
  private readonly pendingProcessStops = new Set<Promise<void>>();

  /** Creates one coordinator from its Pi bridge, limits, and parent runtime capabilities. */
  constructor(private readonly options: CodeModeSessionCoordinatorOptions) {
    this.runtime = options.runtime;
  }

  /** Starts one Cell, optionally returning before its retained result settles. */
  async execute(
    input: CodeModeExecuteParameters,
    signal?: AbortSignal,
    onUpdate?: (update: CodeModeNestedToolUpdate) => void,
  ): Promise<CodeModeSessionOperationResult> {
    if (this.shuttingDown) {
      const candidateSessionId = input.sessionId ?? this.runtime.createSessionId();
      const parsedSessionId = parseCodeModeSessionId(candidateSessionId);
      if (!parsedSessionId.ok) return invalidCodeModeSessionResult();
      return {
        result: createCodeModeFailure(
          parsedSessionId.value,
          "runtime",
          "CodeMode coordinator is shutting down",
        ),
      };
    }
    let located: LocateCodeModeSessionResult;
    if (input.sessionId === undefined) located = this.createLiveSession();
    else {
      const parsedSessionId = parseCodeModeSessionId(input.sessionId);
      if (!parsedSessionId.ok) return invalidCodeModeSessionResult();
      located = this.findSession(parsedSessionId.value);
    }
    if (located.record === undefined) return { result: located.failure };
    const record = located.record;
    this.touch(record);
    if (record.state === "terminal")
      return this.operationResult(record.latestResult, this.takeMetadata(record));
    if (record.currentCell !== undefined) {
      return {
        result: createCodeModeFailure(
          record.sessionId,
          "busy",
          "CodeMode Session already has an active Cell",
        ),
      };
    }

    const shouldWait = input.wait !== false;
    const cell = this.createActiveCell(shouldWait && onUpdate !== undefined ? { onUpdate } : {});
    const priorMetadata = this.takeMetadata(record);
    if (priorMetadata !== undefined) mergeCodeModeOuterMetadata(cell.metadata, priorMetadata);
    record.currentCell = cell;
    record.latestResult = createCodeModePending(record.sessionId);
    void this.startCell(record, cell, input);

    const pending = createCodeModePending(record.sessionId);
    if (!shouldWait) return { result: pending };
    const abort = (): void => {
      this.fatalizeSession(record, cell, {
        code: "cancellation",
        message: "CodeMode Cell was cancelled",
      });
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await cell.completion;
      const retainedRecord = this.records.get(record.sessionId) ?? record;
      return this.operationResult(result, this.takeMetadata(retainedRecord));
    } finally {
      cell.acceptsUpdates = false;
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Polls the latest retained Cell result without consuming that public result. */
  result(sessionIdValue: string): CodeModeSessionOperationResult {
    const parsedSessionId = parseCodeModeSessionId(sessionIdValue);
    if (!parsedSessionId.ok) return invalidCodeModeSessionResult();
    const sessionId = parsedSessionId.value;
    const record = this.records.get(sessionId);
    if (record === undefined) {
      return { result: createCodeModeFailure(sessionId, "unknown", "Unknown CodeMode Session") };
    }
    this.touch(record);
    if (record.state === "live" && record.currentCell !== undefined) {
      return { result: createCodeModePending(sessionId) };
    }
    const result = record.latestResult ?? createCodeModePending(sessionId);
    return this.operationResult(result, this.takeMetadata(record));
  }

  /** Force-terminates one live CodeMode Session and retains its cancellation result. */
  async cancel(sessionIdValue: string): Promise<CodeModeSessionOperationResult> {
    const parsedSessionId = parseCodeModeSessionId(sessionIdValue);
    if (!parsedSessionId.ok) return invalidCodeModeSessionResult();
    const sessionId = parsedSessionId.value;
    const record = this.records.get(sessionId);
    if (record === undefined) {
      return { result: createCodeModeFailure(sessionId, "unknown", "Unknown CodeMode Session") };
    }
    this.touch(record);
    if (record.state === "terminal") return { result: createCodeModeSuccess(sessionId) };
    if (record.currentCell !== undefined) {
      this.fatalizeSession(record, record.currentCell, {
        code: "cancellation",
        message: "CodeMode Session was cancelled",
      });
    } else {
      this.replaceWithTerminal(
        record,
        createCodeModeFailure(sessionId, "cancellation", "CodeMode Session was cancelled"),
      );
      void this.stopWorker(record.worker, "terminate");
    }
    await Promise.allSettled(this.pendingProcessStops);
    return { result: createCodeModeSuccess(sessionId) };
  }

  /** Releases every live Deno process; repeated shutdown calls share one completion. */
  shutdown(_reason: string): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownAllSessions();
    return this.shutdownPromise;
  }

  private async shutdownAllSessions(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.state !== "live") continue;
      if (record.currentCell === undefined) void this.stopWorker(record.worker, "shutdown");
      else {
        this.fatalizeSession(record, record.currentCell, {
          code: "cancellation",
          message: "CodeMode coordinator shut down",
        });
      }
    }
    await Promise.all(this.pendingProcessStops);
  }

  private createLiveSession(): LocateCodeModeSessionResult {
    const parsedSessionId = parseCodeModeSessionId(this.runtime.createSessionId());
    if (!parsedSessionId.ok) {
      return {
        failure: createCodeModeFailure(
          INVALID_CODEMODE_SESSION_ID,
          "runtime",
          "Pi CodeMode: Session ID capability returned an invalid identifier",
        ),
      };
    }
    const sessionId = parsedSessionId.value;
    this.evictTerminalRecords();
    const liveCount = [...this.records.values()].filter((record) => record.state === "live").length;
    if (liveCount >= this.options.maxSessions) {
      const failure = createCodeModeFailure(
        sessionId,
        "capacity",
        "CodeMode Session capacity is exhausted",
      );
      this.retainTerminalFailure(sessionId, failure);
      return { failure };
    }

    let worker: CodeModeWorkerProcess;
    try {
      worker = new CodeModeWorkerProcess({
        sessionId,
        runtime: this.runtime,
        onResponse: (response) => this.handleWorkerResponse(sessionId, response),
        onFailure: (message) => this.handleWorkerFailure(sessionId, message),
      });
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "CodeMode Deno process failed to start";
      const failure = createCodeModeFailure(sessionId, "runtime", message);
      this.retainTerminalFailure(sessionId, failure);
      return { failure };
    }
    const record: LiveCodeModeSession = {
      state: "live",
      sessionId,
      worker,
      lastAccess: ++this.accessSequence,
    };
    this.records.set(sessionId, record);
    return { record, failure: createCodeModePending(sessionId) };
  }

  private findSession(sessionId: CodeModeSessionId): LocateCodeModeSessionResult {
    const record = this.records.get(sessionId);
    return record === undefined
      ? { failure: createCodeModeFailure(sessionId, "unknown", "Unknown CodeMode Session") }
      : { record, failure: createCodeModePending(sessionId) };
  }

  private createActiveCell(options: {
    readonly onUpdate?: (update: CodeModeNestedToolUpdate) => void;
  }): ActiveCodeModeCell {
    const completion = Promise.withResolvers<CodeModeResult>();
    const cell: ActiveCodeModeCell = {
      cellId: `cell-${++this.cellSequence}`,
      abortController: new AbortController(),
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      metadata: emptyMetadataAccumulator(),
      acceptsUpdates: options.onUpdate !== undefined,
      settled: false,
    };
    if (options.onUpdate !== undefined) this.activeUpdateCallbacks.set(cell, options.onUpdate);
    return cell;
  }

  private async startCell(
    record: LiveCodeModeSession,
    cell: ActiveCodeModeCell,
    input: CodeModeExecuteParameters,
  ): Promise<void> {
    const transformed = transformCodeModeCell(input.script);
    if (!transformed.ok) {
      queueMicrotask(() =>
        this.settleReusableCell(
          record,
          cell,
          createCodeModeFailure(record.sessionId, "script", transformed.error.message),
        ),
      );
      return;
    }
    try {
      await record.worker.ready;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "CodeMode Deno process failed to start";
      this.fatalizeSession(record, cell, { code: "runtime", message });
      return;
    }
    if (!this.isCurrentCell(record, cell)) return;
    if (input.timeoutMs !== undefined) {
      cell.watchdog = this.runtime.setTimeout(() => {
        this.fatalizeSession(record, cell, {
          code: "timeout",
          message: "CodeMode Cell exceeded its timeout",
        });
      }, input.timeoutMs + CODEMODE_WATCHDOG_GRACE_MS);
    }
    try {
      const toolNames = [...new Set(this.options.getToolNames())];
      const requestBase = {
        version: 1,
        type: "execute",
        sessionId: record.sessionId,
        cellId: cell.cellId,
        source: transformed.cell.source,
        internalIdentifierPlaceholder: transformed.cell.internalIdentifierPlaceholder,
        toolNames,
      } as const;
      const request: CodeModeWorkerRequest = requestBase;
      const sent = record.worker.send(request);
      if (!sent.ok) {
        this.settleReusableCell(
          record,
          cell,
          createCodeModeFailure(record.sessionId, "serialization", sent.message),
        );
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "CodeMode tool snapshot failed";
      this.fatalizeSession(record, cell, { code: "runtime", message });
    }
  }

  private handleWorkerResponse(
    sessionId: CodeModeSessionId,
    response: CodeModeWorkerResponse,
  ): void {
    const record = this.records.get(sessionId);
    if (record?.state !== "live" || record.currentCell === undefined) return;
    const cell = record.currentCell;
    if (response.type === "cell-result") {
      if (response.cellId !== cell.cellId) {
        this.fatalizeSession(record, cell, {
          code: "runtime",
          message: "CodeMode worker returned a stale Cell result",
        });
        return;
      }
      if (response.resultJson === undefined) {
        this.settleReusableCell(record, cell, createCodeModeSuccess(sessionId));
        return;
      }
      const data = this.parseJsonString(response.resultJson, { allowUndefined: true });
      if (!data.ok) {
        this.settleReusableCell(
          record,
          cell,
          createCodeModeFailure(sessionId, "serialization", data.message),
        );
        return;
      }
      this.settleReusableCell(record, cell, createCodeModeSuccess(sessionId, data.value));
      return;
    }
    if (response.type === "cell-error") {
      if (response.cellId !== cell.cellId) {
        this.fatalizeSession(record, cell, {
          code: "runtime",
          message: "CodeMode worker returned a stale Cell failure",
        });
        return;
      }
      if (response.error.code === "runtime") {
        this.fatalizeSession(record, cell, {
          code: response.error.code,
          message: response.error.message,
        });
      } else {
        this.settleReusableCell(
          record,
          cell,
          createCodeModeFailure(sessionId, response.error.code, response.error.message),
        );
      }
      return;
    }
    if (response.type === "tool-batch") {
      if (response.cellId !== cell.cellId) {
        this.fatalizeSession(record, cell, {
          code: "runtime",
          message: "CodeMode worker returned a stale tool batch",
        });
        return;
      }
      void this.executeNestedToolBatch(record, cell, response);
      return;
    }
  }

  private async executeNestedToolBatch(
    record: LiveCodeModeSession,
    cell: ActiveCodeModeCell,
    response: Extract<CodeModeWorkerResponse, { readonly type: "tool-batch" }>,
  ): Promise<void> {
    const parsedCalls: CodeModeNestedToolCall[] = [];
    const earlyResults: CodeModeWorkerToolSettlement[] = [];
    for (const call of response.calls) {
      const input = this.parseJsonString(call.inputJson, { allowUndefined: false });
      if (!input.ok) {
        earlyResults.push({
          callId: call.callId,
          outcome: "error",
          error: { code: "serialization", message: input.message },
        });
      } else {
        parsedCalls.push({ callId: call.callId, toolName: call.toolName, input: input.value });
      }
    }

    let batchResult: CodeModeNestedToolBatchResult;
    try {
      const batch = {
        sessionId: record.sessionId,
        batchId: response.batchId,
        calls: parsedCalls,
        signal: cell.abortController.signal,
      } as const;
      const onUpdate = (update: CodeModeNestedToolUpdate): void => {
        if (cell.acceptsUpdates && this.isCurrentCell(record, cell)) {
          // The outer callback is captured by execute through this closure only while it awaits.
          const callback = this.activeUpdateCallbacks.get(cell);
          callback?.(update);
        }
      };
      batchResult =
        parsedCalls.length === 0
          ? { results: [] }
          : await this.options.executeToolBatch(
              cell.acceptsUpdates ? { ...batch, onUpdate } : batch,
            );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Nested Pi tool batch failed";
      batchResult = {
        results: parsedCalls.map((call) => ({
          callId: call.callId,
          outcome: "error",
          error: { code: "runtime", message },
        })),
      };
    }
    if (!this.isCurrentCell(record, cell)) return;
    mergeCodeModeOuterMetadata(cell.metadata, batchResult);
    if (batchResult.terminate === true) {
      this.fatalizeSession(record, cell, {
        code: "termination",
        message: "Nested Pi tool requested agent termination",
      });
      return;
    }

    const returned = new Map(batchResult.results.map((result) => [result.callId, result]));
    const settlements: CodeModeWorkerToolSettlement[] = [...earlyResults];
    for (const call of parsedCalls) {
      const result = returned.get(call.callId);
      if (result === undefined) {
        settlements.push({
          callId: call.callId,
          outcome: "error",
          error: { code: "runtime", message: "Nested Pi tool returned no result" },
        });
        continue;
      }
      if (result.outcome === "error") {
        settlements.push({
          callId: call.callId,
          outcome: "error",
          error: {
            code: result.error.code || "runtime",
            message: result.error.message || "Nested Pi tool failed",
          },
        });
        continue;
      }
      const parsedResult = parseCodeModeJsonValue(result.result, {
        maxBytes: CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
      });
      if (!parsedResult.ok || parsedResult.value === undefined) {
        settlements.push({
          callId: call.callId,
          outcome: "error",
          error: {
            code: "serialization",
            message: parsedResult.ok
              ? "Nested Pi tool returned no JSON value"
              : parsedResult.message,
          },
        });
      } else {
        settlements.push({
          callId: call.callId,
          outcome: "success",
          resultJson: JSON.stringify(parsedResult.value),
        });
      }
    }
    const resultRequest = {
      version: 1,
      type: "tool-results",
      sessionId: record.sessionId,
      cellId: cell.cellId,
      batchId: response.batchId,
      results: settlements,
    } as const;
    const sent = record.worker.send(resultRequest);
    if (sent.ok) return;
    if (sent.message === "CodeMode worker request exceeds 8 MiB") {
      const boundedResults: CodeModeWorkerToolSettlement[] = settlements.map((settlement) =>
        settlement.outcome === "success"
          ? {
              callId: settlement.callId,
              outcome: "error",
              error: {
                code: "serialization",
                message: "Nested Pi tool result exceeds the process message limit",
              },
            }
          : {
              ...settlement,
              error: {
                code: settlement.error.code.slice(0, 128) || "runtime",
                message: settlement.error.message.slice(0, 4_096) || "Nested Pi tool failed",
              },
            },
      );
      const bounded = record.worker.send({ ...resultRequest, results: boundedResults });
      if (bounded.ok) return;
      this.fatalizeSession(record, cell, { code: "runtime", message: bounded.message });
      return;
    }
    this.fatalizeSession(record, cell, { code: "runtime", message: sent.message });
  }

  private parseJsonString(
    json: string,
    options: { readonly allowUndefined: boolean },
  ):
    | { readonly ok: true; readonly value: CodeModeJsonValue }
    | { readonly ok: false; readonly message: string } {
    let decoded: unknown;
    try {
      decoded = JSON.parse(json);
    } catch {
      return { ok: false, message: "CodeMode process returned invalid nested JSON" };
    }
    const parsed = parseCodeModeJsonValue(decoded, {
      allowUndefined: options.allowUndefined,
      maxBytes: CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
    });
    if (!parsed.ok || parsed.value === undefined) {
      return {
        ok: false,
        message: parsed.ok ? "CodeMode process returned no JSON value" : parsed.message,
      };
    }
    return { ok: true, value: parsed.value };
  }

  private settleReusableCell(
    record: LiveCodeModeSession,
    cell: ActiveCodeModeCell,
    result: CodeModeResult,
  ): void {
    if (!this.isCurrentCell(record, cell)) return;
    this.clearCellResources(cell);
    record.latestResult = result;
    const metadata = finalizeCodeModeMetadata(cell.metadata);
    if (metadata === undefined) delete record.availableMetadata;
    else record.availableMetadata = metadata;
    delete record.currentCell;
    cell.settled = true;
    cell.resolveCompletion(result);
    this.touch(record);
  }

  private fatalizeSession(
    record: LiveCodeModeSession,
    cell: ActiveCodeModeCell,
    failure: FatalCodeModeSessionFailure,
  ): void {
    if (!this.isCurrentCell(record, cell)) return;
    if (failure.code === "termination") cell.metadata.terminate = true;
    cell.abortController.abort();
    this.clearCellResources(cell);
    const result = createCodeModeFailure(record.sessionId, failure.code, failure.message);
    const metadata = finalizeCodeModeMetadata(cell.metadata);
    this.replaceWithTerminal(record, result, metadata);
    cell.settled = true;
    cell.resolveCompletion(result);
    void this.stopWorker(record.worker, "terminate");
  }

  private replaceWithTerminal(
    record: LiveCodeModeSession,
    result: CodeModeResult,
    metadata = record.availableMetadata,
  ): void {
    const terminalBase = {
      state: "terminal",
      sessionId: record.sessionId,
      lastAccess: ++this.accessSequence,
      latestResult: result,
    } as const;
    const terminal: TerminalCodeModeSession =
      metadata === undefined ? terminalBase : { ...terminalBase, availableMetadata: metadata };
    this.records.set(record.sessionId, terminal);
    this.evictTerminalRecords();
  }

  private stopWorker(worker: CodeModeWorkerProcess, mode: "shutdown" | "terminate"): Promise<void> {
    const stop = (mode === "shutdown" ? worker.shutdown() : worker.terminate()).finally(() => {
      this.pendingProcessStops.delete(stop);
    });
    this.pendingProcessStops.add(stop);
    return stop;
  }

  private handleWorkerFailure(sessionId: CodeModeSessionId, message: string): void {
    const record = this.records.get(sessionId);
    if (record?.state !== "live") return;
    if (record.currentCell !== undefined) {
      this.fatalizeSession(record, record.currentCell, { code: "runtime", message });
    } else {
      this.replaceWithTerminal(record, createCodeModeFailure(sessionId, "runtime", message));
    }
  }

  private isCurrentCell(record: LiveCodeModeSession, cell: ActiveCodeModeCell): boolean {
    return (
      !cell.settled && this.records.get(record.sessionId) === record && record.currentCell === cell
    );
  }

  private clearCellResources(cell: ActiveCodeModeCell): void {
    if (cell.watchdog !== undefined) this.runtime.clearTimeout(cell.watchdog);
    this.activeUpdateCallbacks.delete(cell);
    cell.acceptsUpdates = false;
  }

  private takeMetadata(record: CodeModeSessionRecord): CodeModeOuterToolMetadata | undefined {
    const metadata = record.availableMetadata;
    delete record.availableMetadata;
    return metadata;
  }

  private operationResult(
    result: CodeModeResult,
    metadata: CodeModeOuterToolMetadata | undefined,
  ): CodeModeSessionOperationResult {
    return metadata === undefined ? { result } : { result, metadata };
  }

  private touch(record: CodeModeSessionRecord): void {
    record.lastAccess = ++this.accessSequence;
  }

  private retainTerminalFailure(sessionId: CodeModeSessionId, failure: CodeModeResult): void {
    this.records.set(sessionId, {
      state: "terminal",
      sessionId,
      lastAccess: ++this.accessSequence,
      latestResult: failure,
    });
    this.evictTerminalRecords();
  }

  private evictTerminalRecords(): void {
    const terminalRecords = [...this.records.values()]
      .filter((record): record is TerminalCodeModeSession => record.state === "terminal")
      .sort((left, right) => left.lastAccess - right.lastAccess);
    for (
      let index = 0;
      index < terminalRecords.length - CODEMODE_MAX_TERMINAL_RECORDS;
      index += 1
    ) {
      const record = terminalRecords[index];
      if (record !== undefined) this.records.delete(record.sessionId);
    }
  }
}
