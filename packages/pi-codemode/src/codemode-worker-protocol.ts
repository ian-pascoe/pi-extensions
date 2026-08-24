import { Buffer } from "node:buffer";
import { CODEMODE_CONSOLE_METHODS, type CodeModeConsoleEntry } from "./codemode-console-output.ts";

/** Maximum UTF-8 bytes in one CodeMode worker protocol line, excluding its newline. */
export const CODEMODE_WORKER_MESSAGE_LIMIT_BYTES = 8 * 1024 * 1024;

const CODEMODE_WORKER_PROTOCOL_VERSION = 1;
const arrayIsArray = Array.isArray;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const objectKeys = Object.keys;

type CodeModeProtocolObject = { readonly [key: string]: CodeModeProtocolValue };
type CodeModeProtocolValue =
  | null
  | boolean
  | number
  | string
  | readonly CodeModeProtocolValue[]
  | CodeModeProtocolObject;
type CodeModeProtocolSlot = CodeModeProtocolValue | undefined;

/** A nested tool call emitted by a Deno Cell after one microtask drain. */
export type CodeModeWorkerToolCall = {
  readonly callId: string;
  readonly toolName: string;
  readonly inputJson: string;
};

/** A catchable nested tool settlement returned to the Deno Cell. */
export type CodeModeWorkerToolSettlement =
  | { readonly callId: string; readonly outcome: "success"; readonly resultJson: string }
  | {
      readonly callId: string;
      readonly outcome: "error";
      readonly error: { readonly code: string; readonly message: string };
    };

/** Strict parent-to-process message for one persistent CodeMode Session. */
export type CodeModeWorkerRequest =
  | {
      readonly version: 1;
      readonly type: "execute";
      readonly sessionId: string;
      readonly cellId: string;
      readonly source: string;
      readonly internalIdentifierPlaceholder: string;
      readonly toolNames: readonly string[];
    }
  | {
      readonly version: 1;
      readonly type: "tool-results";
      readonly sessionId: string;
      readonly cellId: string;
      readonly batchId: string;
      readonly results: readonly CodeModeWorkerToolSettlement[];
    }
  | { readonly version: 1; readonly type: "shutdown"; readonly sessionId: string };

/** Stable worker-side Cell failures translated by the session coordinator. */
export type CodeModeWorkerCellErrorCode = "script" | "serialization" | "runtime";

/** Strict process-to-parent message for one persistent CodeMode Session. */
export type CodeModeWorkerResponse =
  | { readonly version: 1; readonly type: "ready"; readonly sessionId: string }
  | {
      readonly version: 1;
      readonly type: "tool-batch";
      readonly sessionId: string;
      readonly cellId: string;
      readonly batchId: string;
      readonly calls: readonly CodeModeWorkerToolCall[];
    }
  | {
      readonly version: 1;
      readonly type: "cell-result";
      readonly sessionId: string;
      readonly cellId: string;
      readonly resultJson?: string;
      readonly console?: readonly CodeModeConsoleEntry[];
    }
  | {
      readonly version: 1;
      readonly type: "cell-error";
      readonly sessionId: string;
      readonly cellId: string;
      readonly error: { readonly code: CodeModeWorkerCellErrorCode; readonly message: string };
      readonly console?: readonly CodeModeConsoleEntry[];
    }
  | {
      readonly version: 1;
      readonly type: "protocol-error";
      readonly sessionId: string;
      readonly message: string;
    };

/** Expected result of parsing one untrusted CodeMode worker protocol line. */
export type CodeModeWorkerParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function isRecord(value: CodeModeProtocolSlot): value is CodeModeProtocolObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: JSON.parse has already limited the value to JSON primitives, arrays, and objects; this selects the object arm without coercion.
  return typeof value === "object" && value !== null && !arrayIsArray(value);
}

function isString(value: CodeModeProtocolSlot): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: JSON.parse has already limited the value to JSON data; this selects its string arm without coercion.
  return typeof value === "string";
}

function isNonEmptyString(value: CodeModeProtocolSlot): value is string {
  return isString(value) && value.length > 0;
}

