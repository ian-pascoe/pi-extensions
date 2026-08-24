import { describe, expect, test } from "vitest";
import {
  CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
  parseCodeModeWorkerRequest,
  parseCodeModeWorkerResponse,
  serializeCodeModeWorkerRequest,
  serializeCodeModeWorkerResponse,
} from "../src/codemode-worker-protocol.js";

describe("CodeMode worker protocol", () => {
  test("roundtrips one strict execute request", () => {
    const request = {
      version: 1 as const,
      type: "execute" as const,
      sessionId: "session-1",
      cellId: "cell-1",
      source: "42",
      internalIdentifierPlaceholder: "__internal",
      toolNames: ["read", "odd.name"],
    };
    const serialized = serializeCodeModeWorkerRequest(request);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseCodeModeWorkerRequest(serialized.value)).toEqual({ ok: true, value: request });
  });

  test("parses exact tool settlements and rejects duplicates or unknown fields", () => {
    const valid = JSON.stringify({
      version: 1,
      type: "tool-results",
      sessionId: "session-1",
      cellId: "cell-1",
      batchId: "batch-1",
      results: [
        { callId: "call-1", outcome: "success", resultJson: "null" },
        { callId: "call-2", outcome: "error", error: { code: "blocked", message: "no" } },
      ],
    });
    expect(parseCodeModeWorkerRequest(valid).ok).toBe(true);
    expect(
      parseCodeModeWorkerRequest(valid.replace('"batchId"', '"extra":true,"batchId"')).ok,
    ).toBe(false);
    expect(
      parseCodeModeWorkerRequest(
        JSON.stringify({
          version: 1,
          type: "tool-results",
          sessionId: "session-1",
          cellId: "cell-1",
          batchId: "batch-1",
          results: [
            { callId: "same", outcome: "success", resultJson: "null" },
            { callId: "same", outcome: "success", resultJson: "null" },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  test("rejects duplicate guest tool names and parent-only timeout fields", () => {
    const request = {
      version: 1,
      type: "execute",
      sessionId: "session-1",
      cellId: "cell-1",
      source: "42",
      internalIdentifierPlaceholder: "__internal",
      toolNames: ["read", "read"],
    };
    expect(parseCodeModeWorkerRequest(JSON.stringify(request)).ok).toBe(false);
    expect(
      parseCodeModeWorkerRequest(JSON.stringify({ ...request, toolNames: ["read"], timeoutMs: 25 }))
        .ok,
    ).toBe(false);
  });

  test("parses every request and response variant with their exact optional fields", () => {
    expect(
      parseCodeModeWorkerRequest('{"version":1,"type":"shutdown","sessionId":"session-1"}'),
    ).toEqual({
      ok: true,
      value: { version: 1, type: "shutdown", sessionId: "session-1" },
    });
    expect(
      parseCodeModeWorkerResponse('{"version":1,"type":"ready","sessionId":"session-1"}').ok,
    ).toBe(true);
    expect(
      parseCodeModeWorkerResponse(
        JSON.stringify({
          version: 1,
          type: "tool-batch",
          sessionId: "session-1",
          cellId: "cell-1",
          batchId: "batch-1",
          calls: [{ callId: "call-1", toolName: "read", inputJson: "{}" }],
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"cell-result","sessionId":"session-1","cellId":"cell-1"}',
      ),
    ).toEqual({
      ok: true,
      value: { version: 1, type: "cell-result", sessionId: "session-1", cellId: "cell-1" },
    });
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"cell-result","sessionId":"session-1","cellId":"cell-1","resultJson":"null"}',
      ),
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        type: "cell-result",
        sessionId: "session-1",
        cellId: "cell-1",
        resultJson: "null",
      },
    });
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"cell-error","sessionId":"session-1","cellId":"cell-1","error":{"code":"runtime","message":"failed"}}',
      ).ok,
    ).toBe(true);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"protocol-error","sessionId":"session-1","message":"failed"}',
      ),
    ).toEqual({
      ok: true,
      value: { version: 1, type: "protocol-error", sessionId: "session-1", message: "failed" },
    });
  });

  test("roundtrips ordered Console output on Cell results and failures", () => {
    const result = {
      version: 1 as const,
      type: "cell-result" as const,
      sessionId: "session-1",
      cellId: "cell-1",
      resultJson: "42",
      console: [
        { method: "log" as const, text: "answer: 42" },
        { method: "warn" as const, text: "first\nsecond" },
      ],
    };
    const failure = {
      version: 1 as const,
      type: "cell-error" as const,
      sessionId: "session-1",
      cellId: "cell-2",
      error: { code: "script" as const, message: "failed" },
      console: [{ method: "error" as const, text: "before failure" }],
    };

    expect(parseCodeModeWorkerResponse(serializeCodeModeWorkerResponse(result))).toEqual({
      ok: true,
      value: result,
    });
    expect(parseCodeModeWorkerResponse(serializeCodeModeWorkerResponse(failure))).toEqual({
      ok: true,
      value: failure,
    });
  });

  test("rejects malformed Console output and Console fields on unrelated responses", () => {
    const result = {
      version: 1,
      type: "cell-result",
      sessionId: "session-1",
      cellId: "cell-1",
    };
    for (const consoleEntries of [
      [],
      [{ method: "trace", text: "x" }],
      [{ method: "log" }],
      [{ method: "log", text: 1 }],
      [{ method: "log", text: "x", extra: true }],
    ]) {
      expect(
        parseCodeModeWorkerResponse(JSON.stringify({ ...result, console: consoleEntries })).ok,
      ).toBe(false);
    }
    for (const response of [
      {
        version: 1,
        type: "ready",
        sessionId: "session-1",
        console: [{ method: "log", text: "x" }],
      },
      {
        version: 1,
        type: "protocol-error",
        sessionId: "session-1",
        message: "failed",
        console: [{ method: "log", text: "x" }],
      },
      {
        version: 1,
        type: "tool-batch",
        sessionId: "session-1",
        cellId: "cell-1",
        batchId: "batch-1",
        calls: [{ callId: "call-1", toolName: "read", inputJson: "{}" }],
        console: [{ method: "log", text: "x" }],
      },
    ]) {
      expect(parseCodeModeWorkerResponse(JSON.stringify(response)).ok).toBe(false);
    }

    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"cell-result","sessionId":"session-1","cellId":"cell-1","console":[{"method":"log","method":"warn","text":"x"}]}',
      ),
    ).toEqual({
      ok: false,
      message: "CodeMode worker response contains duplicate object keys",
    });
  });

  test("rejects malformed, removed diagnostics, empty batches, unknown versions, and over-limit lines", () => {
    expect(parseCodeModeWorkerRequest("not json")).toEqual({
      ok: false,
      message: "CodeMode worker request is not valid JSON",
    });
    expect(parseCodeModeWorkerRequest(null)).toEqual({
      ok: false,
      message: "CodeMode worker request must be JSON text",
    });
    expect(
      parseCodeModeWorkerRequest(
        '{"version":1,"type":"evaluate","sessionId":"session-1","requestId":"old","script":"42"}',
      ).ok,
    ).toBe(false);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"debug-memory","sessionId":"session-1","requestId":"old","memory":{"mallocCount":1,"memoryUsedBytes":1,"objectCount":1}}',
      ).ok,
    ).toBe(false);
    expect(
      parseCodeModeWorkerResponse('{"version":2,"type":"ready","sessionId":"session-1"}').ok,
    ).toBe(false);
    expect(parseCodeModeWorkerResponse('{"version":1,"type":"ready"}').ok).toBe(false);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"cell-result","sessionId":"session-1","cellId":"cell-1","resultJson":null}',
      ).ok,
    ).toBe(false);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"cell-error","sessionId":"session-1","cellId":"cell-1","error":{"code":"unknown","message":"failed"}}',
      ).ok,
    ).toBe(false);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"tool-batch","sessionId":"session-1","cellId":"cell-1","batchId":"batch-1","calls":[]}',
      ).ok,
    ).toBe(false);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"tool-batch","sessionId":"session-1","cellId":"cell-1","batchId":"batch-1","calls":[{"callId":"same","toolName":"read","inputJson":"{}"},{"callId":"same","toolName":"write","inputJson":"{}"}]}',
      ).ok,
    ).toBe(false);
    expect(parseCodeModeWorkerRequest("x".repeat(CODEMODE_WORKER_MESSAGE_LIMIT_BYTES + 1)).ok).toBe(
      false,
    );
  });

  test("turns oversized worker output into one bounded serialization failure", () => {
    const serialized = serializeCodeModeWorkerResponse({
      version: 1,
      type: "cell-result",
      sessionId: "session-1",
      cellId: "cell-1",
      resultJson: JSON.stringify("x".repeat(CODEMODE_WORKER_MESSAGE_LIMIT_BYTES)),
      console: [{ method: "log", text: "must be omitted" }],
    });
    const parsed = parseCodeModeWorkerResponse(serialized);
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        type: "cell-error",
        sessionId: "session-1",
        cellId: "cell-1",
        error: { code: "serialization" },
      },
    });
    expect(serialized).not.toContain("must be omitted");
  });
});
