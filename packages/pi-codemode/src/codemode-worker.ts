/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- This Deno entrypoint is the guest-value boundary: it refines unknown Cell values into bounded JSON before any process message. */
import {
  CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
  parseCodeModeWorkerRequest,
  serializeCodeModeWorkerResponse,
  type CodeModeWorkerRequest,
  type CodeModeWorkerResponse,
  type CodeModeWorkerToolCall,
  type CodeModeWorkerToolSettlement,
} from "./codemode-worker-protocol.ts";

const CODEMODE_WORKER_READ_BUFFER_BYTES = 64 * 1024;

type DenoByteReader = { read(buffer: Uint8Array): Promise<number | null> };
type DenoByteWriter = { write(buffer: Uint8Array): Promise<number> };
type CodeModeDenoNamespace = {
  readonly args: readonly string[];
  readonly stdin: DenoByteReader;
  readonly stdout: DenoByteWriter;
  readonly version: {
    readonly deno: string;
    readonly v8: string;
    readonly typescript: string;
  };
};

declare const Deno: CodeModeDenoNamespace;

const denoProcess = Deno;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const blobConstructor = Blob;
const createObject = Object.create;
const defineProperty = Object.defineProperty;
const deleteProperty = Reflect.deleteProperty;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const errorConstructor = Error;
const typeErrorConstructor = TypeError;
const referenceErrorConstructor = ReferenceError;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const numberFrom = Number;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const objectFreeze = Object.freeze;
const objectPrototype = Object.prototype;
const ownKeys = Reflect.ownKeys;
const queueRuntimeMicrotask = queueMicrotask.bind(globalThis);
const createPromiseWithResolvers = Promise.withResolvers.bind(Promise);
const promisePrototype = Promise.prototype;
const randomUuid = crypto.randomUUID.bind(crypto);
// oxlint-disable-next-line typescript/unbound-method -- Capturing this primordial before guest execution prevents a Cell from replacing it.
const replaceAllStringPrimordial = String.prototype.replaceAll;
const stringPrototype = String.prototype;
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply does not use this; capture prevents guest replacement.
const applyFunction = Reflect.apply;
function replaceAllString(value: string, searchValue: string, replaceValue: string): string {
  return applyFunction(replaceAllStringPrimordial, value, [searchValue, replaceValue]);
}
const stringFrom = String;
const textDecoderConstructor = TextDecoder;
const textDecoderPrototype = TextDecoder.prototype;
const uint8ArrayConstructor = Uint8Array;
const uint8ArrayPrototype = Uint8Array.prototype;
const textEncoder = new TextEncoder();
const encodeUtf8 = textEncoder.encode.bind(textEncoder);
const createBlobUrl = URL.createObjectURL.bind(URL);
const revokeBlobUrl = URL.revokeObjectURL.bind(URL);
const serializationErrorInstances = new WeakSet<object>();
const addSerializationErrorInstance = serializationErrorInstances.add.bind(
  serializationErrorInstances,
);
const hasSerializationErrorInstance = serializationErrorInstances.has.bind(
  serializationErrorInstances,
);
const toolErrorCodes = new WeakMap<object, string>();
const getToolErrorCode = toolErrorCodes.get.bind(toolErrorCodes);
const setToolErrorCode = toolErrorCodes.set.bind(toolErrorCodes);

class CodeModeSerializationError extends Error {
  override readonly name = "CodeModeSerializationError";

  constructor(message: string) {
    super(message);
    addSerializationErrorInstance(this);
  }
}

class CodeModeToolError extends Error {
  override readonly name = "CodeModeToolError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function createCodeModeToolError(code: string, message: string): CodeModeToolError {
  const error = new CodeModeToolError(code, message);
  setToolErrorCode(error, code);
  return error;
}

function internalToolErrorCode(error: unknown): string | undefined {
  return (typeof error === "object" && error !== null) || typeof error === "function"
    ? getToolErrorCode(error)
    : undefined;
}

