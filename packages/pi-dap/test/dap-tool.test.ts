import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  DapEvaluateInput,
  DapLaunchInput,
  DapSessionResult,
  DapSetBreakpointsInput,
  DapStackInput,
  DapVariablesInput,
} from "../src/dap-session.js";
import { createDapSessionFiles } from "../src/dap-session-files.js";
import {
  DapToolParametersSchema,
  DapToolResultDetailsSchema,
  type DapToolParameters,
} from "../src/dap-tool-contract.js";
import { createDapToolDefinition, type DapToolRuntime } from "../src/dap-tool.js";

const temporaryDirectories: string[] = [];

type RecordedDapInput =
  | DapEvaluateInput
  | DapLaunchInput
  | DapSetBreakpointsInput
  | DapStackInput
  | DapVariablesInput;

interface RecordedCall {
  input?: RecordedDapInput;
  readonly name: string;
  signal?: AbortSignal;
}

class RecordingDapSession {
  readonly calls: RecordedCall[] = [];
  wait: Promise<void> | undefined;
  result: DapSessionResult = {
    snapshot: { state: "idle" },
    output: "",
    discardedOutputBytes: 0,
    desiredBreakpoints: [],
  };

  private async record(
    name: string,
    input?: RecordedDapInput,
    signal?: AbortSignal,
  ): Promise<DapSessionResult> {
    const call: RecordedCall = { name };
    if (input !== undefined) call.input = input;
    if (signal !== undefined) call.signal = signal;
    this.calls.push(call);
    await this.wait;
    return this.result;
  }

  launch(input: DapLaunchInput = {}, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("launch", input, signal);
  }

  setBreakpoints(input: DapSetBreakpointsInput, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("setBreakpoints", input, signal);
  }

  continue(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("continue", undefined, signal);
  }

  next(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("next", undefined, signal);
  }

  stepIn(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("stepIn", undefined, signal);
  }

  stepOut(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("stepOut", undefined, signal);
  }

  pause(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("pause", undefined, signal);
  }

  stack(input: DapStackInput = {}, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("stack", input, signal);
  }

  variables(input: DapVariablesInput, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("variables", input, signal);
  }

  evaluate(input: DapEvaluateInput, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("evaluate", input, signal);
  }

  status(): DapSessionResult {
    this.calls.push({ name: "status" });
    return this.result;
  }

  stop(): Promise<DapSessionResult> {
    return this.record("stop");
  }
}