function isUniqueNonEmptyStringArray(value: CodeModeProtocolSlot): value is readonly string[] {
  if (!arrayIsArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!isNonEmptyString(candidate)) return false;
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      if (value[priorIndex] === candidate) return false;
    }
  }
  return true;
}

function hasString(values: readonly string[], candidate: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === candidate) return true;
  }
  return false;
}

function hasExactKeys(value: CodeModeProtocolObject, expected: readonly string[]): boolean {
  const keys = objectKeys(value);
  if (keys.length !== expected.length) return false;
  return expected.every((expectedKey) => expectedKey !== undefined && keys.includes(expectedKey));
}

function hasDuplicateJsonObjectKeys(message: string): boolean {
  const objectKeysByDepth: (string[] | undefined)[] = [];
  for (let index = 0; index < message.length; index += 1) {
    const character = message[index];
    if (character === "{") {
      objectKeysByDepth.push([]);
      continue;
    }
    if (character === "[") {
      objectKeysByDepth.push(undefined);
      continue;
    }
    if (character === "}" || character === "]") {
      objectKeysByDepth.pop();
      continue;
    }
    if (character !== '"') continue;

    let endIndex = index + 1;
    for (; endIndex < message.length; endIndex += 1) {
      if (message[endIndex] === "\\") {
        endIndex += 1;
        continue;
      }
      if (message[endIndex] === '"') break;
    }
    if (endIndex >= message.length) return false;
    let nextIndex = endIndex + 1;
    while (
      message[nextIndex] === " " ||
      message[nextIndex] === "\n" ||
      message[nextIndex] === "\r" ||
      message[nextIndex] === "\t"
    ) {
      nextIndex += 1;
    }
    const keys = objectKeysByDepth[objectKeysByDepth.length - 1];
    if (message[nextIndex] === ":" && keys !== undefined) {
      try {
        // SAFETY: This slice is one syntactically bounded JSON string token; the string refinement below rejects every other JSON value.
        const key = jsonParse(message.slice(index, endIndex + 1)) as CodeModeProtocolValue;
        if (isString(key)) {
          if (hasString(keys, key)) return true;
          keys.push(key);
        }
      } catch {
        return false;
      }
    }
    index = endIndex;
  }
  return false;
}

function parseProtocolJson(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Raw process input is untrusted until the string and JSON checks below establish the protocol representation.
  message: unknown,
  subject: "request" | "response",
): CodeModeWorkerParseResult<CodeModeProtocolValue> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: This is the sole raw process-line ingress; only primitive string input reaches JSON.parse and protocol tests cover non-string rejection.
  if (typeof message !== "string")
    return { ok: false, message: `CodeMode worker ${subject} must be JSON text` };
  if (Buffer.byteLength(message, "utf8") > CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) {
    return { ok: false, message: `CodeMode worker ${subject} exceeds 8 MiB` };
  }
  if (hasDuplicateJsonObjectKeys(message)) {
    return { ok: false, message: `CodeMode worker ${subject} contains duplicate object keys` };
  }
  try {
    // SAFETY: Successful JSON.parse output is exactly the recursive JSON representation modeled by CodeModeProtocolValue.
    return { ok: true, value: jsonParse(message) as CodeModeProtocolValue };
  } catch {
    return { ok: false, message: `CodeMode worker ${subject} is not valid JSON` };
  }
}

function parseToolSettlement(
  value: CodeModeProtocolSlot,
): CodeModeWorkerToolSettlement | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.callId)) return undefined;
  if (
    value.outcome === "success" &&
    hasExactKeys(value, ["callId", "outcome", "resultJson"]) &&
    isString(value.resultJson)
  ) {
    return { callId: value.callId, outcome: "success", resultJson: value.resultJson };
  }
  if (
    value.outcome === "error" &&
    hasExactKeys(value, ["callId", "error", "outcome"]) &&
    isRecord(value.error) &&
    hasExactKeys(value.error, ["code", "message"]) &&
    isNonEmptyString(value.error.code) &&
    isNonEmptyString(value.error.message)
  ) {
    return {
      callId: value.callId,
      outcome: "error",
      error: { code: value.error.code, message: value.error.message },
    };
  }
  return undefined;
}

