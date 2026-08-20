import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { transformCodeModeCell } from "./codemode-cell-transform.js";
import { CodeModeWorkerProcess } from "./codemode-deno-process.js";
import { formatCodeModePresentationData } from "./codemode-presentation-output.js";
import type { CodeModeRuntime, CodeModeTimerHandle } from "./codemode-runtime.js";
import type { CodeModeResultSpillWriter } from "./codemode-session-files.js";
import {
  createCodeModeFailure,
  createCodeModePending,
  createCodeModeSuccess,
  parseCodeModeJsonValue,
  type CodeModeErrorCode,
  type CodeModeExecuteParameters,
  type CodeModeJsonValue,
  type CodeModePresentationSnapshot,
  type CodeModeResult,
  type CodeModeResultDetails,
  type CodeModeToolOperationMetadata,
} from "./codemode-tool-contract.js";
import {
  CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
  type CodeModeWorkerRequest,
  type CodeModeWorkerResponse,
  type CodeModeWorkerToolSettlement,
} from "./codemode-worker-protocol.js";

const CODEMODE_MAX_TERMINAL_RECORDS = 64;
const CODEMODE_PRESENTED_NESTED_TOOL_LIMIT = 20;
const CODEMODE_ACTIVE_TOOL_NAME_LIMIT = 32;
const CODEMODE_PROGRESS_REFRESH_MS = 1_000;
const CODEMODE_RESULT_PRESENTATION_MAX_BYTES = 50 * 1024;
const CODEMODE_RESULT_PRESENTATION_MAX_LINES = 2_000;
const CODEMODE_WATCHDOG_GRACE_MS = 100;
const INVALID_CODEMODE_SESSION_ID = "invalid-session-id";

/** Branded identifier for one retained CodeMode Session. */
export type CodeModeSessionId = string & { readonly CodeModeSessionId: unique symbol };

/** Observer state of one settled CodeMode Cell. */
export type CodeModeObservedCellState = "completed" | "failed" | "cancelled" | "timed_out";

/** Immutable read-only facts for the currently running CodeMode Cell. */
export type CodeModeObservedCurrentCell = {
  /** One-based Cell Ordinal within its CodeMode Session. */
  readonly ordinal: number;
  /** Parent wall-clock start time in Unix-epoch milliseconds. */
  readonly started_at_ms: number;
  /** Bounded unique names currently delegated to registered Pi handlers. */
  readonly active_tool_names: readonly string[];
  /** Exact current nested-call count, including names omitted from the bounded list. */
  readonly active_tool_count: number;
  /** Exact nested-call count accumulated by the current Cell. */
  readonly nested_tool_count: number;
};

/** Immutable read-only facts for the most recently settled CodeMode Cell. */
export type CodeModeObservedLastCell = {
  /** One-based Cell Ordinal within its CodeMode Session. */
  readonly ordinal: number;
  /** Parent wall-clock start time in Unix-epoch milliseconds. */
  readonly started_at_ms: number;
  /** Parent wall-clock settlement time in Unix-epoch milliseconds. */
  readonly settled_at_ms: number;
  readonly state: CodeModeObservedCellState;
  readonly error_code?: CodeModeErrorCode;
  readonly nested_tool_count: number;
};

/** Immutable read-only facts for one CodeMode Session with at least one Cell. */
export type CodeModeObservedSession = {
  readonly sessionId: CodeModeSessionId;
  readonly lifecycle: "running" | "idle" | "terminal";
  /** Number of Cells started in this CodeMode Session. */
  readonly cell_count: number;
  /** Parent wall-clock time of the latest execution-visible transition. */
  readonly last_activity_at_ms: number;
  readonly current_cell?: CodeModeObservedCurrentCell;
  readonly last_cell?: CodeModeObservedLastCell;
  readonly terminal_error_code?: CodeModeErrorCode;
};

/** Immutable point-in-time facts used by the ephemeral CodeMode Observer UI. */
export type CodeModeObserverSnapshot = {
  readonly sessions: readonly CodeModeObservedSession[];
};