type CodeModeNotebookBindingKind = "var" | "let" | "const" | "function" | "class";
type CodeModeNotebookBinding = {
  readonly name: string;
  kind: CodeModeNotebookBindingKind;
  value: unknown;
};
type CodeModeNotebookStage = {
  readonly name: string;
  readonly kind: CodeModeNotebookBindingKind;
  readonly priorDescriptor?: PropertyDescriptor;
  readonly temporaryProperty: boolean;
  initialized: boolean;
  value: unknown;
};
type CodeModeNotebookDeclarationHelper = {
  readonly init: object;
  complete(value: unknown): void;
  declare(
    entries: readonly (readonly [string, CodeModeNotebookBindingKind])[],
    initialize: () => Promise<void>,
  ): Promise<void>;
  fail(cause: unknown): void;
  hoistVars(names: readonly string[]): void;
};

type PendingGuestToolCall = {
  readonly call: CodeModeWorkerToolCall;
  readonly promise: Promise<string>;
  readonly resolve: (value: string) => void;
  readonly reject: (error: CodeModeToolError) => void;
  sent: boolean;
};

type ActiveWorkerCell = {
  readonly sessionId: string;
  readonly cellId: string;
  readonly pendingCalls: PendingGuestToolCall[];
  batchSequence: number;
  callSequence: number;
  batchScheduled: boolean;
  finishScheduled: boolean;
  mainFailed: boolean;
  mainSettled: boolean;
  mainResult?: unknown;
  mainError?: unknown;
  outstandingBatch?: { readonly batchId: string; readonly callIds: readonly string[] };
};

type GuestErrorDescription = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
};

const RESERVED_NOTEBOOK_BINDING_NAMES = [
  "tools",
  "CodeModeToolError",
  "Deno",
  "process",
  "console",
  "Worker",
  "close",
  "globalThis",
  "global",
  "self",
  "window",
  "WebAssembly",
  "ShadowRealm",
] as const;
const notebookBindings: CodeModeNotebookBinding[] = [];
let activeNotebookStage: CodeModeNotebookStage[] | undefined;
let activeCell: ActiveWorkerCell | undefined;
let responseWrites = Promise.resolve();
let toolNames: string[] = [];
let toolFunctions = objectFreeze(createObject(null));

function isReservedNotebookBindingName(name: string): boolean {
  if (name.startsWith("__piCodeModeRuntimeKey_")) return true;
  for (const reserved of RESERVED_NOTEBOOK_BINDING_NAMES) {
    if (name === reserved) return true;
  }
  return false;
}

function assertNotebookBindingNameAvailable(name: string): void {
  if (isReservedNotebookBindingName(name)) {
    throw new typeErrorConstructor(`CodeMode Notebook Binding '${name}' is reserved`);
  }
}

function findNotebookBinding(name: string): CodeModeNotebookBinding | undefined {
  for (const binding of notebookBindings) {
    if (binding.name === name) return binding;
  }
  return undefined;
}

function findNotebookStage(name: string): CodeModeNotebookStage | undefined {
  const stage = activeNotebookStage;
  if (stage === undefined) return undefined;
  for (const binding of stage) {
    if (binding.name === name) return binding;
  }
  return undefined;
}

function defineNotebookBindingProperty(name: string, configurable: boolean): void {
  defineProperty(globalThis, name, {
    configurable,
    enumerable: false,
    get() {
      const staged = findNotebookStage(name);
      if (staged !== undefined) {
        if (!staged.initialized) {
          throw new referenceErrorConstructor(`Cannot access '${name}' before initialization`);
        }
        return staged.value;
      }
      return findNotebookBinding(name)?.value;
    },
    set(value: unknown) {
      const staged = findNotebookStage(name);
      if (staged !== undefined) {
        if (!staged.initialized) {
          throw new referenceErrorConstructor(`Cannot access '${name}' before initialization`);
        }
        if (staged.kind === "const") {
          throw new typeErrorConstructor(`Assignment to constant Notebook Binding '${name}'`);
        }
        staged.value = value;
        return;
      }
      const binding = findNotebookBinding(name);
      if (binding === undefined) {
        throw new referenceErrorConstructor(`${name} is not defined`);
      }
      if (binding.kind === "const") {
        throw new typeErrorConstructor(`Assignment to constant Notebook Binding '${name}'`);
      }
      binding.value = value;
    },
  });
}