async function createToolFixture(): Promise<{
  readonly context: ExtensionContext;
  readonly cwd: string;
  readonly runtime: DapToolRuntime;
  readonly session: RecordingDapSession;
}> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-dap-tool-"));
  temporaryDirectories.push(cwd);
  const session = new RecordingDapSession();
  const sessionFiles = await createDapSessionFiles(cwd);
  // SAFETY: Tool execution only observes cwd; this fixture supplies that complete public surface.
  const context = { cwd } as ExtensionContext;
  return { context, cwd, runtime: { session, sessionFiles }, session };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DAP tool contract", () => {
  test("preserves exact ordinary, Debuggee output, and Result Spill text", async () => {
    const fixture = await createToolFixture();
    const tool = createDapToolDefinition(() => fixture.runtime);
    const ordinary = await tool.execute(
      "ordinary",
      { operation: "status" },
      undefined,
      undefined,
      fixture.context,
    );
    expect(ordinary.content).toEqual([
      {
        type: "text",
        text: 'DAP status: {"snapshot":{"state":"idle"},"discardedOutputBytes":0,"desiredBreakpoints":[]}',
      },
    ]);

    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: "debuggee\u001b[31m output\n",
      discardedOutputBytes: 7,
      desiredBreakpoints: [],
    };
    const withOutput = await tool.execute(
      "output",
      { operation: "status" },
      undefined,
      undefined,
      fixture.context,
    );
    expect(withOutput.content).toEqual([
      {
        type: "text",
        text: 'DAP status: {"snapshot":{"state":"running","adapterId":"node","profileId":"node"},"discardedOutputBytes":7,"desiredBreakpoints":[]}\n\nDebuggee output (7 older bytes discarded):\ndebuggee\u001b[31m output\n',
      },
    ]);

    const oversizedOutput = "line\n".repeat(20_000);
    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: oversizedOutput,
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    const raw = `DAP status: {"snapshot":{"state":"running","adapterId":"node","profileId":"node"},"discardedOutputBytes":0,"desiredBreakpoints":[]}\n\nDebuggee output:\n${oversizedOutput}`;
    const truncation = truncateHead(raw, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    const spilled = await tool.execute(
      "spilled",
      { operation: "status" },
      undefined,
      undefined,
      fixture.context,
    );
    if ("kind" in spilled.details) throw new Error("Expected final DAP result details");
    expect(spilled.content).toEqual([
      {
        type: "text",
        text: `${truncation.content}\n\n[Pi DAP: output truncated; complete Result Spill: ${spilled.details.spill_path}]`,
      },
    ]);
  });

  test("publishes immediate one-second progress only for execution waits and clears its timer", async () => {
    vi.useFakeTimers();
    const fixture = await createToolFixture();
    let release: () => void = () => undefined;
    fixture.session.wait = new Promise<void>((resolveWait) => {
      release = resolveWait;
    });
    const tool = createDapToolDefinition(() => fixture.runtime);
    const onUpdate = vi.fn();
    const execution = tool.execute(
      "continue",
      { operation: "continue" },
      undefined,
      onUpdate,
      fixture.context,
    );
    expect(onUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate.mock.calls.map(([update]) => update.details.elapsed_ms)).toEqual([
      0, 1_000, 2_000,
    ]);
    release();
    await execution;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    fixture.session.wait = undefined;
    onUpdate.mockClear();
    await tool.execute("status", { operation: "status" }, undefined, onUpdate, fixture.context);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("marks a cancelled execution wait without changing its final raw text", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    const controller = new AbortController();
    controller.abort();
    const result = await createDapToolDefinition(() => fixture.runtime).execute(
      "cancelled",
      { operation: "continue" },
      controller.signal,
      undefined,
      fixture.context,
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: 'DAP continue: {"snapshot":{"state":"running","adapterId":"node","profileId":"node"},"discardedOutputBytes":0,"desiredBreakpoints":[]}',
      },
    ]);
    expect(result.details).toMatchObject({
      presentation: { kind: "execution_wait", operation: "continue", cancelled: true },
    });
  });

  test("bounds presentation rows and values without bounding the raw result", async () => {
    const fixture = await createToolFixture();
    const longValue = "x".repeat(1_000);
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
      variables: Array.from({ length: 25 }, (_, index) => ({
        name: `value-${index}`,
        value: longValue,
        variablesReference: 0,
      })),
    };
    const result = await createDapToolDefinition(() => fixture.runtime).execute(
      "variables",
      { operation: "variables", variables_reference: 1 },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(longValue) });
    expect(result.details).toMatchObject({
      presentation: {
        kind: "variables",
        rows: expect.arrayContaining([expect.objectContaining({ value: `${"x".repeat(499)}…` })]),
        omitted_count: 5,
      },
    });
    if ("kind" in result.details || result.details.presentation?.kind !== "variables") {
      throw new Error("Expected variables presentation details");
    }
    expect(result.details.presentation.rows).toHaveLength(20);
  });

  test("accepts exactly the twelve operation branches", () => {
    const valid = [
      { operation: "launch", program: "src/app.ts", args: ["one"] },
      { operation: "set_breakpoints", file_path: "src/app.ts", breakpoints: [{ line: 1 }] },
      { operation: "continue" },
      { operation: "next" },
      { operation: "step_in" },
      { operation: "step_out" },
      { operation: "pause" },
      { operation: "stack", start: 0, count: 20 },
      { operation: "variables", frame_id: 1 },
      { operation: "evaluate", expression: "answer" },
      { operation: "status" },
      { operation: "stop" },
    ];

    expect(valid.every((value) => Value.Check(DapToolParametersSchema, value))).toBe(true);
  });

  test("rejects unknown fields and invalid branch-specific arguments", () => {
    expect(Value.Check(DapToolParametersSchema, { operation: "attach" })).toBe(false);
    expect(Value.Check(DapToolParametersSchema, { operation: "continue", thread_id: 1 })).toBe(
      false,
    );
    expect(
      Value.Check(DapToolParametersSchema, {
        operation: "variables",
        frame_id: 1,
        variables_reference: 2,
      }),
    ).toBe(false);
    expect(
      Value.Check(DapToolParametersSchema, {
        operation: "set_breakpoints",
        file_path: "src/app.ts",
        breakpoints: [{ line: 0 }],
      }),
    ).toBe(false);
  });

  test("dispatches all operations, maps paths, forwards cancellation, and validates details", async () => {
    const fixture = await createToolFixture();
    const tool = createDapToolDefinition(() => fixture.runtime);
    const controller = new AbortController();
    const inputs: readonly DapToolParameters[] = [
      {
        operation: "launch",
        profile: "node",
        program: "src/app.ts",
        args: ["one"],
        cwd: "runtime",
      },
      {
        operation: "set_breakpoints",
        file_path: "src/app.ts",
        breakpoints: [{ line: 2, condition: "ready" }],
      },
      { operation: "continue" },
      { operation: "next" },
      { operation: "step_in" },
      { operation: "step_out" },
      { operation: "pause" },
      { operation: "stack", thread_id: 7, start: 1, count: 2 },
      { operation: "variables", frame_id: 9, start: 2, count: 3 },
      { operation: "variables", variables_reference: 11 },
      { operation: "evaluate", expression: "answer", frame_id: 9 },
      { operation: "status" },
      { operation: "stop" },
    ];

    for (const input of inputs) {
      const result = await tool.execute(
        "dap-call",
        input,
        controller.signal,
        undefined,
        fixture.context,
      );
      expect(Value.Check(DapToolResultDetailsSchema, result.details)).toBe(true);
    }

    expect(fixture.session.calls.map(({ name, input }) => ({ name, input }))).toEqual([
      {
        name: "launch",
        input: {
          profile: "node",
          program: resolve(fixture.cwd, "src/app.ts"),
          args: ["one"],
          cwd: resolve(fixture.cwd, "runtime"),
        },
      },
      {
        name: "setBreakpoints",
        input: {
          filePath: resolve(fixture.cwd, "src/app.ts"),
          breakpoints: [{ line: 2, condition: "ready" }],
        },
      },
      { name: "continue", input: undefined },
      { name: "next", input: undefined },
      { name: "stepIn", input: undefined },
      { name: "stepOut", input: undefined },
      { name: "pause", input: undefined },
      { name: "stack", input: { threadId: 7, start: 1, count: 2 } },
      { name: "variables", input: { frameId: 9, start: 2, count: 3 } },
      { name: "variables", input: { variablesReference: 11 } },
      { name: "evaluate", input: { expression: "answer", frameId: 9 } },
      { name: "status", input: undefined },
      { name: "stop", input: undefined },
    ]);
    expect(
      fixture.session.calls
        .filter(({ name }) => name !== "status" && name !== "stop")
        .every(({ signal }) => signal === controller.signal),
    ).toBe(true);
  });

  test("reparses hook-mutated input before effects and spills complete oversized output", async () => {
    const fixture = await createToolFixture();
    const tool = createDapToolDefinition(() => fixture.runtime);
    // SAFETY: Simulates a framework hook adding an invalid field after argument preparation; execute must reparse this runtime value.
    const hookMutatedInput = { operation: "continue", thread_id: 1 } as DapToolParameters;
    await expect(
      tool.execute("invalid", hookMutatedInput, undefined, undefined, fixture.context),
    ).rejects.toThrow("Pi DAP: invalid tool arguments");
    expect(fixture.session.calls).toEqual([]);

    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
        threadId: 7,
      },
      output: "x".repeat(60 * 1024),
      discardedOutputBytes: 12,
      desiredBreakpoints: [],
      stackFrames: [{ id: 42, name: "main", line: 0, column: 0 }],
    };
    const result = await tool.execute(
      "spilled",
      { operation: "status" },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details).toMatchObject({
      operation: "status",
      state: "stopped",
      adapter_id: "node",
      profile_id: "node",
      stop_reason: "breakpoint",
      thread_id: 7,
      stack_frame_ids: [42],
      output_discarded_bytes: 12,
      output_truncated: true,
      spill_path: expect.any(String),
    });
    if ("kind" in result.details) throw new Error("Expected final DAP result details");
    if (result.details.spill_path === undefined) throw new Error("Expected Result Spill path");
    expect(await readFile(result.details.spill_path, "utf8")).toContain("x".repeat(60 * 1024));
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("complete Result Spill"),
    });
  });
});