/** One idle CodeMode worker failure not represented by an active Cell result. */
export type CodeModeUnexpectedFailure = {
  readonly sessionId: CodeModeSessionId;
  readonly message: string;
};

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
  readonly presentation?: readonly {
    readonly callId: string;
    readonly name: string;
    readonly outcome: "success" | "failed" | "cancelled";
    readonly elapsedMs: number;
  }[];
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
  readonly presentation?: CodeModePresentationSnapshot;
};

/** Construction capabilities and limits for one CodeMode Session coordinator. */
export type CodeModeSessionCoordinatorOptions = {
  readonly maxSessions: number;
  readonly getToolNames: () => readonly string[];
  readonly executeToolBatch: ExecuteCodeModeNestedToolBatch;
  /** Private Result Spill storage for complete oversized presentation data. */
  readonly resultSpillWriter: CodeModeResultSpillWriter;
  /** Explicit parent clock and Session-ID capabilities. */
  readonly runtime: CodeModeRuntime;
  /** Receives immutable Observer facts after a visible Session transition. */
  readonly onSnapshotChange?: (snapshot: CodeModeObserverSnapshot) => void;
  /** Receives an idle worker failure that no active Cell result represents. */
  readonly onUnexpectedFailure?: (failure: CodeModeUnexpectedFailure) => void;
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
  readonly ordinal: number;
  readonly startedAtMs: number;
  readonly abortController: AbortController;
  readonly completion: Promise<CodeModeResult>;
  readonly resolveCompletion: (result: CodeModeResult) => void;
  readonly metadata: CodeModeMetadataAccumulator;
  readonly nestedTools: CodeModePresentationSnapshot["nested_tools"];
  activeToolNames: readonly string[];
  activeToolCount: number;
  failedNestedToolCount: number;
  nestedToolCount: number;
  succeededNestedToolCount: number;
  acceptsUpdates: boolean;
  settled: boolean;
  progressTimer?: CodeModeTimerHandle;
  watchdog?: CodeModeTimerHandle;
};

type LiveCodeModeSession = {
  readonly state: "live";
  readonly sessionId: CodeModeSessionId;
  readonly worker: CodeModeWorkerProcess;
  lastAccess: number;
  lastActivityAtMs: number;
  cellCount: number;
  latestResult?: CodeModeResult;
  latestPresentation?: CodeModePresentationSnapshot;
  currentCell?: ActiveCodeModeCell;
  lastCell?: CodeModeObservedLastCell;
  availableMetadata?: CodeModeOuterToolMetadata;
};

