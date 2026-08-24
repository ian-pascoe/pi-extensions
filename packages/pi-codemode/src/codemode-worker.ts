import { CODEMODE_CONSOLE_METHODS, type CodeModeConsoleEntry } from "./codemode-console-output.ts";
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
const CODEMODE_CONSOLE_RESPONSE_RESERVE_BYTES = 512;

type DenoByteReader = { read(buffer: Uint8Array): Promise<number | null> };
type DenoByteWriter = { write(buffer: Uint8Array): Promise<number> };
type DenoInspectOptions = {
  readonly colors: false;
  readonly getters: false;
  readonly customInspect: false;
};
type CodeModeDenoNamespace = {
  readonly args: readonly string[];
  readonly stdin: DenoByteReader;
  readonly stdout: DenoByteWriter;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Deno.inspect is the captured hostile-value formatter; coordinator tests cover getters, coercion hooks, custom inspectors, and Proxies.
  readonly inspect: (value: unknown, options: DenoInspectOptions) => string;
  readonly internal: symbol;
  readonly [key: symbol]:
    | {
        readonly inspectArgs: (args: readonly unknown[], options: DenoInspectOptions) => string;
      }
    | undefined;
  readonly version: {
    readonly deno: string;
    readonly v8: string;
    readonly typescript: string;
  };
};

declare const Deno: CodeModeDenoNamespace;

const denoProcess = Deno;
const denoInspect = denoProcess.inspect;
const denoInternal = denoProcess[denoProcess.internal];
if (denoInternal === undefined)
  throw new Error("Pi CodeMode: Deno Console formatter is unavailable");
const denoInspectArgs = denoInternal.inspectArgs;
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
const SAFE_DENO_INSPECT_OPTIONS = objectFreeze({
  colors: false,
  getters: false,
  customInspect: false,
} as const);
const objectPrototype = Object.prototype;
const ownKeys = Reflect.ownKeys;
const queueRuntimeMicrotask = queueMicrotask.bind(globalThis);
const createPromiseWithResolvers = Promise.withResolvers.bind(Promise);
const promisePrototype = Promise.prototype;
const randomUuid = crypto.randomUUID.bind(crypto);
// oxlint-disable-next-line typescript/unbound-method -- Capturing this primordial before guest execution prevents a Cell from replacing it.
const replaceAllStringPrimordial = String.prototype.replaceAll;
const stringPrototype = String.prototype;
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

function isGuestReference(cause: unknown): cause is object {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: `typeof` cannot invoke guest Proxy traps; coordinator hostile-value tests prove this non-observable classification.
  return (typeof cause === "object" && cause !== null) || typeof cause === "function";
}

function isGuestString(cause: unknown): cause is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: `typeof` cannot invoke guest coercion or Proxy traps; coordinator hostile-value tests prove this non-observable classification.
  return typeof cause === "string";
}

function isStringPropertyKey(key: PropertyKey): key is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Reflect and Proxy keys require a primitive string/symbol split; coordinator hostile JSON and tool-key tests cover symbol rejection and dynamic lookup.
  return typeof key === "string";
}

