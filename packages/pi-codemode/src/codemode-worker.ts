/* oxlint-disable anti-slop/no-runtime-typeof -- This Deno entrypoint parses values returned from the isolated QuickJS guest before using them. */
import {
  DEBUG_SYNC,
  newQuickJSWASMModule,
  RELEASE_SYNC,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import { CODEMODE_NOTEBOOK_BOOTSTRAP_SOURCE } from "./codemode-cell-transform.ts";
import {
  CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
  parseCodeModeWorkerRequest,
  serializeCodeModeWorkerResponse,
  type CodeModeWorkerCellErrorCode,
  type CodeModeWorkerRequest,
  type CodeModeWorkerResponse,
  type CodeModeWorkerToolCall,
  type CodeModeWorkerToolSettlement,
  type CodeModeWorkerTracerResponse,
  type CodeModeWorkerMemoryUsage,
} from "./codemode-worker-protocol.ts";

const QUICKJS_HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
const QUICKJS_STACK_LIMIT_BYTES = 1024 * 1024;
const CODEMODE_WORKER_READ_BUFFER_BYTES = 64 * 1024;

const CODEMODE_GUEST_BRIDGE_BOOTSTRAP_SOURCE = String.raw`(() => {
  const nativeToolCall = globalThis.__piCodeModeNativeToolCall;
  delete globalThis.__piCodeModeNativeToolCall;

  const arrayIsArray = Array.isArray;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;
  const objectCreate = Object.create;
  const objectDefineProperty = Object.defineProperty;
  const objectFreeze = Object.freeze;
  const objectKeys = Object.keys;
  const objectPrototype = Object.prototype;
  const ownKeys = Reflect.ownKeys;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const numberFrom = Number;
  const numberIsFinite = Number.isFinite;
  const numberIsSafeInteger = Number.isSafeInteger;
  const stringFrom = String;
  const stringCharCodeAt = Function.call.bind(String.prototype.charCodeAt);

  class CodeModeSerializationError extends Error {
    constructor(message) {
      super(message);
      this.name = "CodeModeSerializationError";
    }
  }

  class CodeModeToolError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "CodeModeToolError";
      this.code = code;
    }
  }

  objectDefineProperty(globalThis, "CodeModeToolError", {
    configurable: false,
    enumerable: false,
    value: CodeModeToolError,
    writable: false,
  });

  function utf8ByteLength(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = stringCharCodeAt(value, index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = stringCharCodeAt(value, index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      } else bytes += 3;
      if (bytes > ${CODEMODE_WORKER_MESSAGE_LIMIT_BYTES}) return bytes;
    }
    return bytes;
  }

  function serializeJson(value, allowUndefined) {
    const seen = new Set();
    function inspect(candidate, path) {
      if (candidate === null) return null;
      if (candidate === undefined) {
        if (path === "$" && allowUndefined) return undefined;
        throw new CodeModeSerializationError(path + " must be JSON data");
      }
      const type = typeof candidate;
      if (type === "boolean" || type === "string") return candidate;
      if (type === "number") {
        if (!numberIsFinite(candidate)) {
          throw new CodeModeSerializationError(path + " must be finite");
        }
        return candidate;
      }
      if (type !== "object") {
        throw new CodeModeSerializationError(path + " is not JSON data");
      }
      if (seen.has(candidate)) throw new CodeModeSerializationError(path + " is cyclic");
      seen.add(candidate);
      try {
        if (arrayIsArray(candidate)) {
          const output = [];
          for (const key of ownKeys(candidate)) {
            if (key === "length") continue;
            if (typeof key !== "string") {
              throw new CodeModeSerializationError(path + " has a symbol property");
            }
            const descriptor = getOwnPropertyDescriptor(candidate, key);
            const index = numberFrom(key);
            if (
              descriptor === undefined ||
              !descriptor.enumerable ||
              !numberIsSafeInteger(index) ||
              index < 0 ||
              stringFrom(index) !== key
            ) {
              throw new CodeModeSerializationError(path + "." + key + " is not a JSON array index");
            }
          }
          for (let index = 0; index < candidate.length; index += 1) {
            const descriptor = getOwnPropertyDescriptor(candidate, String(index));
            if (descriptor === undefined || !("value" in descriptor)) {
              throw new CodeModeSerializationError(path + "[" + index + "] is sparse or accessor-backed");
            }
            output.push(inspect(descriptor.value, path + "[" + index + "]"));
          }
          return output;
        }
        const prototype = getPrototypeOf(candidate);
        if (prototype !== objectPrototype && prototype !== null) {
          throw new CodeModeSerializationError(path + " must be a plain object");
        }
        const output = objectCreate(null);
        for (const key of ownKeys(candidate)) {
          if (typeof key !== "string") {
            throw new CodeModeSerializationError(path + " has a symbol property");
          }
          const descriptor = getOwnPropertyDescriptor(candidate, key);
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new CodeModeSerializationError(path + "." + key + " is non-enumerable or accessor-backed");
          }
          output[key] = inspect(descriptor.value, path + "." + key);
        }
        return output;
      } finally {
        seen.delete(candidate);
      }
    }

    const inspected = inspect(value, "$" );
    if (inspected === undefined) return undefined;
    const json = jsonStringify(inspected);
    if (utf8ByteLength(json) > ${CODEMODE_WORKER_MESSAGE_LIMIT_BYTES}) {
      throw new CodeModeSerializationError("CodeMode JSON exceeds 8 MiB");
    }
    return json;
  }

  function formatError(error) {
    let name = "Error";
    let message = "CodeMode Cell rejected";
    let stack;
    if (typeof error === "string") message = error;
    else if (error === null) message = "null";
    else if (
      typeof error === "number" ||
      typeof error === "boolean" ||
      typeof error === "bigint" ||
      typeof error === "undefined"
    ) message = stringFrom(error);
    else if (typeof error === "symbol") message = "Symbol";
    else if (typeof error === "object" || typeof error === "function") {
      const nameDescriptor = getOwnPropertyDescriptor(error, "name");
      const messageDescriptor = getOwnPropertyDescriptor(error, "message");
      const stackDescriptor = getOwnPropertyDescriptor(error, "stack");
      if (nameDescriptor !== undefined && "value" in nameDescriptor && typeof nameDescriptor.value === "string") {
        name = nameDescriptor.value;
      }
      if (messageDescriptor !== undefined && "value" in messageDescriptor && typeof messageDescriptor.value === "string") {
        message = messageDescriptor.value;
      }
      if (stackDescriptor !== undefined && "value" in stackDescriptor && typeof stackDescriptor.value === "string") {
        stack = stackDescriptor.value;
      }
    }
    return jsonStringify({ name, message, ...(stack === undefined ? {} : { stack }) });
  }

  let toolFunctions = objectFreeze(objectCreate(null));
  const tools = new Proxy(objectCreate(null), {
    defineProperty() { return false; },
    deleteProperty() { return false; },
    get(_target, name) {
      return typeof name === "string" ? toolFunctions[name] : undefined;
    },
    getOwnPropertyDescriptor(_target, name) {
      if (typeof name !== "string" || toolFunctions[name] === undefined) return undefined;
      return { configurable: true, enumerable: true, value: toolFunctions[name], writable: false };
    },
    has(_target, name) {
      return typeof name === "string" && toolFunctions[name] !== undefined;
    },
    ownKeys() { return objectKeys(toolFunctions); },
    set() { return false; },
  });
  objectDefineProperty(globalThis, "tools", {
    configurable: false,
    enumerable: true,
    value: tools,
    writable: false,
  });

  function setToolNames(namesJson) {
    const names = jsonParse(namesJson);
    const next = objectCreate(null);
    for (const name of names) {
      objectDefineProperty(next, name, {
        configurable: false,
        enumerable: true,
        value: async function callCodeModeTool(input) {
          const inputJson = serializeJson(input, false);
          try {
            const resultJson = await nativeToolCall(name, inputJson);
            return jsonParse(resultJson);
          } catch (errorJson) {
            let error = { code: "runtime", message: "CodeMode nested tool failed" };
            if (typeof errorJson === "string") {
              try { error = jsonParse(errorJson); } catch { /* retain stable fallback */ }
            }
            throw new CodeModeToolError(error.code, error.message);
          }
        },
        writable: false,
      });
    }
    toolFunctions = objectFreeze(next);
  }

  return objectFreeze({
    formatError,
    serializeResult(value) { return serializeJson(value, true); },
    setToolNames,
  });
})()`;

type DenoByteReader = { read(buffer: Uint8Array): Promise<number | null> };
type DenoByteWriter = { write(buffer: Uint8Array): Promise<number> };
type CodeModeDenoNamespace = {
  readonly args: readonly string[];
  readonly stdin: DenoByteReader;
  readonly stdout: DenoByteWriter;
};

declare const Deno: CodeModeDenoNamespace;

type CodeModeWorkerClock = { readonly nowMs: () => number };
type CodeModeWorkerDeadline = {
  readonly interrupted: boolean;
  clear(): void;
  start(timeoutMs: number | undefined): void;
  shouldInterrupt(): boolean;
};

function createCodeModeWorkerDeadline(clock: CodeModeWorkerClock): CodeModeWorkerDeadline {
  let deadline: number | undefined;
  let interrupted = false;
  return {
    get interrupted() {
      return interrupted;
    },
    clear() {
      deadline = undefined;
      interrupted = false;
    },
    start(timeoutMs) {
      interrupted = false;
      deadline = timeoutMs === undefined ? undefined : clock.nowMs() + timeoutMs;
    },
    shouldInterrupt() {
      if (deadline === undefined || clock.nowMs() < deadline) return false;
      interrupted = true;
      return true;
    },
  };
}

type PendingGuestToolCall = {
  readonly call: CodeModeWorkerToolCall;
  readonly deferred: QuickJSDeferredPromise;
};

type ActiveWorkerCell = {
  readonly sessionId: string;
  readonly cellId: string;
  promiseHandle?: QuickJSHandle;
  readonly pendingCalls: Map<string, PendingGuestToolCall>;
  batchSequence: number;
  callSequence: number;
  outstandingBatch?: { readonly batchId: string; readonly callIds: readonly string[] };
};

type GuestBridgeHandles = {
  readonly bridge: QuickJSHandle;
  readonly formatError: QuickJSHandle;
  readonly serializeResult: QuickJSHandle;
  readonly setToolNames: QuickJSHandle;
};

type GuestErrorDescription = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
};