function parseToolResultsRequest(
  decoded: CodeModeProtocolObject,
): CodeModeWorkerRequest | undefined {
  if (
    !hasExactKeys(decoded, ["batchId", "cellId", "results", "sessionId", "type", "version"]) ||
    !isNonEmptyString(decoded.sessionId) ||
    !isNonEmptyString(decoded.cellId) ||
    !isNonEmptyString(decoded.batchId) ||
    !arrayIsArray(decoded.results)
  ) {
    return undefined;
  }
  const results: CodeModeWorkerToolSettlement[] = [];
  const callIds: string[] = [];
  for (let index = 0; index < decoded.results.length; index += 1) {
    const result = parseToolSettlement(decoded.results[index]);
    if (result === undefined || hasString(callIds, result.callId)) return undefined;
    callIds[callIds.length] = result.callId;
    results[results.length] = result;
  }
  return {
    version: CODEMODE_WORKER_PROTOCOL_VERSION,
    type: "tool-results",
    sessionId: decoded.sessionId,
    cellId: decoded.cellId,
    batchId: decoded.batchId,
    results,
  };
}

/** Parses one strict, versioned, bounded parent-to-worker JSON line. */
export function parseCodeModeWorkerRequest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: This exported parser is the parent-to-worker protocol ingress and accepts arbitrary process input by design.
  message: unknown,
): CodeModeWorkerParseResult<CodeModeWorkerRequest> {
  const parsed = parseProtocolJson(message, "request");
  if (!parsed.ok) return parsed;
  const decoded = parsed.value;
  if (
    !isRecord(decoded) ||
    decoded.version !== CODEMODE_WORKER_PROTOCOL_VERSION ||
    !isString(decoded.type)
  ) {
    return { ok: false, message: "CodeMode worker request has an invalid protocol shape" };
  }

  if (
    decoded.type === "shutdown" &&
    hasExactKeys(decoded, ["sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.sessionId)
  ) {
    return {
      ok: true,
      value: {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "shutdown",
        sessionId: decoded.sessionId,
      },
    };
  }
  if (decoded.type === "tool-results") {
    const request = parseToolResultsRequest(decoded);
    return request === undefined
      ? { ok: false, message: "CodeMode worker request has an invalid protocol shape" }
      : { ok: true, value: request };
  }
  if (decoded.type === "execute") {
    if (
      hasExactKeys(decoded, [
        "cellId",
        "internalIdentifierPlaceholder",
        "sessionId",
        "source",
        "toolNames",
        "type",
        "version",
      ]) &&
      isNonEmptyString(decoded.sessionId) &&
      isNonEmptyString(decoded.cellId) &&
      isString(decoded.source) &&
      isNonEmptyString(decoded.internalIdentifierPlaceholder) &&
      isUniqueNonEmptyStringArray(decoded.toolNames)
    ) {
      return {
        ok: true,
        value: {
          version: CODEMODE_WORKER_PROTOCOL_VERSION,
          type: "execute",
          sessionId: decoded.sessionId,
          cellId: decoded.cellId,
          source: decoded.source,
          internalIdentifierPlaceholder: decoded.internalIdentifierPlaceholder,
          toolNames: decoded.toolNames,
        },
      };
    }
  }
  return { ok: false, message: "CodeMode worker request has an invalid protocol shape" };
}

function parseWorkerError(
  value: CodeModeProtocolSlot,
): { readonly code: string; readonly message: string } | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["code", "message"]) ||
    !isNonEmptyString(value.code) ||
    !isNonEmptyString(value.message)
  ) {
    return undefined;
  }
  return { code: value.code, message: value.message };
}