function internalToolErrorCode(cause: unknown): string | undefined {
  return isGuestReference(cause) ? getToolErrorCode(cause) : undefined;
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Transformed Cell source completes with arbitrary guest data; coordinator hostile JSON and Notebook Binding tests cover deferred inspection.
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
  readonly consoleEntries: CodeModeConsoleEntry[];
  consoleBytes: number;
  consoleOverflow: boolean;
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Cell Console calls accept arbitrary guest values; captured Deno.inspect disables getters and custom inspection, while coordinator hostile-value tests cover coercion hooks and Proxies.
function inspectGuestConsoleValue(value: unknown): string {
  try {
    return denoInspect(value, SAFE_DENO_INSPECT_OPTIONS);
  } catch {
    return "[Uninspectable value]";
  }
}

function formatGuestConsoleArguments(args: readonly unknown[]): string | undefined {
  if (args.length === 0) return "";
  const first = args[0];
  const maximumTextLength =
    CODEMODE_WORKER_MESSAGE_LIMIT_BYTES - CODEMODE_CONSOLE_RESPONSE_RESERVE_BYTES;
  if (isGuestString(first) && first.length >= maximumTextLength) return undefined;
  if (args.length === 1 && isGuestString(first)) return first;
  if (isGuestString(first) && !first.includes("%")) {
    let text = first;
    for (let index = 1; index < args.length; index += 1) {
      const value = args[index];
      const rendered = isGuestString(value) ? value : inspectGuestConsoleValue(value);
      if (text.length + rendered.length + 1 >= maximumTextLength) return undefined;
      text += ` ${rendered}`;
    }
    return text;
  }
  if (!isGuestString(first)) {
    let text = "";
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index];
      const rendered = isGuestString(value) ? value : inspectGuestConsoleValue(value);
      const separatorLength = index === 0 ? 0 : 1;
      if (text.length + rendered.length + separatorLength >= maximumTextLength) return undefined;
      if (separatorLength > 0) text += " ";
      text += rendered;
    }
    return text;
  }

  const safeArgs: unknown[] = [first];
  for (let index = 1; index < args.length; index += 1) safeArgs[index] = args[index];
  let format = "";
  let argumentIndex = 1;
  for (let index = 0; index < first.length; index += 1) {
    const character = first[index];
    if (character !== "%" || index + 1 >= first.length) {
      format += character;
      continue;
    }
    const token = first[index + 1];
    if (token === "%") {
      format += "%%";
      index += 1;
      continue;
    }
    if (
      token !== "s" &&
      token !== "d" &&
      token !== "i" &&
      token !== "f" &&
      token !== "j" &&
      token !== "o" &&
      token !== "O" &&
      token !== "c"
    ) {
      format += `%${token}`;
      index += 1;
      continue;
    }
    const value = safeArgs[argumentIndex];
    if (value !== undefined || argumentIndex < safeArgs.length) {
      if (isGuestReference(value)) {
        const inspected = inspectGuestConsoleValue(value);
        if (inspected.length >= maximumTextLength) return undefined;
        safeArgs[argumentIndex] = inspected;
        format += token === "c" ? "%c" : "%s";
      } else {
        format += `%${token}`;
      }
      argumentIndex += 1;
    } else {
      format += `%${token}`;
    }
    index += 1;
  }
  safeArgs[0] = format;
  for (let index = argumentIndex; index < safeArgs.length; index += 1) {
    const value = safeArgs[index];
    if (isGuestReference(value)) {
      const inspected = inspectGuestConsoleValue(value);
      if (inspected.length >= maximumTextLength) return undefined;
      safeArgs[index] = inspected;
    }
  }
  let minimumFormattedBytes = 0;
  for (const value of safeArgs) {
    if (isGuestString(value)) minimumFormattedBytes += value.length;
    if (
      minimumFormattedBytes + CODEMODE_CONSOLE_RESPONSE_RESERVE_BYTES >=
      CODEMODE_WORKER_MESSAGE_LIMIT_BYTES
    ) {
      return undefined;
    }
  }
  return denoInspectArgs(safeArgs, SAFE_DENO_INSPECT_OPTIONS);
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
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Notebook Binding assignment accepts arbitrary Cell values by design; coordinator Notebook Binding reuse tests cover this dynamic seam.
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
    if (!isStringPropertyKey(name) || activeNotebookStage === undefined) {
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

function utf8JsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) bytes += 2;
    else if (codeUnit <= 0x1f) {
      bytes +=
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
          ? 2
          : 6;
    } else if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const lowSurrogate = value.charCodeAt(index + 1);
      if (lowSurrogate >= 0xdc00 && lowSurrogate <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes >= CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) return bytes;
  }
  return bytes;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: This is arbitrary guest ingress; descriptor-only traversal avoids invoking accessors, coercion, and guest-mutated methods. Coordinator hostile JSON tests cover the boundary.
