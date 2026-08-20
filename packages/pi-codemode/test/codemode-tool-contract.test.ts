import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import {
  CODEMODE_ERROR_CODES,
  CodeModeCancelParametersSchema,
  CodeModeExecuteParametersSchema,
  CodeModeJsonValueSchema,
  type CodeModePresentationSnapshot,
  CodeModePresentationSnapshotSchema,
  CodeModeResultDetailsSchema,
  CodeModeResultParametersSchema,
  CodeModeResultSchema,
  createCodeModeFailure,
  createCodeModePending,
  createCodeModeSuccess,
  createCodeModeToolDefinitions,
  parseCodeModeJsonValue,
} from "../src/codemode-tool-contract.js";

type CyclicTestValue = { self?: CyclicTestValue };

describe("CodeMode tool contract", () => {
  test("accepts strict public inputs and rejects unknown fields/bad timeout", () => {
    expect(
      Value.Check(CodeModeExecuteParametersSchema, {
        script: "return 42",
        timeoutMs: Number.MAX_SAFE_INTEGER,
        wait: false,
        sessionId: "session-1",
      }),
    ).toBe(true);
    expect(Value.Check(CodeModeExecuteParametersSchema, { script: "x", nope: true })).toBe(false);
    expect(Value.Check(CodeModeExecuteParametersSchema, { script: "x", timeoutMs: 0 })).toBe(false);
    expect(Value.Check(CodeModeExecuteParametersSchema, { script: "x", timeoutMs: 1.5 })).toBe(
      false,
    );
    expect(Value.Check(CodeModeExecuteParametersSchema, { script: "" })).toBe(true);
    expect(Value.Check(CodeModeResultParametersSchema, { sessionId: "s" })).toBe(true);
    expect(Value.Check(CodeModeCancelParametersSchema, { sessionId: "s", extra: 1 })).toBe(false);
  });

  test("validates every result branch and nested JSON data", () => {
    const success = createCodeModeSuccess("s", { answer: [42, null, true] });
    const pending = createCodeModePending("s");
    const failed = createCodeModeFailure("s", "timeout", "deadline exceeded");
    expect(Value.Check(CodeModeResultSchema, success)).toBe(true);
    expect(Value.Check(CodeModeResultSchema, pending)).toBe(true);
    expect(Value.Check(CodeModeResultSchema, failed)).toBe(true);
    expect(
      Value.Check(CodeModeResultSchema, {
        result: "failed",
        sessionId: "s",
        error: { code: "nope", message: "x" },
      }),
    ).toBe(false);
    expect(Value.Check(CodeModeJsonValueSchema, { nested: ["ok"] })).toBe(true);
    expect(CODEMODE_ERROR_CODES).toContain("termination");
  });

  test("inspects hostile values without invoking accessors or toJSON", () => {
    let getterCalled = false;
    const hostile = {};
    Object.defineProperty(hostile, "value", {
      enumerable: true,
      get() {
        getterCalled = true;
        return 1;
      },
    });
    expect(parseCodeModeJsonValue(hostile).ok).toBe(false);
    expect(getterCalled).toBe(false);

    const withToJson = {
      value: 1,
      toJSON: () => {
        throw new Error("must not run");
      },
    };
    expect(parseCodeModeJsonValue(withToJson).ok).toBe(false);
    expect(parseCodeModeJsonValue({ value: 1 })).toMatchObject({ ok: true });
    expect(parseCodeModeJsonValue(undefined, { allowUndefined: true })).toEqual({ ok: true });
    expect(parseCodeModeJsonValue(undefined)).toMatchObject({ ok: false });
  });

  test("rejects cycles, sparse arrays, non-finite values, and byte overflow", () => {
    const cycle: CyclicTestValue = {};
    cycle.self = cycle;
    expect(parseCodeModeJsonValue(cycle).ok).toBe(false);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(parseCodeModeJsonValue(sparse).ok).toBe(false);
    expect(parseCodeModeJsonValue(Number.NaN).ok).toBe(false);
    expect(parseCodeModeJsonValue({ text: "12345" }, { maxBytes: 3 }).ok).toBe(false);
  });

  test("accepts strict bounded presentation snapshots without changing public results", () => {
    const presentation = {
      version: 1,
      cell_ordinal: 3,
      cell_state: "completed",
      session_state: "live",
      elapsed_ms: 420,
      active_tool_names: ["read", "grep"],
      active_tool_count: 2,
      nested_tool_count: 3,
      succeeded_nested_tool_count: 2,
      failed_nested_tool_count: 1,
      nested_tools: [
        { name: "read", outcome: "success", elapsed_ms: 120 },
        { name: "grep", outcome: "failed", elapsed_ms: 300 },
      ],
      omitted_nested_tool_count: 1,
      spill_path: "/tmp/pi-codemode/result-spill-1.txt",
    } as const;

    expect(Value.Check(CodeModePresentationSnapshotSchema, presentation)).toBe(true);
    expect(
      Value.Check(CodeModeResultDetailsSchema, {
        ...createCodeModeSuccess("s", { answer: 42 }),
        presentation,
      }),
    ).toBe(true);
    expect(
      Value.Check(CodeModeResultDetailsSchema, {
        ...createCodeModePending("s"),
        presentation: {
          version: 1,
          cell_state: "running",
          session_state: "live",
          elapsed_ms: 0,
          active_tool_names: [],
          active_tool_count: 0,
          nested_tool_count: 0,
          succeeded_nested_tool_count: 0,
          failed_nested_tool_count: 0,
          nested_tools: [],
          omitted_nested_tool_count: 0,
        },
      }),
    ).toBe(true);
    expect(Value.Check(CodeModeResultDetailsSchema, createCodeModePending("historical"))).toBe(
      true,
    );
    expect(Value.Check(CodeModeResultSchema, { ...createCodeModeSuccess("s"), presentation })).toBe(
      false,
    );

    expect(Value.Check(CodeModePresentationSnapshotSchema, { ...presentation, version: 2 })).toBe(
      false,
    );
    expect(
      Value.Check(CodeModePresentationSnapshotSchema, { ...presentation, cell_ordinal: 0 }),
    ).toBe(false);
    expect(
      Value.Check(CodeModePresentationSnapshotSchema, { ...presentation, elapsed_ms: -1 }),
    ).toBe(false);
    expect(
      Value.Check(CodeModePresentationSnapshotSchema, {
        ...presentation,
        active_tool_names: Array.from({ length: 1_000 }, () => "read"),
      }),
    ).toBe(false);
    expect(
      Value.Check(CodeModePresentationSnapshotSchema, {
        ...presentation,
        nested_tools: [{ name: "x".repeat(10_000), outcome: "cancelled", elapsed_ms: 0 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(CodeModePresentationSnapshotSchema, { ...presentation, unexpected: true }),
    ).toBe(false);
  });

  test("builds definitions with byte-stable content and presentation-aware details", async () => {
    const executePresentation = {
      version: 1,
      cell_ordinal: 1,
      cell_state: "running",
      session_state: "live",
      elapsed_ms: 0,
      active_tool_names: [],
      active_tool_count: 0,
      nested_tool_count: 0,
      succeeded_nested_tool_count: 0,
      failed_nested_tool_count: 0,
      nested_tools: [],
      omitted_nested_tool_count: 0,
    } satisfies CodeModePresentationSnapshot;
    const resultPresentation = {
      ...executePresentation,
      cell_state: "completed",
      elapsed_ms: 420,
    } satisfies CodeModePresentationSnapshot;
    const cancelPresentation = {
      ...executePresentation,
      cell_state: "cancelled",
      session_state: "closed",
      elapsed_ms: 7,
    } satisfies CodeModePresentationSnapshot;
    const operations = {
      execute: async () => ({
        result: createCodeModePending("execute-session"),
        presentation: executePresentation,
      }),
      result: async () => ({
        result: createCodeModeSuccess("result-session", { answer: 42 }),
        presentation: resultPresentation,
      }),
      cancel: async () => ({
        result: createCodeModeSuccess("cancel-session"),
        presentation: cancelPresentation,
      }),
    };
    const tools = createCodeModeToolDefinitions(operations);
    expect(tools.map((tool) => tool.name)).toEqual([
      "codemode_execute",
      "codemode_result",
      "codemode_cancel",
    ]);
    expect(tools[0]?.parameters).toBe(CodeModeExecuteParametersSchema);

    const outputs = [];
    const commonInput = { script: "42", sessionId: "s" };
    const unusedContext = Object.create(null);
    for (const tool of tools) {
      outputs.push(
        await tool.execute("tool-call-1", commonInput, undefined, undefined, unusedContext),
      );
    }

    expect(outputs.map((output) => output.content)).toEqual([
      [{ type: "text", text: '{"result":"pending","sessionId":"execute-session"}' }],
      [
        {
          type: "text",
          text: '{"result":"success","sessionId":"result-session","data":{"answer":42}}',
        },
      ],
      [{ type: "text", text: '{"result":"success","sessionId":"cancel-session"}' }],
    ]);
    expect(outputs.map((output) => output.details)).toEqual([
      { ...createCodeModePending("execute-session"), presentation: executePresentation },
      {
        ...createCodeModeSuccess("result-session", { answer: 42 }),
        presentation: resultPresentation,
      },
      { ...createCodeModeSuccess("cancel-session"), presentation: cancelPresentation },
    ]);
    for (const output of outputs) {
      expect(Value.Check(CodeModeResultDetailsSchema, output.details)).toBe(true);
    }
  });
});