function parseConsoleOutput(
  value: CodeModeProtocolSlot,
): readonly CodeModeConsoleEntry[] | undefined {
  if (!arrayIsArray(value) || value.length === 0) return undefined;
  const entries: CodeModeConsoleEntry[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["method", "text"]) ||
      !isString(candidate.method) ||
      !hasString(CODEMODE_CONSOLE_METHODS, candidate.method) ||
      !isString(candidate.text)
    ) {
      return undefined;
    }
    entries.push({
      // SAFETY: The literal-membership check above refines the protocol string to a supported Console method.
      method: candidate.method as CodeModeConsoleEntry["method"],
      text: candidate.text,
    });
  }
  return entries;
}

function parseToolBatchResponse(
  decoded: CodeModeProtocolObject,
): CodeModeWorkerResponse | undefined {
  if (
    !hasExactKeys(decoded, ["batchId", "calls", "cellId", "sessionId", "type", "version"]) ||
    !isNonEmptyString(decoded.sessionId) ||
    !isNonEmptyString(decoded.cellId) ||
    !isNonEmptyString(decoded.batchId) ||
    !arrayIsArray(decoded.calls)
  ) {
    return undefined;
  }
  const calls: CodeModeWorkerToolCall[] = [];
  const callIds: string[] = [];
  for (let index = 0; index < decoded.calls.length; index += 1) {
    const candidate = decoded.calls[index];
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["callId", "inputJson", "toolName"]) ||
      !isNonEmptyString(candidate.callId) ||
      hasString(callIds, candidate.callId) ||
      !isNonEmptyString(candidate.toolName) ||
      !isString(candidate.inputJson)
    ) {
      return undefined;
    }
    callIds[callIds.length] = candidate.callId;
    calls[calls.length] = {
      callId: candidate.callId,
      toolName: candidate.toolName,
      inputJson: candidate.inputJson,
    };
  }
  if (calls.length === 0) return undefined;
  return {
    version: CODEMODE_WORKER_PROTOCOL_VERSION,
    type: "tool-batch",
    sessionId: decoded.sessionId,
    cellId: decoded.cellId,
    batchId: decoded.batchId,
    calls,
  };
}