type GuestErrorWire = {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly stack?: unknown;
};

type InitializedGuestBridge = {
  readonly bridge: GuestBridgeHandles;
  readonly notebookRunner: QuickJSHandle;
  readonly setActiveCell: (cell: ActiveWorkerCell | undefined) => void;
};

type StartWorkerCellResult = {
  readonly cell?: ActiveWorkerCell;
  readonly response?: CodeModeWorkerResponse;
};

async function* readBoundedJsonLines(reader: DenoByteReader): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const readBuffer = new Uint8Array(CODEMODE_WORKER_READ_BUFFER_BYTES);
  let pendingText = "";
  let pendingBytes = 0;

  while (true) {
    const bytesRead = await reader.read(readBuffer);
    if (bytesRead === null) break;
    const chunk = readBuffer.subarray(0, bytesRead);
    for (const byte of chunk) {
      if (byte === 0x0a) pendingBytes = 0;
      else {
        pendingBytes += 1;
        if (pendingBytes > CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) {
          throw new Error("Pi CodeMode: worker request exceeds 8 MiB");
        }
      }
    }
    pendingText += decoder.decode(chunk, { stream: true });
    let newlineIndex = pendingText.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = pendingText.slice(0, newlineIndex);
      pendingText = pendingText.slice(newlineIndex + 1);
      if (line.length > 0) yield line;
      newlineIndex = pendingText.indexOf("\n");
    }
  }

  pendingText += decoder.decode();
  if (pendingText.length > 0) yield pendingText;
}