function restoreNotebookStageProperties(stage: readonly CodeModeNotebookStage[]): void {
  for (const staged of stage) {
    if (!staged.temporaryProperty) continue;
    if (staged.priorDescriptor === undefined) deleteProperty(globalThis, staged.name);
    else defineProperty(globalThis, staged.name, staged.priorDescriptor);
  }
}

function commitNotebookStage(stage: readonly CodeModeNotebookStage[]): void {
  for (const staged of stage) {
    const existing = findNotebookBinding(staged.name);
    if (existing === undefined) {
      notebookBindings[notebookBindings.length] = {
        name: staged.name,
        kind: staged.kind,
        value: staged.value,
      };
      if (staged.temporaryProperty) defineNotebookBindingProperty(staged.name, false);
    } else {
      existing.kind = staged.kind;
      existing.value = staged.value;
    }
  }
}

const notebookInitializationTarget = new Proxy(createObject(null), {
  set(_target, name, value) {
    if (typeof name !== "string" || activeNotebookStage === undefined) {
      throw new errorConstructor("Pi CodeMode: declaration initialization outside an active stage");
    }
    const staged = findNotebookStage(name);
    if (staged === undefined) {
      throw new errorConstructor(
        "Pi CodeMode: declaration initialized an unplanned Notebook Binding",
      );
    }
    staged.initialized = true;
    staged.value = value;
    return true;
  },
});

const notebookDeclarationHelper: CodeModeNotebookDeclarationHelper = objectFreeze({
  init: notebookInitializationTarget,
  complete(value) {
    const cell = activeCell;
    if (cell === undefined) {
      throw new errorConstructor("Pi CodeMode: Cell completed without an active worker Cell");
    }
    cell.mainResult = value;
    cell.mainSettled = true;
  },
  async declare(entries, initialize) {
    if (activeNotebookStage !== undefined) {
      throw new errorConstructor("Pi CodeMode: overlapping declaration stages");
    }
    const stage: CodeModeNotebookStage[] = [];
    activeNotebookStage = stage;
    try {
      for (const [name, kind] of entries) {
        assertNotebookBindingNameAvailable(name);
        const existing = findNotebookBinding(name);
        const priorDescriptor = getOwnPropertyDescriptor(globalThis, name);
        const temporaryProperty = existing === undefined;
        const stagedBase = {
          name,
          kind,
          temporaryProperty,
          initialized: kind === "var",
          value: kind === "var" ? existing?.value : undefined,
        } as const;
        stage[stage.length] =
          priorDescriptor === undefined ? stagedBase : { ...stagedBase, priorDescriptor };
        if (temporaryProperty) defineNotebookBindingProperty(name, true);
      }
      await initialize();
      for (const staged of stage) {
        if (!staged.initialized) {
          throw new errorConstructor(
            "Pi CodeMode: declaration did not initialize its Notebook Binding",
          );
        }
      }
      commitNotebookStage(stage);
    } catch (cause) {
      restoreNotebookStageProperties(stage);
      throw cause;
    } finally {
      activeNotebookStage = undefined;
    }
  },
  fail(cause) {
    const cell = activeCell;
    if (cell === undefined) {
      throw new errorConstructor("Pi CodeMode: Cell failed without an active worker Cell");
    }
    cell.mainError = cause;
    cell.mainFailed = true;
    cell.mainSettled = true;
  },
  hoistVars(names) {
    if (activeNotebookStage !== undefined) {
      throw new errorConstructor(
        "Pi CodeMode: variable hoisting during an active declaration stage",
      );
    }
    for (const name of names) {
      assertNotebookBindingNameAvailable(name);
      const existing = findNotebookBinding(name);
      if (existing !== undefined) {
        existing.kind = "var";
        continue;
      }
      const priorDescriptor = getOwnPropertyDescriptor(globalThis, name);
      try {
        defineNotebookBindingProperty(name, true);
        notebookBindings[notebookBindings.length] = { name, kind: "var", value: undefined };
        defineNotebookBindingProperty(name, false);
      } catch (cause) {
        if (priorDescriptor === undefined) deleteProperty(globalThis, name);
        else defineProperty(globalThis, name, priorDescriptor);
        throw cause;
      }
    }
  },
});