function serializeGuestJson(value: unknown, allowUndefined: boolean): string | undefined {
  const seen: object[] = [];
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: Recursive guest inspection remains unknown until each descriptor value is classified; coordinator hostile JSON tests cover accessors, Proxies, cycles, and sparse arrays.
  const inspect = (candidate: unknown, path: string): unknown => {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: The recursive result remains unknown so JSON.stringify performs the existing transport normalization without a lint-only universal value hierarchy; coordinator serialization tests cover null and undefined.
    if (candidate === null) return null;
    if (candidate === undefined) {
      if (path === "$" && allowUndefined) return undefined;
      throw new CodeModeSerializationError(
        `CodeMode serialization failed: ${path} must be JSON data`,
      );
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Primitive classification with `typeof` cannot execute guest code; coordinator hostile JSON and mutated-primordial tests cover this ingress.
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
          if (!isStringPropertyKey(key)) {
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
        // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: The hostile-safe recursive inspector intentionally carries the array as unknown until JSON.stringify; coordinator sparse/accessor and undefined-normalization tests cover it.
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
        if (!isStringPropertyKey(key)) {
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

function describeGuestError(cause: unknown): GuestErrorDescription {
  if (isGuestString(cause)) return { name: "Error", message: cause };
  if (cause === null) return { name: "Error", message: "null" };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: One non-observable primitive split avoids coercing guest objects; coordinator hostile-thrown-value tests cover Proxy containment.
  const causeType = typeof cause;
  if (
    causeType === "number" ||
    causeType === "boolean" ||
    causeType === "bigint" ||
    causeType === "undefined"
  ) {
    return { name: "Error", message: stringFrom(cause) };
  }
  if (causeType === "symbol") return { name: "Error", message: "Symbol" };
  try {
    const nameDescriptor = getOwnPropertyDescriptor(cause, "name");
    const messageDescriptor = getOwnPropertyDescriptor(cause, "message");
    const stackDescriptor = getOwnPropertyDescriptor(cause, "stack");
    const name =
      nameDescriptor !== undefined &&
      "value" in nameDescriptor &&
      isGuestString(nameDescriptor.value)
        ? nameDescriptor.value
        : "Error";
    const message =
      messageDescriptor !== undefined &&
      "value" in messageDescriptor &&
      isGuestString(messageDescriptor.value)
        ? messageDescriptor.value
        : "CodeMode Cell rejected";
    if (
      stackDescriptor === undefined ||
      !("value" in stackDescriptor) ||
      !isGuestString(stackDescriptor.value)
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: Guest tool calls accept arbitrary Cell input and return JSON.parse output; coordinator nested-tool and hostile JSON tests cover both directions.
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
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: This is the guest-facing tool function boundary; nativeToolCall immediately performs hostile-safe JSON inspection. Coordinator nested-tool tests exercise it.
      value: (input: unknown) => {
        const result = nativeToolCall(name, input);
        // Observe ignored direct calls without changing rejection behavior for callers that await them.
        void result.catch(() => {});
        return result;
      },
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
    return isStringPropertyKey(name)
      ? getOwnPropertyDescriptor(toolFunctions, name)?.value
      : undefined;
  },
  getOwnPropertyDescriptor(_target, name) {
    if (!isStringPropertyKey(name)) return undefined;
    const value = getOwnPropertyDescriptor(toolFunctions, name)?.value;
    return value === undefined
      ? undefined
      : { configurable: true, enumerable: true, value, writable: false };
  },
  has(_target, name) {
    return isStringPropertyKey(name) && getOwnPropertyDescriptor(toolFunctions, name) !== undefined;
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
const guestConsole = createObject(null);
for (const method of CODEMODE_CONSOLE_METHODS) {
  defineProperty(guestConsole, method, {
    configurable: false,
    enumerable: true,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Cell Console calls accept arbitrary guest values; formatGuestConsoleArguments safely inspects them before capture.
    value: (...args: unknown[]): undefined => {
      const cell = activeCell;
      if (cell !== undefined && !cell.consoleOverflow) {
        const text = formatGuestConsoleArguments(args);
        if (text === undefined) {
          cell.consoleEntries.length = 0;
          cell.consoleOverflow = true;
          return undefined;
        }
        const entryBytes = 19 + utf8JsonStringByteLength(method) + utf8JsonStringByteLength(text);
        const nextConsoleBytes =
          cell.consoleBytes + (cell.consoleEntries.length === 0 ? 0 : 1) + entryBytes;
        if (
          nextConsoleBytes + CODEMODE_CONSOLE_RESPONSE_RESERVE_BYTES >=
          CODEMODE_WORKER_MESSAGE_LIMIT_BYTES
        ) {
          cell.consoleEntries.length = 0;
          cell.consoleOverflow = true;
          return undefined;
        }
        cell.consoleEntries[cell.consoleEntries.length] = {
          method,
          text,
        };
        cell.consoleBytes = nextConsoleBytes;
      }
      return undefined;
    },
    writable: false,
  });
}
objectFreeze(guestConsole);
defineProperty(globalThis, "console", {
  configurable: false,
  enumerable: false,
  value: guestConsole,
  writable: false,
});

function disableGuestGlobal(name: string, value?: Readonly<typeof safeDenoIdentity>): void {
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
    const consoleEntries = cell.consoleEntries.length === 0 ? undefined : [...cell.consoleEntries];
    let response: CodeModeWorkerResponse;
    if (cell.consoleOverflow) {
      response = {
        version: 1,
        type: "cell-error",
        sessionId: cell.sessionId,
        cellId: cell.cellId,
        error: { code: "serialization", message: "CodeMode worker response exceeds 8 MiB" },
      };
    } else if (cell.mainFailed) {
      const error = describeGuestError(cell.mainError);
      const serializationFailure =
        isGuestReference(cell.mainError) &&
        (hasSerializationErrorInstance(cell.mainError) ||
          internalToolErrorCode(cell.mainError) === "serialization");
      const message = renderGuestError(error);
      if (
        consoleEntries !== undefined &&
        cell.consoleBytes +
          utf8JsonStringByteLength(message) +
          CODEMODE_CONSOLE_RESPONSE_RESERVE_BYTES >=
          CODEMODE_WORKER_MESSAGE_LIMIT_BYTES
      ) {
        response = {
          version: 1,
          type: "cell-error",
          sessionId: cell.sessionId,
          cellId: cell.cellId,
          error: { code: "serialization", message: "CodeMode worker response exceeds 8 MiB" },
        };
      } else {
        const responseBase = {
          version: 1,
          type: "cell-error",
          sessionId: cell.sessionId,
          cellId: cell.cellId,
          error: {
            code: serializationFailure ? "serialization" : "script",
            message,
          },
        } as const;
        response =
          consoleEntries === undefined
            ? responseBase
            : { ...responseBase, console: consoleEntries };
      }
    } else {
      try {
        const resultJson = serializeGuestJson(cell.mainResult, true);
        if (
          consoleEntries !== undefined &&
          cell.consoleBytes +
            (resultJson === undefined ? 0 : utf8JsonStringByteLength(resultJson)) +
            CODEMODE_CONSOLE_RESPONSE_RESERVE_BYTES >=
            CODEMODE_WORKER_MESSAGE_LIMIT_BYTES
        ) {
          response = {
            version: 1,
            type: "cell-error",
            sessionId: cell.sessionId,
            cellId: cell.cellId,
            error: { code: "serialization", message: "CodeMode worker response exceeds 8 MiB" },
          };
        } else {
          const responseBase = {
            version: 1,
            type: "cell-result",
            sessionId: cell.sessionId,
            cellId: cell.cellId,
          } as const;
          const resultResponse =
            resultJson === undefined ? responseBase : { ...responseBase, resultJson };
          response =
            consoleEntries === undefined
              ? resultResponse
              : { ...resultResponse, console: consoleEntries };
        }
      } catch (cause) {
        const error = describeGuestError(cause);
        const responseBase = {
          version: 1,
          type: "cell-error",
          sessionId: cell.sessionId,
          cellId: cell.cellId,
          error: { code: "serialization", message: renderGuestError(error) },
        } as const;
        response =
          consoleEntries === undefined
            ? responseBase
            : { ...responseBase, console: consoleEntries };
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
    consoleEntries: [],
    consoleBytes: 2,
    consoleOverflow: false,
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
