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
      timeoutMs: 25,
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

  test("rejects duplicate guest tool names and invalid timeout units", () => {
    const request = {
      version: 1,
      type: "execute",
      sessionId: "session-1",
      cellId: "cell-1",
      source: "42",
      internalIdentifierPlaceholder: "__internal",
      toolNames: ["read", "read"],
      timeoutMs: 0,
    };
    expect(parseCodeModeWorkerRequest(JSON.stringify(request)).ok).toBe(false);
  });

  test("parses ready, batches, optional Cell data, and stable Cell errors", () => {
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
      ).ok,
    ).toBe(true);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"cell-error","sessionId":"session-1","cellId":"cell-1","error":{"code":"timeout","message":"late"}}',
      ).ok,
    ).toBe(true);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"debug-memory","sessionId":"session-1","requestId":"memory-1","memory":{"mallocCount":1500,"memoryUsedBytes":86000,"objectCount":300}}',
      ).ok,
    ).toBe(true);
  });

  test("rejects malformed, empty-batch, unknown-version, and over-limit lines", () => {
    expect(parseCodeModeWorkerRequest("not json").ok).toBe(false);
    expect(
      parseCodeModeWorkerResponse('{"version":2,"type":"ready","sessionId":"session-1"}').ok,
    ).toBe(false);
    expect(parseCodeModeWorkerResponse('{"version":1,"type":"ready"}').ok).toBe(false);
    expect(
      parseCodeModeWorkerResponse(
        '{"version":1,"type":"tool-batch","sessionId":"session-1","cellId":"cell-1","batchId":"batch-1","calls":[]}',
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
  });
});
