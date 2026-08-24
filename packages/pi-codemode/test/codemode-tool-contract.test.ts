import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import {
  CodeModeCancelParametersSchema,
  CodeModeExecuteParametersSchema,
  CodeModeResultDetailsSchema,
  CodeModeResultParametersSchema,
  CodeModeResultSchema,
  CodeModeSessionsParametersSchema,
  CodeModeSessionsResultSchema,
  createCodeModeFailure,
  createCodeModeSuccess,
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
    expect(Value.Check(CodeModeSessionsParametersSchema, {})).toBe(true);
    expect(Value.Check(CodeModeSessionsParametersSchema, { extra: true })).toBe(false);
  });

  test("accepts Console output only on terminal results", () => {
    const consoleEntries = [
      { method: "log", text: "answer: 42" },
      { method: "warn", text: "first\nsecond" },
    ] as const;
    const success = createCodeModeSuccess("s", 42, consoleEntries);
    const failed = createCodeModeFailure("s", "script", "failed", consoleEntries);

    expect(Value.Check(CodeModeResultSchema, success)).toBe(true);
    expect(Value.Check(CodeModeResultDetailsSchema, success)).toBe(true);
    expect(Value.Check(CodeModeResultSchema, failed)).toBe(true);
    expect(Value.Check(CodeModeResultDetailsSchema, failed)).toBe(true);
    expect(createCodeModeSuccess("s", 42, [])).toEqual({
      result: "success",
      sessionId: "s",
      data: 42,
    });
    expect(createCodeModeFailure("s", "script", "failed", [])).toEqual({
      result: "failed",
      sessionId: "s",
      error: { code: "script", message: "failed" },
    });

    for (const malformed of [
      { result: "success", sessionId: "s", console: [{ method: "trace", text: "x" }] },
      { result: "success", sessionId: "s", console: [{ method: "log" }] },
      {
        result: "failed",
        sessionId: "s",
        error: { code: "script", message: "failed" },
        console: [{ method: "log", text: "x", extra: true }],
      },
      { result: "pending", sessionId: "s", console: consoleEntries },
      { result: "success", sessions: [], console: consoleEntries },
    ]) {
      expect(Value.Check(CodeModeResultSchema, malformed)).toBe(false);
      expect(Value.Check(CodeModeResultDetailsSchema, malformed)).toBe(false);
      expect(Value.Check(CodeModeSessionsResultSchema, malformed)).toBe(false);
    }
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

  test("rejects cycles, sparse/accessor arrays, symbols, functions, hostile proxies, non-finite values, and byte overflow", () => {
    const cycle: CyclicTestValue = {};
    cycle.self = cycle;
    expect(parseCodeModeJsonValue(cycle).ok).toBe(false);

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(parseCodeModeJsonValue(sparse).ok).toBe(false);

    const accessorArray = [1];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => 1 });
    expect(parseCodeModeJsonValue(accessorArray).ok).toBe(false);
    expect(parseCodeModeJsonValue({ [Symbol("hidden")]: true }).ok).toBe(false);
    expect(parseCodeModeJsonValue(() => undefined).ok).toBe(false);
    expect(parseCodeModeJsonValue(Number.NaN).ok).toBe(false);
    expect(parseCodeModeJsonValue(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(
      parseCodeModeJsonValue(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("hostile");
            },
          },
        ),
      ).ok,
    ).toBe(false);
    expect(parseCodeModeJsonValue({ text: "12345" }, { maxBytes: 3 }).ok).toBe(false);
  });

  test("normalizes nested undefined exactly for JSON transport", () => {
    expect(
      parseCodeModeJsonValue(
        { omitted: undefined, retained: [undefined, { omitted: undefined, value: 1 }] },
        { normalizeUndefinedForJsonTransport: true },
      ),
    ).toEqual({ ok: true, value: { retained: [null, { value: 1 }] } });
    expect(parseCodeModeJsonValue({ nested: undefined }, { allowUndefined: true }).ok).toBe(false);
  });
});
