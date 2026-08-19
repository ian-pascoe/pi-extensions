/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- SAFETY: This module is the JSON-lines protocol boundary and refines untrusted process messages before returning typed values. */
import { Buffer } from "node:buffer";

/** Maximum UTF-8 bytes in one CodeMode worker protocol line, excluding its newline. */
export const CODEMODE_WORKER_MESSAGE_LIMIT_BYTES = 8 * 1024 * 1024;

const CODEMODE_WORKER_PROTOCOL_VERSION = 1;

/** A nested tool call emitted by the QuickJS guest after one job drain. */
export type CodeModeWorkerToolCall = {
  readonly callId: string;
  readonly toolName: string;
  readonly inputJson: string;
};

/** A catchable nested tool settlement returned to the QuickJS guest. */
export type CodeModeWorkerToolSettlement =
  | { readonly callId: string; readonly outcome: "success"; readonly resultJson: string }
  | {
      readonly callId: string;
      readonly outcome: "error";
      readonly error: { readonly code: string; readonly message: string };
    };

/** QuickJS allocator state returned only by the debug worker variant. */
export type CodeModeWorkerMemoryUsage = {
  readonly mallocCount: number;
  readonly memoryUsedBytes: number;
  readonly objectCount: number;
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
      readonly timeoutMs?: number;
    }
  | {
      readonly version: 1;
      readonly type: "tool-results";
      readonly sessionId: string;
      readonly cellId: string;
      readonly batchId: string;
      readonly results: readonly CodeModeWorkerToolSettlement[];
    }
  | { readonly version: 1; readonly type: "shutdown"; readonly sessionId: string }
  | {
      readonly version: 1;
      readonly type: "evaluate";
      readonly sessionId: string;
      readonly requestId: string;
      readonly script: string;
    }
  | {
      readonly version: 1;
      readonly type: "debug-memory";
      readonly sessionId: string;
      readonly requestId: string;
    };

/** Stable worker-side Cell failures translated by the session coordinator. */
export type CodeModeWorkerCellErrorCode = "script" | "serialization" | "timeout" | "runtime";

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
    }
  | {
      readonly version: 1;
      readonly type: "cell-error";
      readonly sessionId: string;
      readonly cellId: string;
      readonly error: { readonly code: CodeModeWorkerCellErrorCode; readonly message: string };
    }
  | {
      readonly version: 1;
      readonly type: "protocol-error";
      readonly sessionId: string;
      readonly message: string;
    }
  | {
      readonly version: 1;
      readonly type: "result";
      readonly sessionId: string;
      readonly requestId: string;
      readonly resultJson: string;
    }
  | {
      readonly version: 1;
      readonly type: "error";
      readonly sessionId: string;
      readonly requestId: string;
      readonly error: { readonly code: string; readonly message: string };
    }
  | {
      readonly version: 1;
      readonly type: "debug-memory";
      readonly sessionId: string;
      readonly requestId: string;
      readonly memory: CodeModeWorkerMemoryUsage;
    };

/** One-shot compatibility response emitted by the installed-layout worker smoke test. */
export type CodeModeWorkerTracerResponse = Extract<
  CodeModeWorkerResponse,
  { readonly type: "result" | "error" }
>;

/** Expected result of parsing one untrusted CodeMode worker protocol line. */
export type CodeModeWorkerParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Protocol bytes require primitive refinement before exact-key parsing.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Protocol bytes require primitive refinement before use.
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function parseProtocolJson(
  message: unknown,
  subject: "request" | "response",
): CodeModeWorkerParseResult<unknown> {
  if (!isString(message))
    return { ok: false, message: `CodeMode worker ${subject} must be JSON text` };
  if (Buffer.byteLength(message, "utf8") > CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) {
    return { ok: false, message: `CodeMode worker ${subject} exceeds 8 MiB` };
  }
  try {
    return { ok: true, value: JSON.parse(message) };
  } catch {
    return { ok: false, message: `CodeMode worker ${subject} is not valid JSON` };
  }
}