function utf8ByteLength(value: string): number {
  return encodeUtf8(value).byteLength;
}

function serializeGuestJson(value: unknown, allowUndefined: boolean): string | undefined {
  const seen: object[] = [];
  const inspect = (candidate: unknown, path: string): unknown => {
    if (candidate === null) return null;
    if (candidate === undefined) {
      if (path === "$" && allowUndefined) return undefined;
      throw new CodeModeSerializationError(
        `CodeMode serialization failed: ${path} must be JSON data`,
      );
    }
    const type = typeof candidate;
    if (type === "boolean" || type === "string") return candidate;
    if (type === "number") {
      if (!numberIsFinite(candidate)) {
        throw new CodeModeSerializationError(
          `CodeMode serialization failed: ${path} must be finite`,
        );
      }
      return candidate;
    }
    if (type !== "object") {
      throw new CodeModeSerializationError(
        `CodeMode serialization failed: ${path} is not JSON data`,
      );
    }
    for (const prior of seen) {
      if (prior === candidate)
        throw new CodeModeSerializationError(`CodeMode serialization failed: ${path} is cyclic`);
    }
    seen[seen.length] = candidate;
    try {
      if (arrayIsArray(candidate)) {
        const output: unknown[] = [];
        for (const key of ownKeys(candidate)) {
          if (key === "length") continue;
          if (typeof key !== "string") {
            throw new CodeModeSerializationError(
              `CodeMode serialization failed: ${path} has a symbol property`,
            );
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
            throw new CodeModeSerializationError(
              `CodeMode serialization failed: ${path}.${key} is not a JSON array index`,
            );
          }
        }
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = getOwnPropertyDescriptor(candidate, stringFrom(index));
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new CodeModeSerializationError(
              `CodeMode serialization failed: ${path}[${index}] is sparse or accessor-backed`,
            );
          }
          output[output.length] = inspect(descriptor.value, `${path}[${index}]`);
        }
        return output;
      }
      const prototype = getPrototypeOf(candidate);
      if (prototype !== objectPrototype && prototype !== null) {
        throw new CodeModeSerializationError(
          `CodeMode serialization failed: ${path} must be a plain object`,
        );
      }
      const output = createObject(null);
      for (const key of ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw new CodeModeSerializationError(
            `CodeMode serialization failed: ${path} has a symbol property`,
          );
        }
        const descriptor = getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new CodeModeSerializationError(
            `CodeMode serialization failed: ${path}.${key} is non-enumerable or accessor-backed`,
          );
        }
        defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: inspect(descriptor.value, `${path}.${key}`),
          writable: true,
        });
      }
      return output;
    } finally {
      seen.length -= 1;
    }
  };

  const inspected = inspect(value, "$");
  if (inspected === undefined) return undefined;
  const json = jsonStringify(inspected);
  if (utf8ByteLength(json) > CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) {
    throw new CodeModeSerializationError("CodeMode serialization failed: JSON exceeds 8 MiB");
  }
  return json;
}

function describeGuestError(error: unknown): GuestErrorDescription {
  if (typeof error === "string") return { name: "Error", message: error };
  if (error === null) return { name: "Error", message: "null" };
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "undefined"
  ) {
    return { name: "Error", message: stringFrom(error) };
  }
  if (typeof error === "symbol") return { name: "Error", message: "Symbol" };
  try {
    const nameDescriptor = getOwnPropertyDescriptor(error, "name");
    const messageDescriptor = getOwnPropertyDescriptor(error, "message");
    const stackDescriptor = getOwnPropertyDescriptor(error, "stack");
    const name =
      nameDescriptor !== undefined &&
      "value" in nameDescriptor &&
      typeof nameDescriptor.value === "string"
        ? nameDescriptor.value
        : "Error";
    const message =
      messageDescriptor !== undefined &&
      "value" in messageDescriptor &&
      typeof messageDescriptor.value === "string"
        ? messageDescriptor.value
        : "CodeMode Cell rejected";
    if (
      stackDescriptor === undefined ||
      !("value" in stackDescriptor) ||
      typeof stackDescriptor.value !== "string"
    ) {
      return { name, message };
    }
    return { name, message, stack: stackDescriptor.value };
  } catch {
    return { name: "Error", message: "CodeMode Cell threw an unreadable value" };
  }
}