type TerminalCodeModeSession = {
  readonly state: "terminal";
  readonly sessionId: CodeModeSessionId;
  lastAccess: number;
  readonly lastActivityAtMs: number;
  readonly cellCount: number;
  readonly latestResult: CodeModeResult;
  readonly latestPresentation?: CodeModePresentationSnapshot;
  readonly lastCell?: CodeModeObservedLastCell;
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
      return this.operationResult(
        record.latestResult,
        this.takeMetadata(record),
        record.latestPresentation,
      );
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
    const cell = this.createActiveCell(
      record,
      shouldWait && onUpdate !== undefined ? { onUpdate } : {},
    );
    const priorMetadata = this.takeMetadata(record);
    if (priorMetadata !== undefined) mergeCodeModeOuterMetadata(cell.metadata, priorMetadata);
    record.currentCell = cell;
    record.latestResult = createCodeModePending(record.sessionId);
    record.lastActivityAtMs = cell.startedAtMs;
    this.publishObserverSnapshot();
    this.emitCellProgress(record, cell);
    this.scheduleCellProgress(record, cell);
    void this.startCell(record, cell, input);

    const pending = createCodeModePending(record.sessionId);
    if (!shouldWait) {
      return this.operationResult(pending, undefined, this.runningCellPresentation(cell));
    }
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
      return this.operationResult(
        result,
        this.takeMetadata(retainedRecord),
        retainedRecord.latestPresentation,
      );
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
      return this.operationResult(
        createCodeModePending(sessionId),
        undefined,
        this.runningCellPresentation(record.currentCell),
      );
    }
    const result = record.latestResult ?? createCodeModePending(sessionId);
    return this.operationResult(result, this.takeMetadata(record), record.latestPresentation);
  }

  /** Returns immutable, non-authoritative facts for the ephemeral CodeMode Observer UI. */
  inspectObserverSnapshot(): CodeModeObserverSnapshot {
    const sessions = [...this.records.values()]
      .filter((record) => record.cellCount > 0)
      .map((record) => this.observeSession(record));
    return Object.freeze({ sessions: Object.freeze(sessions) });
  }

  /** Return the shortest currently unique Session prefix, or the full unknown historical ID. */
  formatSessionPrefix(sessionIdValue: string): string {
    const parsed = parseCodeModeSessionId(sessionIdValue);
    if (!parsed.ok || !this.records.has(parsed.value)) return sessionIdValue;
    const sessionIds = [...this.records.keys()];
    let length = Math.min(8, sessionIdValue.length);
    while (
      length < sessionIdValue.length &&
      sessionIds.some(
        (candidate) =>
          candidate !== parsed.value && candidate.startsWith(sessionIdValue.slice(0, length)),
      )
    ) {
      length += 1;
    }
    return sessionIdValue.slice(0, length);
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
    if (record.state === "terminal") {
      return this.operationResult(
        createCodeModeSuccess(sessionId),
        undefined,
        record.latestPresentation,
      );
    }
    if (record.currentCell !== undefined) {
      this.fatalizeSession(record, record.currentCell, {
        code: "cancellation",
        message: "CodeMode Session was cancelled",
      });
    } else {
      record.lastActivityAtMs = this.runtime.now();
      record.latestPresentation = {
        version: 1,
        cell_state: "cancelled",
        session_state: "closed",
        elapsed_ms: 0,
        active_tool_names: [],
        active_tool_count: 0,
        nested_tool_count: 0,
        succeeded_nested_tool_count: 0,
        failed_nested_tool_count: 0,
        nested_tools: [],
        omitted_nested_tool_count: 0,
      };
      this.replaceWithTerminal(
        record,
        createCodeModeFailure(sessionId, "cancellation", "CodeMode Session was cancelled"),
      );
      void this.stopWorker(record.worker, "terminate");
    }
    await Promise.allSettled(this.pendingProcessStops);
    const terminal = this.records.get(sessionId);
    return this.operationResult(
      createCodeModeSuccess(sessionId),
      undefined,
      terminal?.latestPresentation,
    );
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
      lastActivityAtMs: this.runtime.now(),
      cellCount: 0,
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

  private createActiveCell(
    record: LiveCodeModeSession,
    options: { readonly onUpdate?: (update: CodeModeNestedToolUpdate) => void },
  ): ActiveCodeModeCell {
    const completion = Promise.withResolvers<CodeModeResult>();
    const cell: ActiveCodeModeCell = {
      cellId: `cell-${++this.cellSequence}`,
      ordinal: ++record.cellCount,
      startedAtMs: this.runtime.now(),
      abortController: new AbortController(),
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      metadata: emptyMetadataAccumulator(),
      nestedTools: [],
      activeToolNames: [],
      activeToolCount: 0,
      failedNestedToolCount: 0,
      nestedToolCount: 0,
      succeededNestedToolCount: 0,
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
    cell.activeToolNames = [...new Set(response.calls.map((call) => call.toolName))];
    cell.activeToolCount = response.calls.length;
    cell.nestedToolCount += response.calls.length;
    record.lastActivityAtMs = this.runtime.now();
    this.publishObserverSnapshot();

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
      const onUpdate = (_update: CodeModeNestedToolUpdate): void => {
        if (cell.acceptsUpdates && this.isCurrentCell(record, cell)) {
          this.emitCellProgress(record, cell);
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
    this.recordNestedToolPresentation(cell, response.calls, batchResult);
    cell.activeToolNames = [];
    cell.activeToolCount = 0;
    record.lastActivityAtMs = this.runtime.now();
    this.publishObserverSnapshot();
    this.emitCellProgress(record, cell);
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

  private recordNestedToolPresentation(
    cell: ActiveCodeModeCell,
    calls: readonly { readonly callId: string; readonly toolName: string }[],
    batchResult: CodeModeNestedToolBatchResult,
  ): void {
    const results = new Map(batchResult.results.map((result) => [result.callId, result]));
    const presented = new Map(batchResult.presentation?.map((item) => [item.callId, item]) ?? []);
    for (const call of calls) {
      const bridgePresentation = presented.get(call.callId);
      const outcome =
        bridgePresentation?.outcome ??
        (results.get(call.callId)?.outcome === "success" ? "success" : "failed");
      if (outcome === "success") cell.succeededNestedToolCount += 1;
      else cell.failedNestedToolCount += 1;
      if (cell.nestedTools.length >= CODEMODE_PRESENTED_NESTED_TOOL_LIMIT) continue;
      cell.nestedTools.push({
        name: call.toolName.slice(0, 256) || "unknown-tool",
        outcome,
        elapsed_ms: Math.max(
          0,
          Math.min(Number.MAX_SAFE_INTEGER, Math.round(bridgePresentation?.elapsedMs ?? 0)),
        ),
      });
    }
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

  private runningCellPresentation(cell: ActiveCodeModeCell): CodeModePresentationSnapshot {
    return this.cellPresentation(cell, "running", "live", this.runtime.now());
  }

  private cellPresentation(
    cell: ActiveCodeModeCell,
    cellState: CodeModePresentationSnapshot["cell_state"],
    sessionState: CodeModePresentationSnapshot["session_state"],
    observedAtMs: number,
    spillPath?: string,
  ): CodeModePresentationSnapshot {
    const presentation: CodeModePresentationSnapshot = {
      version: 1,
      cell_ordinal: cell.ordinal,
      cell_state: cellState,
      session_state: sessionState,
      elapsed_ms: Math.max(
        0,
        Math.min(Number.MAX_SAFE_INTEGER, Math.round(observedAtMs - cell.startedAtMs)),
      ),
      active_tool_names: cell.activeToolNames
        .slice(0, CODEMODE_ACTIVE_TOOL_NAME_LIMIT)
        .map((name) => name.slice(0, 256) || "unknown-tool"),
      active_tool_count: cell.activeToolCount,
      nested_tool_count: cell.nestedToolCount,
      succeeded_nested_tool_count: cell.succeededNestedToolCount,
      failed_nested_tool_count: cell.failedNestedToolCount,
      nested_tools: [...cell.nestedTools],
      omitted_nested_tool_count: Math.max(0, cell.nestedToolCount - cell.nestedTools.length),
    };
    return spillPath === undefined ? presentation : { ...presentation, spill_path: spillPath };
  }

  private settledCellPresentation(
    cell: ActiveCodeModeCell,
    result: CodeModeResult,
    sessionState: CodeModePresentationSnapshot["session_state"],
  ): CodeModePresentationSnapshot {
    let spillPath: string | undefined;
    if (result.result === "success" && result.data !== undefined) {
      const completeOutput = formatCodeModePresentationData(result.data);
      const visible = truncateHead(completeOutput, {
        maxBytes: CODEMODE_RESULT_PRESENTATION_MAX_BYTES,
        maxLines: CODEMODE_RESULT_PRESENTATION_MAX_LINES,
      });
      if (visible.truncated) {
        try {
          const spill = this.options.resultSpillWriter.writeResultSpill(completeOutput);
          spillPath = spill.path;
          void spill.completion.catch(() => undefined);
        } catch {
          // Presentation storage failure must not change the successful model-facing Cell result.
        }
      }
    }
    return this.cellPresentation(
      cell,
      this.presentationCellState(result),
      sessionState,
      this.runtime.now(),
      spillPath,
    );
  }

  private presentationCellState(
    result: CodeModeResult,
  ): CodeModePresentationSnapshot["cell_state"] {
    if (result.result !== "failed") return result.result === "pending" ? "running" : "completed";
    if (result.error.code === "timeout") return "timed_out";
    if (result.error.code === "cancellation") return "cancelled";
    return "failed";
  }

  private emitCellProgress(record: LiveCodeModeSession, cell: ActiveCodeModeCell): void {
    if (!cell.acceptsUpdates || !this.isCurrentCell(record, cell)) return;
    const result = createCodeModePending(record.sessionId);
    const details: CodeModeResultDetails = {
      ...result,
      presentation: this.runningCellPresentation(cell),
    };
    try {
      this.activeUpdateCallbacks.get(cell)?.({
        content: [{ type: "text", text: JSON.stringify(result) }],
        details,
      });
    } catch {
      // A non-authoritative progress renderer cannot alter Cell execution.
    }
  }

  private scheduleCellProgress(record: LiveCodeModeSession, cell: ActiveCodeModeCell): void {
    if (!cell.acceptsUpdates || !this.isCurrentCell(record, cell)) return;
    cell.progressTimer = this.runtime.setTimeout(() => {
      delete cell.progressTimer;
      this.emitCellProgress(record, cell);
      this.scheduleCellProgress(record, cell);
    }, CODEMODE_PROGRESS_REFRESH_MS);
  }

  private settleReusableCell(
    record: LiveCodeModeSession,
    cell: ActiveCodeModeCell,
    result: CodeModeResult,
  ): void {
    if (!this.isCurrentCell(record, cell)) return;
    this.clearCellResources(cell);
    const presentation = this.settledCellPresentation(cell, result, "live");
    const settledAtMs = this.runtime.now();
    record.latestResult = result;
    record.latestPresentation = presentation;
    record.lastCell = this.observeSettledCell(cell, result, settledAtMs);
    record.lastActivityAtMs = settledAtMs;
    const metadata = finalizeCodeModeMetadata(cell.metadata);
    if (metadata === undefined) delete record.availableMetadata;
    else record.availableMetadata = metadata;
    delete record.currentCell;
    cell.settled = true;
    cell.resolveCompletion(result);
    this.touch(record);
    this.publishObserverSnapshot();
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
    const settledAtMs = this.runtime.now();
    record.latestPresentation = this.cellPresentation(
      cell,
      this.presentationCellState(result),
      "closed",
      settledAtMs,
    );
    record.lastCell = this.observeSettledCell(cell, result, settledAtMs);
    record.lastActivityAtMs = settledAtMs;
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
    let terminal: TerminalCodeModeSession = {
      state: "terminal",
      sessionId: record.sessionId,
      lastAccess: ++this.accessSequence,
      lastActivityAtMs: record.lastActivityAtMs,
      cellCount: record.cellCount,
      latestResult: result,
    };
    if (record.latestPresentation !== undefined) {
      terminal = { ...terminal, latestPresentation: record.latestPresentation };
    }
    if (record.lastCell !== undefined) terminal = { ...terminal, lastCell: record.lastCell };
    if (metadata !== undefined) terminal = { ...terminal, availableMetadata: metadata };
    this.records.set(record.sessionId, terminal);
    this.evictTerminalRecords();
    this.publishObserverSnapshot();
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
      record.lastActivityAtMs = this.runtime.now();
      record.latestPresentation = {
        version: 1,
        cell_state: "failed",
        session_state: "closed",
        elapsed_ms: 0,
        active_tool_names: [],
        active_tool_count: 0,
        nested_tool_count: 0,
        succeeded_nested_tool_count: 0,
        failed_nested_tool_count: 0,
        nested_tools: [],
        omitted_nested_tool_count: 0,
      };
      this.replaceWithTerminal(record, createCodeModeFailure(sessionId, "runtime", message));
      try {
        this.options.onUnexpectedFailure?.(Object.freeze({ sessionId, message }));
      } catch {
        // A non-authoritative Observer failure cannot alter CodeMode Session lifecycle.
      }
    }
  }

  private isCurrentCell(record: LiveCodeModeSession, cell: ActiveCodeModeCell): boolean {
    return (
      !cell.settled && this.records.get(record.sessionId) === record && record.currentCell === cell
    );
  }

  private clearCellResources(cell: ActiveCodeModeCell): void {
    if (cell.progressTimer !== undefined) {
      this.runtime.clearTimeout(cell.progressTimer);
      delete cell.progressTimer;
    }
    if (cell.watchdog !== undefined) {
      this.runtime.clearTimeout(cell.watchdog);
      delete cell.watchdog;
    }
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
    presentation: CodeModePresentationSnapshot | undefined,
  ): CodeModeSessionOperationResult {
    if (metadata === undefined) {
      return presentation === undefined ? { result } : { result, presentation };
    }
    if (presentation === undefined) return { result, metadata };
    return { result, metadata, presentation };
  }

  private touch(record: CodeModeSessionRecord): void {
    record.lastAccess = ++this.accessSequence;
  }

  private observeSession(record: CodeModeSessionRecord): CodeModeObservedSession {
    const lifecycle =
      record.state === "terminal"
        ? "terminal"
        : record.currentCell === undefined
          ? "idle"
          : "running";
    const currentCell = record.state === "live" ? record.currentCell : undefined;
    const current_cell =
      currentCell === undefined
        ? undefined
        : Object.freeze({
            ordinal: currentCell.ordinal,
            started_at_ms: currentCell.startedAtMs,
            active_tool_names: Object.freeze([...currentCell.activeToolNames]),
            active_tool_count: currentCell.activeToolCount,
            nested_tool_count: currentCell.nestedToolCount,
          });
    const terminalErrorCode =
      record.state === "terminal" && record.latestResult.result === "failed"
        ? record.latestResult.error.code
        : undefined;
    let observed: CodeModeObservedSession = {
      sessionId: record.sessionId,
      lifecycle,
      cell_count: record.cellCount,
      last_activity_at_ms: record.lastActivityAtMs,
    };
    if (current_cell !== undefined) observed = { ...observed, current_cell };
    if (record.lastCell !== undefined) observed = { ...observed, last_cell: record.lastCell };
    if (terminalErrorCode !== undefined) {
      observed = { ...observed, terminal_error_code: terminalErrorCode };
    }
    return Object.freeze(observed);
  }

  private observeSettledCell(
    cell: ActiveCodeModeCell,
    result: CodeModeResult,
    settledAtMs: number,
  ): CodeModeObservedLastCell {
    const errorCode = result.result === "failed" ? result.error.code : undefined;
    const state: CodeModeObservedCellState =
      errorCode === "cancellation"
        ? "cancelled"
        : errorCode === "timeout"
          ? "timed_out"
          : errorCode === undefined
            ? "completed"
            : "failed";
    const settledCell = {
      ordinal: cell.ordinal,
      started_at_ms: cell.startedAtMs,
      settled_at_ms: settledAtMs,
      state,
      nested_tool_count: cell.nestedToolCount,
    };
    return Object.freeze(
      errorCode === undefined ? settledCell : { ...settledCell, error_code: errorCode },
    );
  }

  private publishObserverSnapshot(): void {
    try {
      this.options.onSnapshotChange?.(this.inspectObserverSnapshot());
    } catch {
      // A non-authoritative Observer failure cannot alter CodeMode Session lifecycle.
    }
  }

  private retainTerminalFailure(sessionId: CodeModeSessionId, failure: CodeModeResult): void {
    this.records.set(sessionId, {
      state: "terminal",
      sessionId,
      lastAccess: ++this.accessSequence,
      lastActivityAtMs: this.runtime.now(),
      cellCount: 0,
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