function parseToolSettlement(value: unknown): CodeModeWorkerToolSettlement | undefined {
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
  decoded: Readonly<Record<string, unknown>>,
): CodeModeWorkerRequest | undefined {
  if (
    !hasExactKeys(decoded, ["batchId", "cellId", "results", "sessionId", "type", "version"]) ||
    !isNonEmptyString(decoded.sessionId) ||
    !isNonEmptyString(decoded.cellId) ||
    !isNonEmptyString(decoded.batchId) ||
    !Array.isArray(decoded.results)
  ) {
    return undefined;
  }
  const results: CodeModeWorkerToolSettlement[] = [];
  const callIds = new Set<string>();
  for (const candidate of decoded.results) {
    const result = parseToolSettlement(candidate);
    if (result === undefined || callIds.has(result.callId)) return undefined;
    callIds.add(result.callId);
    results.push(result);
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
  if (
    decoded.type === "evaluate" &&
    hasExactKeys(decoded, ["requestId", "script", "sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.sessionId) &&
    isNonEmptyString(decoded.requestId) &&
    isString(decoded.script)
  ) {
    return {
      ok: true,
      value: {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "evaluate",
        sessionId: decoded.sessionId,
        requestId: decoded.requestId,
        script: decoded.script,
      },
    };
  }
  if (
    decoded.type === "debug-memory" &&
    hasExactKeys(decoded, ["requestId", "sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.sessionId) &&
    isNonEmptyString(decoded.requestId)
  ) {
    return {
      ok: true,
      value: {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "debug-memory",
        sessionId: decoded.sessionId,
        requestId: decoded.requestId,
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
    const expectedKeys =
      decoded.timeoutMs === undefined
        ? [
            "cellId",
            "internalIdentifierPlaceholder",
            "sessionId",
            "source",
            "toolNames",
            "type",
            "version",
          ]
        : [
            "cellId",
            "internalIdentifierPlaceholder",
            "sessionId",
            "source",
            "timeoutMs",
            "toolNames",
            "type",
            "version",
          ];
    if (
      hasExactKeys(decoded, expectedKeys) &&
      isNonEmptyString(decoded.sessionId) &&
      isNonEmptyString(decoded.cellId) &&
      isString(decoded.source) &&
      isNonEmptyString(decoded.internalIdentifierPlaceholder) &&
      Array.isArray(decoded.toolNames) &&
      decoded.toolNames.every(isNonEmptyString) &&
      new Set(decoded.toolNames).size === decoded.toolNames.length &&
      (decoded.timeoutMs === undefined ||
        (Number.isSafeInteger(decoded.timeoutMs) && Number(decoded.timeoutMs) > 0))
    ) {
      const value = {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "execute",
        sessionId: decoded.sessionId,
        cellId: decoded.cellId,
        source: decoded.source,
        internalIdentifierPlaceholder: decoded.internalIdentifierPlaceholder,
        toolNames: decoded.toolNames,
      } as const;
      return decoded.timeoutMs === undefined
        ? { ok: true, value }
        : { ok: true, value: { ...value, timeoutMs: Number(decoded.timeoutMs) } };
    }
  }
  return { ok: false, message: "CodeMode worker request has an invalid protocol shape" };
}

function parseWorkerError(
  value: unknown,
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

function parseToolBatchResponse(
  decoded: Readonly<Record<string, unknown>>,
): CodeModeWorkerResponse | undefined {
  if (
    !hasExactKeys(decoded, ["batchId", "calls", "cellId", "sessionId", "type", "version"]) ||
    !isNonEmptyString(decoded.sessionId) ||
    !isNonEmptyString(decoded.cellId) ||
    !isNonEmptyString(decoded.batchId) ||
    !Array.isArray(decoded.calls)
  ) {
    return undefined;
  }
  const calls: CodeModeWorkerToolCall[] = [];
  const callIds = new Set<string>();
  for (const candidate of decoded.calls) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["callId", "inputJson", "toolName"]) ||
      !isNonEmptyString(candidate.callId) ||
      callIds.has(candidate.callId) ||
      !isNonEmptyString(candidate.toolName) ||
      !isString(candidate.inputJson)
    ) {
      return undefined;
    }
    callIds.add(candidate.callId);
    calls.push({
      callId: candidate.callId,
      toolName: candidate.toolName,
      inputJson: candidate.inputJson,
    });
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
    hasExactKeys(
      decoded,
      decoded.resultJson === undefined
        ? ["cellId", "sessionId", "type", "version"]
        : ["cellId", "resultJson", "sessionId", "type", "version"],
    ) &&
    isNonEmptyString(decoded.cellId) &&
    (decoded.resultJson === undefined || isString(decoded.resultJson))
  ) {
    const value = {
      version: CODEMODE_WORKER_PROTOCOL_VERSION,
      type: "cell-result",
      sessionId: decoded.sessionId,
      cellId: decoded.cellId,
    } as const;
    return decoded.resultJson === undefined
      ? { ok: true, value }
      : { ok: true, value: { ...value, resultJson: decoded.resultJson } };
  }
  if (
    decoded.type === "cell-error" &&
    hasExactKeys(decoded, ["cellId", "error", "sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.cellId)
  ) {
    const error = parseWorkerError(decoded.error);
    if (
      error !== undefined &&
      ["script", "serialization", "timeout", "runtime"].includes(error.code)
    ) {
      // SAFETY: The literal-membership check above refines the protocol string to the closed worker error code union.
      const code = error.code as CodeModeWorkerCellErrorCode;
      return {
        ok: true,
        value: {
          version: CODEMODE_WORKER_PROTOCOL_VERSION,
          type: "cell-error",
          sessionId: decoded.sessionId,
          cellId: decoded.cellId,
          error: { code, message: error.message },
        },
      };
    }
  }
  if (
    decoded.type === "debug-memory" &&
    hasExactKeys(decoded, ["memory", "requestId", "sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.requestId) &&
    isRecord(decoded.memory) &&
    hasExactKeys(decoded.memory, ["mallocCount", "memoryUsedBytes", "objectCount"]) &&
    Number.isSafeInteger(decoded.memory.mallocCount) &&
    Number(decoded.memory.mallocCount) >= 0 &&
    Number.isSafeInteger(decoded.memory.memoryUsedBytes) &&
    Number(decoded.memory.memoryUsedBytes) >= 0 &&
    Number.isSafeInteger(decoded.memory.objectCount) &&
    Number(decoded.memory.objectCount) >= 0
  ) {
    return {
      ok: true,
      value: {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "debug-memory",
        sessionId: decoded.sessionId,
        requestId: decoded.requestId,
        memory: {
          mallocCount: Number(decoded.memory.mallocCount),
          memoryUsedBytes: Number(decoded.memory.memoryUsedBytes),
          objectCount: Number(decoded.memory.objectCount),
        },
      },
    };
  }
  if (
    decoded.type === "result" &&
    hasExactKeys(decoded, ["requestId", "resultJson", "sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.requestId) &&
    isString(decoded.resultJson)
  ) {
    return {
      ok: true,
      value: {
        version: CODEMODE_WORKER_PROTOCOL_VERSION,
        type: "result",
        sessionId: decoded.sessionId,
        requestId: decoded.requestId,
        resultJson: decoded.resultJson,
      },
    };
  }
  if (
    decoded.type === "error" &&
    hasExactKeys(decoded, ["error", "requestId", "sessionId", "type", "version"]) &&
    isNonEmptyString(decoded.requestId)
  ) {
    const error = parseWorkerError(decoded.error);
    if (error !== undefined)
      return {
        ok: true,
        value: {
          version: CODEMODE_WORKER_PROTOCOL_VERSION,
          type: "error",
          sessionId: decoded.sessionId,
          requestId: decoded.requestId,
          error,
        },
      };
  }
  return { ok: false, message: "CodeMode worker response has an invalid protocol shape" };
}

/** Serializes one parent request without allowing an oversized protocol line. */
export function serializeCodeModeWorkerRequest(
  request: CodeModeWorkerRequest,
): CodeModeWorkerParseResult<string> {
  const message = JSON.stringify(request);
  return Buffer.byteLength(message, "utf8") <= CODEMODE_WORKER_MESSAGE_LIMIT_BYTES
    ? { ok: true, value: message }
    : { ok: false, message: "CodeMode worker request exceeds 8 MiB" };
}

/** Serializes one worker response, replacing oversized Cell output with a bounded error. */
export function serializeCodeModeWorkerResponse(response: CodeModeWorkerResponse): string {
  const message = JSON.stringify(response);
  if (Buffer.byteLength(message, "utf8") <= CODEMODE_WORKER_MESSAGE_LIMIT_BYTES) return message;
  if (
    response.type === "cell-result" ||
    response.type === "cell-error" ||
    response.type === "tool-batch"
  ) {
    return JSON.stringify({
      version: CODEMODE_WORKER_PROTOCOL_VERSION,
      type: "cell-error",
      sessionId: response.sessionId,
      cellId: response.cellId,
      error: { code: "serialization", message: "CodeMode worker response exceeds 8 MiB" },
    } satisfies CodeModeWorkerResponse);
  }
  return JSON.stringify({
    version: CODEMODE_WORKER_PROTOCOL_VERSION,
    type: "protocol-error",
    sessionId: response.sessionId,
    message: "CodeMode worker response exceeds 8 MiB",
  } satisfies CodeModeWorkerResponse);
}