async function writeJsonLine(
  writer: DenoByteWriter,
  response: CodeModeWorkerResponse,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${serializeCodeModeWorkerResponse(response)}\n`);
  let written = 0;
  while (written < bytes.byteLength) written += await writer.write(bytes.subarray(written));
}

function callGuestStringFunction(
  context: QuickJSContext,
  functionHandle: QuickJSHandle,
  thisHandle: QuickJSHandle,
  argument: QuickJSHandle,
):
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly message: string } {
  const result = context.callFunction(functionHandle, thisHandle, argument);
  if (result.error !== undefined) {
    result.error.dispose();
    return { ok: false, message: "Pi CodeMode: guest bridge helper failed" };
  }
  try {
    return context.typeof(result.value) === "undefined"
      ? { ok: true }
      : { ok: true, value: context.getString(result.value) };
  } finally {
    result.value.dispose();
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- QuickJS error JSON is untrusted; this predicate establishes the guest error wire shape before field access.
function isGuestErrorWire(value: unknown): value is GuestErrorWire {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatGuestError(
  context: QuickJSContext,
  bridge: GuestBridgeHandles,
  errorHandle: QuickJSHandle,
): GuestErrorDescription {
  const formatted = callGuestStringFunction(
    context,
    bridge.formatError,
    bridge.bridge,
    errorHandle,
  );
  if (!formatted.ok || formatted.value === undefined)
    return { name: "Error", message: formatted.ok ? "CodeMode Cell rejected" : formatted.message };
  try {
    const decoded: unknown = JSON.parse(formatted.value);
    if (!isGuestErrorWire(decoded)) return { name: "Error", message: "CodeMode Cell rejected" };
    const name = typeof decoded.name === "string" ? decoded.name : "Error";
    const message =
      typeof decoded.message === "string" ? decoded.message : "CodeMode Cell rejected";
    if (typeof decoded.stack !== "string") return { name, message };
    return { name, message, stack: decoded.stack };
  } catch {
    return { name: "Error", message: "CodeMode Cell rejected" };
  }
}

function renderGuestErrorMessage(error: GuestErrorDescription): string {
  return error.stack ?? `${error.name}: ${error.message}`;
}

function evaluateTracer(
  context: QuickJSContext,
  sessionId: string,
  requestId: string,
  script: string,
): CodeModeWorkerTracerResponse {
  const evaluation = context.evalCode(script, "codemode-step-1-tracer.js");
  if (evaluation.error !== undefined) {
    const message = String(context.dump(evaluation.error));
    evaluation.error.dispose();
    return {
      version: 1,
      type: "error",
      sessionId,
      requestId,
      error: { code: "script", message },
    };
  }
  const result = context.dump(evaluation.value);
  evaluation.value.dispose();
  const resultJson = JSON.stringify(result);
  return resultJson === undefined
    ? {
        version: 1,
        type: "error",
        sessionId,
        requestId,
        error: {
          code: "serialization",
          message: "CodeMode worker result is not JSON serializable",
        },
      }
    : { version: 1, type: "result", sessionId, requestId, resultJson };
}

function initializeGuestBridge(context: QuickJSContext): InitializedGuestBridge {
  let activeCell: ActiveWorkerCell | undefined;
  const nativeToolCall = context.newFunction(
    "__piCodeModeNativeToolCall",
    (nameHandle, inputJsonHandle) => {
      if (activeCell === undefined) throw new Error("Pi CodeMode: guest tool bridge is closed");
      if (context.typeof(nameHandle) !== "string" || context.typeof(inputJsonHandle) !== "string") {
        throw new Error("Pi CodeMode: guest tool bridge received invalid arguments");
      }
      const callId = `${activeCell.cellId}:call-${++activeCell.callSequence}`;
      const deferred = context.newPromise();
      activeCell.pendingCalls.set(callId, {
        call: {
          callId,
          toolName: context.getString(nameHandle),
          inputJson: context.getString(inputJsonHandle),
        },
        deferred,
      });
      return deferred.handle;
    },
  );
  context.setProp(context.global, "__piCodeModeNativeToolCall", nativeToolCall);
  nativeToolCall.dispose();

  const bridgeEvaluation = context.evalCode(
    CODEMODE_GUEST_BRIDGE_BOOTSTRAP_SOURCE,
    "codemode-guest-bridge.js",
  );
  if (bridgeEvaluation.error !== undefined) {
    const message = String(context.dump(bridgeEvaluation.error));
    bridgeEvaluation.error.dispose();
    throw new Error(`Pi CodeMode: guest bridge bootstrap failed: ${message}`);
  }
  const bridgeHandle = bridgeEvaluation.value;
  const formatError = context.getProp(bridgeHandle, "formatError");
  const serializeResult = context.getProp(bridgeHandle, "serializeResult");
  const setToolNames = context.getProp(bridgeHandle, "setToolNames");

  const notebookEvaluation = context.evalCode(
    CODEMODE_NOTEBOOK_BOOTSTRAP_SOURCE,
    "codemode-notebook-bootstrap.js",
  );
  if (notebookEvaluation.error !== undefined) {
    const message = String(context.dump(notebookEvaluation.error));
    notebookEvaluation.error.dispose();
    bridgeHandle.dispose();
    formatError.dispose();
    serializeResult.dispose();
    setToolNames.dispose();
    throw new Error(`Pi CodeMode: Notebook bootstrap failed: ${message}`);
  }

  return {
    bridge: { bridge: bridgeHandle, formatError, serializeResult, setToolNames },
    notebookRunner: notebookEvaluation.value,
    setActiveCell: (cell) => {
      activeCell = cell;
    },
  };
}

function executePendingGuestJobs(runtime: QuickJSRuntime): QuickJSHandle | undefined {
  const jobs = runtime.executePendingJobs();
  if (jobs.error !== undefined) return jobs.error;
  return undefined;
}

function settleGuestToolCalls(
  context: QuickJSContext,
  activeCell: ActiveWorkerCell,
  results: readonly CodeModeWorkerToolSettlement[],
): string | undefined {
  const batch = activeCell.outstandingBatch;
  if (batch === undefined)
    return "Pi CodeMode: worker received tool results without an outstanding batch";
  if (results.length !== batch.callIds.length)
    return "Pi CodeMode: worker received an incomplete tool result batch";
  const expected = new Set(batch.callIds);
  for (const result of results) {
    if (!expected.delete(result.callId))
      return "Pi CodeMode: worker received an unexpected tool result";
    const pending = activeCell.pendingCalls.get(result.callId);
    if (pending === undefined) return "Pi CodeMode: worker lost a guest tool deferred";
    const payload = result.outcome === "success" ? result.resultJson : JSON.stringify(result.error);
    const payloadHandle = context.newString(payload);
    try {
      if (result.outcome === "success") pending.deferred.resolve(payloadHandle);
      else pending.deferred.reject(payloadHandle);
    } finally {
      payloadHandle.dispose();
      pending.deferred.dispose();
      activeCell.pendingCalls.delete(result.callId);
    }
  }
  delete activeCell.outstandingBatch;
  return undefined;
}

function takeNextGuestToolBatch(activeCell: ActiveWorkerCell): CodeModeWorkerResponse | undefined {
  if (activeCell.outstandingBatch !== undefined || activeCell.pendingCalls.size === 0)
    return undefined;
  const calls = [...activeCell.pendingCalls.values()].map((entry) => entry.call);
  const batchId = `${activeCell.cellId}:batch-${++activeCell.batchSequence}`;
  const response: CodeModeWorkerResponse = {
    version: 1,
    type: "tool-batch",
    sessionId: activeCell.sessionId,
    cellId: activeCell.cellId,
    batchId,
    calls,
  };
  if (
    new TextEncoder().encode(JSON.stringify(response)).byteLength >
    CODEMODE_WORKER_MESSAGE_LIMIT_BYTES
  ) {
    return {
      version: 1,
      type: "cell-error",
      sessionId: activeCell.sessionId,
      cellId: activeCell.cellId,
      error: { code: "serialization", message: "CodeMode nested tool batch exceeds 8 MiB" },
    };
  }
  activeCell.outstandingBatch = { batchId, callIds: calls.map((call) => call.callId) };
  return response;
}

function inspectActiveCell(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  bridge: GuestBridgeHandles,
  activeCell: ActiveWorkerCell,
  interrupted: boolean,
): CodeModeWorkerResponse | undefined {
  const jobError = executePendingGuestJobs(runtime);
  if (jobError !== undefined) {
    const guestError = formatGuestError(context, bridge, jobError);
    jobError.dispose();
    return {
      version: 1,
      type: "cell-error",
      sessionId: activeCell.sessionId,
      cellId: activeCell.cellId,
      error: {
        code: interrupted ? "timeout" : "runtime",
        message: interrupted
          ? "CodeMode Cell exceeded its timeout"
          : renderGuestErrorMessage(guestError),
      },
    };
  }

  const batch = takeNextGuestToolBatch(activeCell);
  if (batch !== undefined) return batch;
  if (activeCell.pendingCalls.size > 0) return undefined;

  if (activeCell.promiseHandle === undefined) {
    return {
      version: 1,
      type: "cell-error",
      sessionId: activeCell.sessionId,
      cellId: activeCell.cellId,
      error: { code: "runtime", message: "Pi CodeMode: active Cell has no guest promise" },
    };
  }
  const state = context.getPromiseState(activeCell.promiseHandle);
  if (state.type === "pending") return undefined;
  if (state.type === "rejected") {
    const guestError = formatGuestError(context, bridge, state.error);
    state.error.dispose();
    const code: CodeModeWorkerCellErrorCode = interrupted
      ? "timeout"
      : guestError.name === "CodeModeSerializationError"
        ? "serialization"
        : "script";
    return {
      version: 1,
      type: "cell-error",
      sessionId: activeCell.sessionId,
      cellId: activeCell.cellId,
      error: {
        code,
        message: interrupted
          ? "CodeMode Cell exceeded its timeout"
          : renderGuestErrorMessage(guestError),
      },
    };
  }

  const serialized = callGuestStringFunction(
    context,
    bridge.serializeResult,
    bridge.bridge,
    state.value,
  );
  state.value.dispose();
  if (!serialized.ok) {
    return {
      version: 1,
      type: "cell-error",
      sessionId: activeCell.sessionId,
      cellId: activeCell.cellId,
      error: { code: "serialization", message: serialized.message },
    };
  }
  const response = {
    version: 1,
    type: "cell-result",
    sessionId: activeCell.sessionId,
    cellId: activeCell.cellId,
  } as const;
  return serialized.value === undefined ? response : { ...response, resultJson: serialized.value };
}

function startWorkerCell(
  context: QuickJSContext,
  bridge: GuestBridgeHandles,
  notebookRunner: QuickJSHandle,
  request: Extract<CodeModeWorkerRequest, { readonly type: "execute" }>,
  setActiveCell: (cell: ActiveWorkerCell | undefined) => void,
): StartWorkerCellResult {
  const namesHandle = context.newString(JSON.stringify(request.toolNames));
  const setNamesResult = context.callFunction(bridge.setToolNames, bridge.bridge, namesHandle);
  namesHandle.dispose();
  if (setNamesResult.error !== undefined) {
    const guestError = formatGuestError(context, bridge, setNamesResult.error);
    setNamesResult.error.dispose();
    return {
      response: {
        version: 1,
        type: "cell-error",
        sessionId: request.sessionId,
        cellId: request.cellId,
        error: { code: "runtime", message: renderGuestErrorMessage(guestError) },
      },
    };
  }
  setNamesResult.value.dispose();

  const cell: ActiveWorkerCell = {
    sessionId: request.sessionId,
    cellId: request.cellId,
    pendingCalls: new Map(),
    batchSequence: 0,
    callSequence: 0,
  };
  setActiveCell(cell);
  const sourceHandle = context.newString(request.source);
  const identifierHandle = context.newString(request.internalIdentifierPlaceholder);
  const execution = context.callFunction(
    notebookRunner,
    context.undefined,
    sourceHandle,
    identifierHandle,
  );
  sourceHandle.dispose();
  identifierHandle.dispose();
  if (execution.error !== undefined) {
    const guestError = formatGuestError(context, bridge, execution.error);
    execution.error.dispose();
    for (const pending of cell.pendingCalls.values()) pending.deferred.dispose();
    setActiveCell(undefined);
    return {
      response: {
        version: 1,
        type: "cell-error",
        sessionId: request.sessionId,
        cellId: request.cellId,
        error: { code: "script", message: renderGuestErrorMessage(guestError) },
      },
    };
  }
  cell.promiseHandle = execution.value;
  return { cell };
}

function inspectQuickJsMemory(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
): CodeModeWorkerMemoryUsage {
  const memory = runtime.computeMemoryUsage();
  const mallocCount = context.getProp(memory, "malloc_count");
  const memoryUsedBytes = context.getProp(memory, "memory_used_size");
  const objectCount = context.getProp(memory, "obj_count");
  try {
    return {
      mallocCount: context.getNumber(mallocCount),
      memoryUsedBytes: context.getNumber(memoryUsedBytes),
      objectCount: context.getNumber(objectCount),
    };
  } finally {
    objectCount.dispose();
    memoryUsedBytes.dispose();
    mallocCount.dispose();
    memory.dispose();
  }
}

const workerSessionId = Deno.args[1];
if (workerSessionId === undefined || workerSessionId.length === 0) {
  throw new Error("Pi CodeMode: worker requires a non-empty Session ID");
}
const debugMemoryEnabled = Deno.args[0] === "debug";
const workerRuntime = {
  nowMs: Date.now.bind(Date),
};
const quickJsVariant = debugMemoryEnabled ? DEBUG_SYNC : RELEASE_SYNC;
const quickJs = await newQuickJSWASMModule(quickJsVariant);
const runtime = quickJs.newRuntime();
runtime.setMemoryLimit(QUICKJS_HEAP_LIMIT_BYTES);
runtime.setMaxStackSize(QUICKJS_STACK_LIMIT_BYTES);
const workerDeadline = createCodeModeWorkerDeadline(workerRuntime);
runtime.setInterruptHandler(() => workerDeadline.shouldInterrupt());
const context = runtime.newContext();
const initialized = initializeGuestBridge(context);
let activeCell: ActiveWorkerCell | undefined;

try {
  await writeJsonLine(Deno.stdout, {
    version: 1,
    type: "ready",
    sessionId: workerSessionId,
  });
  for await (const message of readBoundedJsonLines(Deno.stdin)) {
    const parsed = parseCodeModeWorkerRequest(message);
    if (!parsed.ok) {
      await writeJsonLine(Deno.stdout, {
        version: 1,
        type: "protocol-error",
        sessionId: workerSessionId,
        message: parsed.message,
      });
      break;
    }
    const request = parsed.value;
    if (request.sessionId !== workerSessionId) {
      await writeJsonLine(Deno.stdout, {
        version: 1,
        type: "protocol-error",
        sessionId: workerSessionId,
        message: "Pi CodeMode: worker received a stale Session ID",
      });
      break;
    }
    if (request.type === "shutdown") {
      if (activeCell !== undefined) {
        await writeJsonLine(Deno.stdout, {
          version: 1,
          type: "protocol-error",
          sessionId: workerSessionId,
          message: "Pi CodeMode: cannot gracefully shut down an active Cell",
        });
      }
      break;
    }
    if (request.type === "evaluate") {
      if (activeCell !== undefined) {
        await writeJsonLine(Deno.stdout, {
          version: 1,
          type: "error",
          sessionId: workerSessionId,
          requestId: request.requestId,
          error: { code: "busy", message: "CodeMode worker is busy" },
        });
      } else {
        await writeJsonLine(
          Deno.stdout,
          evaluateTracer(context, workerSessionId, request.requestId, request.script),
        );
      }
      continue;
    }
    if (request.type === "debug-memory") {
      if (activeCell !== undefined || !debugMemoryEnabled) {
        await writeJsonLine(Deno.stdout, {
          version: 1,
          type: "error",
          sessionId: workerSessionId,
          requestId: request.requestId,
          error: {
            code: activeCell === undefined ? "unavailable" : "busy",
            message:
              activeCell === undefined
                ? "CodeMode debug memory is unavailable in the release worker"
                : "CodeMode worker is busy",
          },
        });
      } else {
        await writeJsonLine(Deno.stdout, {
          version: 1,
          type: "debug-memory",
          sessionId: workerSessionId,
          requestId: request.requestId,
          memory: inspectQuickJsMemory(context, runtime),
        });
      }
      continue;
    }
    if (request.type === "execute") {
      if (activeCell !== undefined) {
        await writeJsonLine(Deno.stdout, {
          version: 1,
          type: "protocol-error",
          sessionId: workerSessionId,
          message: "Pi CodeMode: worker received overlapping Cells",
        });
        break;
      }
      workerDeadline.start(request.timeoutMs);
      const started = startWorkerCell(
        context,
        initialized.bridge,
        initialized.notebookRunner,
        request,
        initialized.setActiveCell,
      );
      if (started.response !== undefined) {
        const interrupted = workerDeadline.interrupted;
        workerDeadline.clear();
        await writeJsonLine(
          Deno.stdout,
          interrupted
            ? {
                version: 1,
                type: "cell-error",
                sessionId: workerSessionId,
                cellId: request.cellId,
                error: { code: "timeout", message: "CodeMode Cell exceeded its timeout" },
              }
            : started.response,
        );
        continue;
      }
      activeCell = started.cell;
      initialized.setActiveCell(activeCell);
    } else {
      if (
        activeCell === undefined ||
        request.cellId !== activeCell.cellId ||
        request.batchId !== activeCell.outstandingBatch?.batchId
      ) {
        await writeJsonLine(Deno.stdout, {
          version: 1,
          type: "protocol-error",
          sessionId: workerSessionId,
          message: "Pi CodeMode: worker received stale tool results",
        });
        break;
      }
      const settlementError = settleGuestToolCalls(context, activeCell, request.results);
      if (settlementError !== undefined) {
        await writeJsonLine(Deno.stdout, {
          version: 1,
          type: "protocol-error",
          sessionId: workerSessionId,
          message: settlementError,
        });
        break;
      }
    }

    if (activeCell === undefined) continue;
    const response = inspectActiveCell(
      context,
      runtime,
      initialized.bridge,
      activeCell,
      workerDeadline.interrupted,
    );
    if (response === undefined) continue;
    await writeJsonLine(Deno.stdout, response);
    if (response.type === "cell-result" || response.type === "cell-error") {
      for (const pending of activeCell.pendingCalls.values()) pending.deferred.dispose();
      activeCell.promiseHandle?.dispose();
      activeCell = undefined;
      initialized.setActiveCell(undefined);
      workerDeadline.clear();
    }
  }
} finally {
  if (activeCell !== undefined) {
    for (const pending of activeCell.pendingCalls.values()) pending.deferred.dispose();
    activeCell.promiseHandle?.dispose();
  }
  initialized.setActiveCell(undefined);
  initialized.notebookRunner.dispose();
  initialized.bridge.setToolNames.dispose();
  initialized.bridge.serializeResult.dispose();
  initialized.bridge.formatError.dispose();
  initialized.bridge.bridge.dispose();
  context.dispose();
  runtime.dispose();
}
