import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import {
  CODEMODE_ERROR_CODES,
  CodeModeCancelParametersSchema,
  CodeModeExecuteParametersSchema,
  CodeModeJsonValueSchema,
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

  test("builds definitions with shared details and stable names", () => {
    const operations = {
      execute: async () => ({ result: createCodeModePending("s") }),
      result: async () => ({ result: createCodeModeSuccess("s") }),
      cancel: async () => ({ result: createCodeModeSuccess("s") }),
    };
    const tools = createCodeModeToolDefinitions(operations);
    expect(tools.map((tool) => tool.name)).toEqual([
      "codemode_execute",
      "codemode_result",
      "codemode_cancel",
    ]);
    expect(tools[0]?.parameters).toBe(CodeModeExecuteParametersSchema);
  });
});