function renderGuestError(error: GuestErrorDescription): string {
  return error.stack ?? `${error.name}: ${error.message}`;
}

async function* readBoundedJsonLines(reader: DenoByteReader): AsyncGenerator<string> {
  const decoder = new textDecoderConstructor("utf-8", { fatal: true });
  const readBuffer = new uint8ArrayConstructor(CODEMODE_WORKER_READ_BUFFER_BYTES);
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
          throw new errorConstructor("Pi CodeMode: worker request exceeds 8 MiB");
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
  const bytes = encodeUtf8(`${serializeCodeModeWorkerResponse(response)}\n`);
  let written = 0;
  while (written < bytes.byteLength) written += await writer.write(bytes.subarray(written));
}

async function writeWorkerResponseAfter(
  priorWrite: Promise<void>,
  response: CodeModeWorkerResponse,
): Promise<void> {
  await priorWrite;
  await writeJsonLine(denoProcess.stdout, response);
}

function enqueueWorkerResponse(response: CodeModeWorkerResponse): Promise<void> {
  const next = writeWorkerResponseAfter(responseWrites, response);
  responseWrites = next;
  return next;
}

function copyToolNames(): string[] {
  const names: string[] = [];
  for (const name of toolNames) names[names.length] = name;
  return names;
}

async function nativeToolCall(name: string, input: unknown): Promise<unknown> {
  const cell = activeCell;
  if (cell === undefined) {
    throw createCodeModeToolError("runtime", "CodeMode Cell tool bridge is closed");
  }
  let inputJson: string;
  try {
    const serialized = serializeGuestJson(input, false);
    if (serialized === undefined) {
      throw createCodeModeToolError("serialization", "CodeMode tool input must be JSON data");
    }
    inputJson = serialized;
  } catch (cause) {
    if (internalToolErrorCode(cause) !== undefined) throw cause;
    const error = describeGuestError(cause);
    throw createCodeModeToolError("serialization", error.message);
  }

  const deferred = createPromiseWithResolvers<string>();
  const callId = `${cell.cellId}:call-${++cell.callSequence}`;
  const pending: PendingGuestToolCall = {
    call: { callId, toolName: name, inputJson },
    promise: deferred.promise,
    resolve: deferred.resolve,
    reject: deferred.reject,
    sent: false,
  };
  cell.pendingCalls[cell.pendingCalls.length] = pending;
  scheduleToolBatch(cell);
  return jsonParse(await pending.promise);
}

function setToolNames(names: readonly string[]): void {
  const nextNames: string[] = [];
  const nextFunctions = createObject(null);
  for (const name of names) {
    nextNames[nextNames.length] = name;
    defineProperty(nextFunctions, name, {
      configurable: false,
      enumerable: true,
      value: (input: unknown) => nativeToolCall(name, input),
      writable: false,
    });
  }
  toolNames = nextNames;
  toolFunctions = objectFreeze(nextFunctions);
}

const tools = new Proxy(createObject(null), {
  defineProperty() {
    return false;
  },
  deleteProperty() {
    return false;
  },
  get(_target, name) {
    return typeof name === "string"
      ? getOwnPropertyDescriptor(toolFunctions, name)?.value
      : undefined;
  },
  getOwnPropertyDescriptor(_target, name) {
    if (typeof name !== "string") return undefined;
    const value = getOwnPropertyDescriptor(toolFunctions, name)?.value;
    return value === undefined
      ? undefined
      : { configurable: true, enumerable: true, value, writable: false };
  },
  has(_target, name) {
    return typeof name === "string" && getOwnPropertyDescriptor(toolFunctions, name) !== undefined;
  },
  ownKeys() {
    return copyToolNames();
  },
  set() {
    return false;
  },
});