/** Parses one strict, versioned, bounded worker-to-parent JSON line. */
export function parseCodeModeWorkerResponse(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: This exported parser is the worker-to-parent protocol ingress and accepts arbitrary process input by design.
  message: unknown,
): CodeModeWorkerParseResult<CodeModeWorkerResponse> {
  const parsed = parseProtocolJson(message, "response");
  if (!parsed.ok) return parsed;
  const decoded = parsed.value;
  if (
    !isRecord(decoded) ||
    decoded.version !== CODEMODE_WORKER_PROTOCOL_VERSION ||
    !isString(decoded.type) ||
    !isNonEmptyString(decoded.sessionId)
  ) {
    return { ok: false, message: "CodeMode worker response has an invalid protocol shape" };
  }
  if (decoded.type === "ready" && hasExactKeys(decoded, ["sessionId", "type", "version"])) {
    return {
      ok: true,
      value: {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "ready",
        sessionId: decoded.sessionId,
      },
    };
  }
  if (
    decoded.type === "protocol-error" &&
    hasExactKeys(decoded, ["message", "sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.message)
  ) {
    return {
      ok: true,
      value: {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "protocol-error",
        sessionId: decoded.sessionId,
        message: decoded.message,
      },
    };
  }
  if (decoded.type === "tool-batch") {
    const response = parseToolBatchResponse(decoded);
    return response === undefined
      ? { ok: false, message: "CodeMode worker response has an invalid protocol shape" }
      : { ok: true, value: response };
  }
  if (
    decoded.type === "cell-result" &&
    isNonEmptyString(decoded.cellId) &&
    (decoded.resultJson === undefined || isString(decoded.resultJson))
  ) {
    const expectedKeys = ["cellId", "sessionId", "type", "version"];
    if (decoded.resultJson !== undefined) expectedKeys.push("resultJson");
    if (decoded.console !== undefined) expectedKeys.push("console");
    if (!hasExactKeys(decoded, expectedKeys)) {
      return { ok: false, message: "CodeMode worker response has an invalid protocol shape" };
    }
    const consoleEntries =
      decoded.console === undefined ? undefined : parseConsoleOutput(decoded.console);
    if (decoded.console !== undefined && consoleEntries === undefined) {
      return { ok: false, message: "CodeMode worker response has an invalid protocol shape" };
    }
    const value = {
      version: CODEMODE_WORKER_PROTOCOL_VERSION,
      type: "cell-result",
      sessionId: decoded.sessionId,
      cellId: decoded.cellId,
    } as const;
    const resultValue =
      decoded.resultJson === undefined ? value : { ...value, resultJson: decoded.resultJson };
    return consoleEntries === undefined
      ? { ok: true, value: resultValue }
      : { ok: true, value: { ...resultValue, console: consoleEntries } };
  }
  if (decoded.type === "cell-error" && isNonEmptyString(decoded.cellId)) {
    const expectedKeys = ["cellId", "error", "sessionId", "type", "version"];
    if (decoded.console !== undefined) expectedKeys.push("console");
    if (!hasExactKeys(decoded, expectedKeys)) {
      return { ok: false, message: "CodeMode worker response has an invalid protocol shape" };
    }
    const error = parseWorkerError(decoded.error);
    const consoleEntries =
      decoded.console === undefined ? undefined : parseConsoleOutput(decoded.console);
    if (
      error !== undefined &&
      ["script", "serialization", "runtime"].includes(error.code) &&
      (decoded.console === undefined || consoleEntries !== undefined)
    ) {
      // SAFETY: The literal-membership check above refines the protocol string to the closed worker error code union.
      const code = error.code as CodeModeWorkerCellErrorCode;
      const value = {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "cell-error",
        sessionId: decoded.sessionId,
        cellId: decoded.cellId,
        error: { code, message: error.message },
      } as const;
      return {
        ok: true,
        value: consoleEntries === undefined ? value : { ...value, console: consoleEntries },
      };
    }
  }
  return { ok: false, message: "CodeMode worker response has an invalid protocol shape" };
}

/** Serializes one parent request without allowing an oversized protocol line. */
export function serializeCodeModeWorkerRequest(
  request: CodeModeWorkerRequest,
): CodeModeWorkerParseResult<string> {
  const message = jsonStringify(request);
  return Buffer.byteLength(message, "utf8") <= CODEMODE_WORKER_MESSAGE_LIMIT_BYTES
    ? { ok: true, value: message }
    : { ok: false, message: "CodeMode worker request exceeds 8 MiB" };
}

/** Serializes one worker response, replacing oversized Cell output with a bounded error. */
export function serializeCodeModeWorkerResponse(response: CodeModeWorkerResponse): string {
  let message: string;
  if (response.type === "cell-result" && response.console?.length === 0) {
    const responseBase = {
      version: response.version,
      type: response.type,
      sessionId: response.sessionId,
      cellId: response.cellId,
    } as const;
    message = jsonStringify(
      response.resultJson === undefined
        ? responseBase
        : { ...responseBase, resultJson: response.resultJson },
    );
  } else if (response.type === "cell-error" && response.console?.length === 0) {
    message = jsonStringify({
      version: response.version,
      type: response.type,
      sessionId: response.sessionId,
      cellId: response.cellId,
      error: response.error,
    });
  } else message = jsonStringify(response);
  if (Buffer.byteLength(message, "utf8") <= CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) return message;
  if (
    response.type === "cell-result" ||
    response.type === "cell-error" ||
    response.type === "tool-batch"
  ) {
    return jsonStringify({
      version: CODEMODE_WORKER_PROTOCOL_VERSION,
      type: "cell-error",
      sessionId: response.sessionId,
      cellId: response.cellId,
      error: { code: "serialization", message: "CodeMode worker response exceeds 8 MiB" },
    } satisfies CodeModeWorkerResponse);
  }
  return jsonStringify({
    version: CODEMODE_WORKER_PROTOCOL_VERSION,
    type: "protocol-error",
    sessionId: response.sessionId,
    message: "CodeMode worker response exceeds 8 MiB",
  } satisfies CodeModeWorkerResponse);
}