defineProperty(globalThis, "CodeModeToolError", {
  configurable: false,
  enumerable: false,
  value: CodeModeToolError,
  writable: false,
});
defineProperty(globalThis, "tools", {
  configurable: false,
  enumerable: true,
  value: tools,
  writable: false,
});

function disableGuestGlobal(name: string, value?: unknown): void {
  const descriptor = getOwnPropertyDescriptor(globalThis, name);
  if (descriptor?.configurable === false) return;
  defineProperty(globalThis, name, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

const ordinaryFunctionPrototype = Function.prototype;
const asyncFunctionPrototype = getPrototypeOf(async function codeModeAsyncFunction() {});
const generatorFunctionPrototype = getPrototypeOf(function* codeModeGeneratorFunction() {});
const asyncGeneratorFunctionPrototype = getPrototypeOf(
  async function* codeModeAsyncGeneratorFunction() {},
);
for (const functionPrototype of [
  ordinaryFunctionPrototype,
  asyncFunctionPrototype,
  generatorFunctionPrototype,
  asyncGeneratorFunctionPrototype,
]) {
  defineProperty(functionPrototype, "constructor", {
    configurable: false,
    enumerable: false,
    value: undefined,
    writable: false,
  });
}
for (const runtimePrototype of [
  arrayPrototype,
  stringPrototype,
  promisePrototype,
  textDecoderPrototype,
  uint8ArrayPrototype,
  ordinaryFunctionPrototype,
  asyncFunctionPrototype,
  generatorFunctionPrototype,
  asyncGeneratorFunctionPrototype,
]) {
  objectFreeze(runtimePrototype);
}

const safeDenoIdentity = objectFreeze({
  version: objectFreeze({
    deno: denoProcess.version.deno,
    typescript: denoProcess.version.typescript,
    v8: denoProcess.version.v8,
  }),
});
disableGuestGlobal("Deno", safeDenoIdentity);
for (const unsafeGlobal of [
  "process",
  "console",
  "alert",
  "confirm",
  "prompt",
  "eval",
  "Function",
  "Worker",
  "close",
  "fetch",
  "WebSocket",
  "EventSource",
  "WebAssembly",
  "ShadowRealm",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
]) {
  disableGuestGlobal(unsafeGlobal);
}

function scheduleToolBatch(cell: ActiveWorkerCell): void {
  if (
    activeCell !== cell ||
    cell.batchScheduled ||
    cell.outstandingBatch !== undefined ||
    !cell.pendingCalls.some((pending) => !pending.sent)
  ) {
    return;
  }
  cell.batchScheduled = true;
  queueRuntimeMicrotask(() => {
    cell.batchScheduled = false;
    if (activeCell !== cell || cell.outstandingBatch !== undefined) return;
    const pendingBatch = cell.pendingCalls.filter((pending) => !pending.sent);
    if (pendingBatch.length === 0) {
      scheduleCellFinish(cell);
      return;
    }
    const calls = pendingBatch.map((pending) => pending.call);
    const batchId = `${cell.cellId}:batch-${++cell.batchSequence}`;
    const response: CodeModeWorkerResponse = {
      version: 1,
      type: "tool-batch",
      sessionId: cell.sessionId,
      cellId: cell.cellId,
      batchId,
      calls,
    };
    if (utf8ByteLength(jsonStringify(response)) > CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) {
      for (const pending of pendingBatch) {
        pending.reject(
          createCodeModeToolError("serialization", "CodeMode nested tool batch exceeds 8 MiB"),
        );
        removePendingCall(cell, pending.call.callId);
      }
      scheduleCellFinish(cell);
      return;
    }
    for (const pending of pendingBatch) pending.sent = true;
    cell.outstandingBatch = { batchId, callIds: calls.map((call) => call.callId) };
    void enqueueWorkerResponse(response);
  });
}

function removePendingCall(cell: ActiveWorkerCell, callId: string): void {
  const retained: PendingGuestToolCall[] = [];
  for (const pending of cell.pendingCalls) {
    if (pending.call.callId !== callId) retained[retained.length] = pending;
  }
  cell.pendingCalls.length = 0;
  for (const pending of retained) cell.pendingCalls[cell.pendingCalls.length] = pending;
}

function settleGuestToolCalls(
  cell: ActiveWorkerCell,
  results: readonly CodeModeWorkerToolSettlement[],
): string | undefined {
  const batch = cell.outstandingBatch;
  if (batch === undefined) {
    return "Pi CodeMode: worker received tool results without an outstanding batch";
  }
  if (results.length !== batch.callIds.length) {
    return "Pi CodeMode: worker received an incomplete tool result batch";
  }
  const remainingIds = [...batch.callIds];
  for (const result of results) {
    const expectedIndex = remainingIds.indexOf(result.callId);
    if (expectedIndex === -1) return "Pi CodeMode: worker received an unexpected tool result";
    remainingIds.splice(expectedIndex, 1);
    const pending = cell.pendingCalls.find((candidate) => candidate.call.callId === result.callId);
    if (pending === undefined) return "Pi CodeMode: worker lost a guest tool promise";
    if (result.outcome === "success") pending.resolve(result.resultJson);
    else pending.reject(createCodeModeToolError(result.error.code, result.error.message));
    removePendingCall(cell, result.callId);
  }
  delete cell.outstandingBatch;
  queueRuntimeMicrotask(() => {
    scheduleToolBatch(cell);
    scheduleCellFinish(cell);
  });
  return undefined;
}

function scheduleCellFinish(cell: ActiveWorkerCell): void {
  if (activeCell !== cell || !cell.mainSettled || cell.finishScheduled) return;
  cell.finishScheduled = true;
  queueRuntimeMicrotask(() => {
    cell.finishScheduled = false;
    if (
      activeCell !== cell ||
      !cell.mainSettled ||
      cell.pendingCalls.length > 0 ||
      cell.outstandingBatch !== undefined ||
      cell.batchScheduled
    ) {
      return;
    }
    activeCell = undefined;
    let response: CodeModeWorkerResponse;
    if (cell.mainFailed) {
      const error = describeGuestError(cell.mainError);
      const serializationFailure =
        ((typeof cell.mainError === "object" && cell.mainError !== null) ||
          typeof cell.mainError === "function") &&
        (hasSerializationErrorInstance(cell.mainError) ||
          internalToolErrorCode(cell.mainError) === "serialization");
      response = {
        version: 1,
        type: "cell-error",
        sessionId: cell.sessionId,
        cellId: cell.cellId,
        error: {
          code: serializationFailure ? "serialization" : "script",
          message: renderGuestError(error),
        },
      };
    } else {
      try {
        const resultJson = serializeGuestJson(cell.mainResult, true);
        const responseBase = {
          version: 1,
          type: "cell-result",
          sessionId: cell.sessionId,
          cellId: cell.cellId,
        } as const;
        response = resultJson === undefined ? responseBase : { ...responseBase, resultJson };
      } catch (cause) {
        const error = describeGuestError(cause);
        response = {
          version: 1,
          type: "cell-error",
          sessionId: cell.sessionId,
          cellId: cell.cellId,
          error: { code: "serialization", message: renderGuestError(error) },
        };
      }
    }
    void enqueueWorkerResponse(response);
  });
}

function startWorkerCell(
  request: Extract<CodeModeWorkerRequest, { readonly type: "execute" }>,
): void {
  setToolNames(request.toolNames);
  const cell: ActiveWorkerCell = {
    sessionId: request.sessionId,
    cellId: request.cellId,
    pendingCalls: [],
    batchSequence: 0,
    callSequence: 0,
    batchScheduled: false,
    finishScheduled: false,
    mainFailed: false,
    mainSettled: false,
  };
  activeCell = cell;

  const suffix = replaceAllString(randomUuid(), "-", "_");
  const internalIdentifier = `__piCodeModeRuntime_${suffix}`;
  const runtimeKey = `__piCodeModeRuntimeKey_${suffix}`;
  const executableSource = replaceAllString(
    request.source,
    request.internalIdentifierPlaceholder,
    internalIdentifier,
  );
  defineProperty(globalThis, runtimeKey, {
    configurable: true,
    enumerable: false,
    value: notebookDeclarationHelper,
    writable: false,
  });
  const runtimeKeyLiteral = jsonStringify(runtimeKey);
  if (runtimeKeyLiteral === undefined) {
    throw new errorConstructor("Pi CodeMode: failed to serialize the internal runtime key");
  }
  // ponytail: Deno retains one small compiled Blob module per Cell; use a future public
  // transpile-and-eval API if long-lived Sessions reach the process heap limit.
  const moduleSource = `
let ${internalIdentifier} = globalThis[${runtimeKeyLiteral}];
delete globalThis[${runtimeKeyLiteral}];
try {
  ${internalIdentifier}.complete(await (async () => {
${executableSource}
  })());
} catch (cause) {
  ${internalIdentifier}.fail(cause);
} finally {
  ${internalIdentifier} = undefined;
}
export default undefined;
`;
  const moduleUrl = createBlobUrl(
    new blobConstructor([moduleSource], { type: "application/typescript" }),
  );
  void evaluateWorkerCellModule(cell, moduleUrl, runtimeKey);
}

async function evaluateWorkerCellModule(
  cell: ActiveWorkerCell,
  moduleUrl: string,
  runtimeKey: string,
): Promise<void> {
  try {
    await import(moduleUrl);
    if (!cell.mainSettled) {
      cell.mainError = new errorConstructor("Pi CodeMode: Cell module did not settle its result");
      cell.mainFailed = true;
      cell.mainSettled = true;
    }
  } catch (cause) {
    cell.mainError = cause;
    cell.mainFailed = true;
    cell.mainSettled = true;
  } finally {
    deleteProperty(globalThis, runtimeKey);
    revokeBlobUrl(moduleUrl);
    scheduleCellFinish(cell);
  }
}

const workerSessionId = denoProcess.args[0];
if (workerSessionId === undefined || workerSessionId.length === 0) {
  throw new errorConstructor("Pi CodeMode: worker requires a non-empty Session ID");
}

try {
  await enqueueWorkerResponse({ version: 1, type: "ready", sessionId: workerSessionId });
  for await (const message of readBoundedJsonLines(denoProcess.stdin)) {
    const parsed = parseCodeModeWorkerRequest(message);
    if (!parsed.ok) {
      await enqueueWorkerResponse({
        version: 1,
        type: "protocol-error",
        sessionId: workerSessionId,
        message: parsed.message,
      });
      break;
    }
    const request = parsed.value;
    if (request.sessionId !== workerSessionId) {
      await enqueueWorkerResponse({
        version: 1,
        type: "protocol-error",
        sessionId: workerSessionId,
        message: "Pi CodeMode: worker received a stale Session ID",
      });
      break;
    }
    if (request.type === "shutdown") {
      if (activeCell !== undefined) {
        await enqueueWorkerResponse({
          version: 1,
          type: "protocol-error",
          sessionId: workerSessionId,
          message: "Pi CodeMode: cannot gracefully shut down an active Cell",
        });
      }
      break;
    }
    if (request.type === "execute") {
      if (activeCell !== undefined) {
        await enqueueWorkerResponse({
          version: 1,
          type: "protocol-error",
          sessionId: workerSessionId,
          message: "Pi CodeMode: worker received overlapping Cells",
        });
        break;
      }
      startWorkerCell(request);
      continue;
    }
    if (
      activeCell === undefined ||
      request.cellId !== activeCell.cellId ||
      request.batchId !== activeCell.outstandingBatch?.batchId
    ) {
      await enqueueWorkerResponse({
        version: 1,
        type: "protocol-error",
        sessionId: workerSessionId,
        message: "Pi CodeMode: worker received stale tool results",
      });
      break;
    }
    const settlementError = settleGuestToolCalls(activeCell, request.results);
    if (settlementError !== undefined) {
      await enqueueWorkerResponse({
        version: 1,
        type: "protocol-error",
        sessionId: workerSessionId,
        message: settlementError,
      });
      break;
    }
  }
} finally {
  await responseWrites;
}
