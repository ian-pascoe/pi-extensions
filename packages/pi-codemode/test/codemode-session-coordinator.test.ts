import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
  CodeModeSessionCoordinator,
  type CodeModeNestedToolBatch,
  type CodeModeNestedToolBatchResult,
  type CodeModeObserverSnapshot,
  type CodeModeSessionCoordinatorOptions,
  type CodeModeSessionOperationResult,
  type CodeModeUnexpectedFailure,
} from "../src/codemode-session-coordinator.js";
import { CODEMODE_SYSTEM_RUNTIME, type CodeModeRuntime } from "../src/codemode-runtime.js";
import {
  CodeModeResultDetailsSchema,
  type CodeModeJsonValue,
} from "../src/codemode-tool-contract.js";

const coordinators = new Set<CodeModeSessionCoordinator>();

function createUsage(value: number): Usage {
  return {
    input: value,
    output: value,
    cacheRead: value,
    cacheWrite: value,
    totalTokens: value * 4,
    cost: {
      input: value,
      output: value,
      cacheRead: value,
      cacheWrite: value,
      total: value * 4,
    },
  };
}

function createCoordinator(
  options: {
    readonly maxSessions?: number;
    readonly ids?: readonly string[];
    readonly toolNames?: readonly string[];
    readonly runtime?: CodeModeRuntime;
    readonly now?: () => number;
    readonly writeResultSpill?: (output: string) => {
      readonly path: string;
      readonly completion: Promise<void>;
    };
    readonly executeToolBatch?: (
      batch: CodeModeNestedToolBatch,
    ) => Promise<CodeModeNestedToolBatchResult>;
    readonly onSnapshotChange?: (snapshot: CodeModeObserverSnapshot) => void;
    readonly onUnexpectedFailure?: (failure: CodeModeUnexpectedFailure) => void;
  } = {},
): CodeModeSessionCoordinator {
  const ids = [...(options.ids ?? ["session-1"])];
  let idIndex = 0;
  const coordinatorOptions: CodeModeSessionCoordinatorOptions = {
    maxSessions: options.maxSessions ?? 8,
    getToolNames: () => options.toolNames ?? [],
    executeToolBatch:
      options.executeToolBatch ??
      (async (batch) => ({
        results: batch.calls.map((call) => ({
          callId: call.callId,
          outcome: "success" as const,
          result: { input: call.input },
        })),
      })),
    runtime: options.runtime ?? {
      ...CODEMODE_SYSTEM_RUNTIME,
      createSessionId: () => ids[idIndex++] ?? `session-${idIndex}`,
      now: options.now ?? CODEMODE_SYSTEM_RUNTIME.now,
    },
    resultSpillWriter: {
      writeResultSpill:
        options.writeResultSpill ??
        (() => ({
          path: "/tmp/pi-codemode-test-result-spill.txt",
          completion: Promise.resolve(),
        })),
    },
  };
  if (options.onSnapshotChange !== undefined) {
    Object.assign(coordinatorOptions, { onSnapshotChange: options.onSnapshotChange });
  }
  if (options.onUnexpectedFailure !== undefined) {
    Object.assign(coordinatorOptions, { onUnexpectedFailure: options.onUnexpectedFailure });
  }
  const coordinator = new CodeModeSessionCoordinator(coordinatorOptions);
  coordinators.add(coordinator);
  return coordinator;
}

async function pollTerminal(
  coordinator: CodeModeSessionCoordinator,
  sessionId: string,
): Promise<CodeModeSessionOperationResult> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = coordinator.result(sessionId);
    if (result.result.result !== "pending") return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`CodeMode coordinator test: ${sessionId} did not settle`);
}

function expectSuccessData(
  result: CodeModeSessionOperationResult,
  expected: CodeModeJsonValue,
): void {
  expect(result.result, JSON.stringify(result.result)).toMatchObject({
    result: "success",
    data: expected,
  });
}

afterEach(async () => {
  await Promise.all([...coordinators].map((coordinator) => coordinator.shutdown("test cleanup")));
  coordinators.clear();
});

describe("CodeModeSessionCoordinator", () => {
  test("observes immutable per-Session Cell ordinals across reusable settlement", async () => {
    let nowMs = 1_000;
    const publishedSnapshots: CodeModeObserverSnapshot[] = [];
    const coordinator = createCoordinator({
      now: () => nowMs,
      onSnapshotChange: (snapshot) => publishedSnapshots.push(snapshot),
    });

    expectSuccessData(await coordinator.execute({ script: "40 + 2", wait: true }), 42);
    expect(coordinator.inspectObserverSnapshot()).toEqual({
      sessions: [
        {
          sessionId: "session-1",
          lifecycle: "idle",
          cell_count: 1,
          last_activity_at_ms: 1_000,
          last_cell: {
            ordinal: 1,
            started_at_ms: 1_000,
            settled_at_ms: 1_000,
            state: "completed",
            nested_tool_count: 0,
          },
        },
      ],
    });

    nowMs = 2_500;
    const failed = await coordinator.execute({
      script: "let =",
      sessionId: "session-1",
      wait: true,
    });
    expect(failed.result).toMatchObject({ result: "failed", error: { code: "script" } });
    const snapshot = coordinator.inspectObserverSnapshot();
    expect(snapshot).toEqual({
      sessions: [
        {
          sessionId: "session-1",
          lifecycle: "idle",
          cell_count: 2,
          last_activity_at_ms: 2_500,
          last_cell: {
            ordinal: 2,
            started_at_ms: 2_500,
            settled_at_ms: 2_500,
            state: "failed",
            error_code: "script",
            nested_tool_count: 0,
          },
        },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions[0])).toBe(true);
    expect(Object.isFrozen(snapshot.sessions[0]?.last_cell)).toBe(true);
    expect(publishedSnapshots.at(-1)).toEqual(snapshot);
  }, 30_000);

  test("isolates non-authoritative Observer callback defects from Cell execution", async () => {
    const coordinator = createCoordinator({
      onSnapshotChange: () => {
        throw new Error("observer render failed");
      },
    });

    expectSuccessData(await coordinator.execute({ script: "6 * 7" }), 42);
  }, 30_000);

  test("isolates non-authoritative progress callback defects from Cell execution", async () => {
    const coordinator = createCoordinator();

    expectSuccessData(
      await coordinator.execute({ script: "6 * 7" }, undefined, () => {
        throw new Error("progress render failed");
      }),
      42,
    );
  }, 30_000);

  test("formats the shortest currently unique Transcript Session prefixes", async () => {
    const coordinator = createCoordinator({
      ids: ["aaaaaaaa-1111", "aaaaaaaa-2222"],
    });
    await coordinator.execute({ script: "1" });
    await coordinator.execute({ script: "2" });

    expect(coordinator.formatSessionPrefix("aaaaaaaa-1111")).toBe("aaaaaaaa-1");
    expect(coordinator.formatSessionPrefix("aaaaaaaa-2222")).toBe("aaaaaaaa-2");
    expect(coordinator.formatSessionPrefix("historical-session")).toBe("historical-session");
  }, 30_000);

  test("observes active unique nested tool names, active call count, and total calls", async () => {
    const batchStarted = Promise.withResolvers<void>();
    const releaseBatch = Promise.withResolvers<void>();
    const coordinator = createCoordinator({
      now: () => 5_000,
      toolNames: ["read", "grep"],
      executeToolBatch: async (batch) => {
        batchStarted.resolve();
        await releaseBatch.promise;
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            result: null,
          })),
        };
      },
    });

    const pending = await coordinator.execute({
      script: "await Promise.all([tools.read({}), tools.read({}), tools.grep({})])",
      wait: false,
    });
    await batchStarted.promise;

    expect(coordinator.inspectObserverSnapshot()).toMatchObject({
      sessions: [
        {
          lifecycle: "running",
          cell_count: 1,
          current_cell: {
            ordinal: 1,
            started_at_ms: 5_000,
            active_tool_names: ["read", "grep"],
            active_tool_count: 3,
            nested_tool_count: 3,
          },
        },
      ],
    });

    releaseBatch.resolve();
    expectSuccessData(await pollTerminal(coordinator, pending.result.sessionId), [
      null,
      null,
      null,
    ]);
    expect(coordinator.inspectObserverSnapshot()).toMatchObject({
      sessions: [
        {
          lifecycle: "idle",
          last_cell: { ordinal: 1, state: "completed", nested_tool_count: 3 },
        },
      ],
    });
  }, 30_000);

  test.skipIf(process.platform !== "linux")(
    "reports an idle worker death exactly once",
    async () => {
      const unexpectedFailures: CodeModeUnexpectedFailure[] = [];
      const idleFailureObserved = Promise.withResolvers<void>();
      const coordinator = createCoordinator({
        toolNames: ["crashLater"],
        onUnexpectedFailure: (failure) => {
          unexpectedFailures.push(failure);
          idleFailureObserved.resolve();
        },
        executeToolBatch: async (batch) => {
          const children = await readFile(
            `/proc/${process.pid}/task/${process.pid}/children`,
            "utf8",
          );
          const workerPid = Number(children.trim().split(/\s+/).at(-1));
          setTimeout(() => process.kill(workerPid, "SIGKILL"), 50);
          return {
            results: batch.calls.map((call) => ({
              callId: call.callId,
              outcome: "success" as const,
              result: null,
            })),
          };
        },
      });

      expectSuccessData(
        await coordinator.execute({ script: "await tools.crashLater({}); 42" }),
        42,
      );
      await Promise.race([
        idleFailureObserved.promise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("CodeMode coordinator test: idle worker stayed alive")),
            5_000,
          ),
        ),
      ]);
      expect(unexpectedFailures).toHaveLength(1);
      expect(unexpectedFailures[0]).toMatchObject({ sessionId: "session-1" });
      expect(Object.isFrozen(unexpectedFailures[0])).toBe(true);
      expect(coordinator.inspectObserverSnapshot()).toMatchObject({
        sessions: [
          {
            lifecycle: "terminal",
            terminal_error_code: "runtime",
            last_cell: { ordinal: 1, state: "completed" },
          },
        ],
      });
    },
    30_000,
  );

  test.skipIf(process.platform !== "linux")(
    "does not report an active worker death represented by its Cell result",
    async () => {
      const representedFailures: CodeModeUnexpectedFailure[] = [];
      const coordinator = createCoordinator({
        toolNames: ["crashNow"],
        onUnexpectedFailure: (failure) => representedFailures.push(failure),
        executeToolBatch: async () => {
          const children = await readFile(
            `/proc/${process.pid}/task/${process.pid}/children`,
            "utf8",
          );
          const workerPid = Number(children.trim().split(/\s+/).at(-1));
          process.kill(workerPid, "SIGKILL");
          return new Promise(() => {});
        },
      });

      const represented = await coordinator.execute({ script: "await tools.crashNow({})" });

      expect(represented.result).toMatchObject({ result: "failed", error: { code: "runtime" } });
      expect(representedFailures).toEqual([]);
      expect(coordinator.inspectObserverSnapshot()).toMatchObject({
        sessions: [
          {
            lifecycle: "terminal",
            terminal_error_code: "runtime",
            last_cell: { ordinal: 1, state: "failed", error_code: "runtime" },
          },
        ],
      });
    },
    30_000,
  );

  test("runs create, deterministic pending/poll, one nested tool, reuse, and shutdown", async () => {
    const recordedBatches: string[][] = [];
    const coordinator = createCoordinator({
      toolNames: ["add"],
      executeToolBatch: async (batch) => {
        recordedBatches.push(batch.calls.map((call) => call.toolName));
        return {
          results: batch.calls.map((call) => {
            // SAFETY: The real guest Cell in this test submits exactly this two-number JSON object.
            const input = call.input as { readonly left: number; readonly right: number };
            return {
              callId: call.callId,
              outcome: "success" as const,
              result: { value: input.left + input.right },
            };
          }),
        };
      },
    });

    const pending = await coordinator.execute({
      script:
        "type Added = { value: number }; let added: Added = await tools.add({ left: 20, right: 22 }); added.value",
      wait: false,
    });
    expect(pending.result).toEqual({ result: "pending", sessionId: "session-1" });

    expectSuccessData(await pollTerminal(coordinator, "session-1"), 42);
    expectSuccessData(
      await coordinator.execute({
        script: "added.value += 1; added.value",
        sessionId: "session-1",
        wait: true,
      }),
      43,
    );
    expect(recordedBatches).toEqual([["add"]]);

    await coordinator.shutdown("vertical tracer complete");
  }, 30_000);

  test("awaits a Cell when wait is omitted", async () => {
    const coordinator = createCoordinator();

    expectSuccessData(await coordinator.execute({ script: "6 * 7" }), 42);
  }, 30_000);

  test("retains bounded Cell presentation, publishes progress, and spills complete large data", async () => {
    const spills: string[] = [];
    const updates: AgentToolResult<unknown>[] = [];
    const coordinator = createCoordinator({
      toolNames: ["echo"],
      writeResultSpill: (output) => {
        spills.push(output);
        return {
          path: "/tmp/pi-codemode-test-result-spill.txt",
          completion: Promise.resolve(),
        };
      },
    });

    const composed = await coordinator.execute(
      {
        script: "await tools.echo({ value: 42 }); ({ answer: 42 })",
        wait: true,
      },
      undefined,
      (update) => updates.push(update),
    );

    expect(composed.presentation).toMatchObject({
      version: 1,
      cell_ordinal: 1,
      cell_state: "completed",
      session_state: "live",
      nested_tool_count: 1,
      succeeded_nested_tool_count: 1,
      failed_nested_tool_count: 0,
      nested_tools: [{ name: "echo", outcome: "success", elapsed_ms: 0 }],
    });
    expect(updates[0]?.details).toMatchObject({
      result: "pending",
      presentation: { cell_ordinal: 1, cell_state: "running" },
    });
    expect(coordinator.result("session-1").presentation).toEqual(composed.presentation);

    const large = await coordinator.execute({
      script: '"x".repeat(60 * 1024)',
      sessionId: "session-1",
      wait: true,
    });
    expect(large.presentation).toMatchObject({
      cell_ordinal: 2,
      spill_path: "/tmp/pi-codemode-test-result-spill.txt",
    });
    expect(spills).toHaveLength(1);
    expect(spills[0]).toBe(JSON.stringify("x".repeat(60 * 1024), undefined, 2));
  }, 30_000);

  test("publishes awaited Cell progress once per second", async () => {
    const elapsedValues: number[] = [];
    const coordinator = createCoordinator({
      toolNames: ["slow"],
      executeToolBatch: async (batch) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_050));
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            result: null,
          })),
        };
      },
    });

    await coordinator.execute(
      { script: "await tools.slow({})", wait: true },
      undefined,
      (update) => {
        const details = update.details;
        if (Value.Check(CodeModeResultDetailsSchema, details)) {
          elapsedValues.push(details.presentation?.elapsed_ms ?? -1);
        }
      },
    );

    expect(elapsedValues[0]).toBeGreaterThanOrEqual(0);
    expect(elapsedValues.some((elapsedMs) => elapsedMs >= 1_000)).toBe(true);
  }, 30_000);

  test("does not delay a completed Cell for presentation-only Result Spill I/O", async () => {
    const pendingWrite = Promise.withResolvers<void>();
    const coordinator = createCoordinator({
      writeResultSpill: () => ({
        path: "/tmp/pending-result-spill.txt",
        completion: pendingWrite.promise,
      }),
    });

    const result = await coordinator.execute({ script: '"x".repeat(60 * 1024)' });

    expect(result.result).toMatchObject({ result: "success" });
    expect(result.presentation?.spill_path).toBe("/tmp/pending-result-spill.txt");
  }, 30_000);

  test("runs native TypeScript in Deno without dynamic-code or host-process capabilities", async () => {
    const coordinator = createCoordinator();

    const result = await coordinator.execute({
      script: `
        interface RuntimeIdentity { deno: string; typescript: string }
        const identity: RuntimeIdentity = Deno.version;
        ({
          deno: identity.deno,
          typescript: identity.typescript,
          process: typeof process,
          console: typeof console,
          alert: typeof alert,
          confirm: typeof confirm,
          prompt: typeof prompt,
          worker: typeof Worker,
          timer: typeof setTimeout,
          evaluate: typeof eval,
          construct: typeof Function,
          webAssembly: typeof WebAssembly,
          shadowRealm: typeof ShadowRealm,
          functionConstructor: typeof (() => 1).constructor,
          asyncFunctionConstructor: typeof Object.getPrototypeOf(async () => 1).constructor,
          runtimePrimordialsFrozen: [
            Array.prototype,
            String.prototype,
            Promise.prototype,
            Uint8Array.prototype,
          ].every(Object.isFrozen),
        })
      `,
    });

    expectSuccessData(result, {
      deno: "2.9.5",
      typescript: "6.0.3",
      process: "undefined",
      console: "undefined",
      alert: "undefined",
      confirm: "undefined",
      prompt: "undefined",
      worker: "undefined",
      timer: "undefined",
      evaluate: "undefined",
      construct: "undefined",
      webAssembly: "undefined",
      shadowRealm: "undefined",
      functionConstructor: "undefined",
      asyncFunctionConstructor: "undefined",
      runtimePrimordialsFrozen: true,
    });
  }, 30_000);

  test("settles startup timers when a Session is cancelled before its worker is ready", async () => {
    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    const runtime: CodeModeRuntime = {
      createSessionId: () => "starting-session",
      now: CODEMODE_SYSTEM_RUNTIME.now,
      setTimeout(callback, delayMs) {
        const handle = setTimeout(() => {
          activeTimers.delete(handle);
          callback();
        }, delayMs);
        activeTimers.add(handle);
        return handle;
      },
      clearTimeout(handle) {
        activeTimers.delete(handle);
        clearTimeout(handle);
      },
    };
    const coordinator = createCoordinator({ runtime });

    await coordinator.execute({ script: "42", wait: false });
    await coordinator.cancel("starting-session");
    await coordinator.shutdown("startup cancellation test");

    expect(activeTimers.size).toBe(0);
  }, 30_000);

  test("rejects malformed external Session IDs without constructing a branded ID", async () => {
    const coordinator = createCoordinator();

    expect(coordinator.result("").result).toEqual({
      result: "failed",
      sessionId: "invalid-session-id",
      error: { code: "unknown", message: "Invalid CodeMode Session ID" },
    });
    expect((await coordinator.cancel("")).result).toEqual({
      result: "failed",
      sessionId: "invalid-session-id",
      error: { code: "unknown", message: "Invalid CodeMode Session ID" },
    });
    expect((await coordinator.execute({ script: "42", sessionId: "" })).result).toEqual({
      result: "failed",
      sessionId: "invalid-session-id",
      error: { code: "unknown", message: "Invalid CodeMode Session ID" },
    });
  });

  test("preserves Notebook Bindings and reusable failures across real Deno Cells", async () => {
    const coordinator = createCoordinator();
    const first = await coordinator.execute({
      script: `
        globalThis.outside = 3;
        let value = 4;
        const { nested: [other] } = { nested: [5] };
        function read() { return value + other + globalThis.outside; }
        class Box { read() { return read(); } }
        new Box().read()
      `,
      wait: true,
    });
    expectSuccessData(first, 12);

    expectSuccessData(
      await coordinator.execute({
        script: "value = 10; read()",
        sessionId: "session-1",
        wait: true,
      }),
      18,
    );
    expectSuccessData(
      await coordinator.execute({
        script: "const value = 20; read()",
        sessionId: "session-1",
        wait: true,
      }),
      28,
    );

    const failedRedefinition = await coordinator.execute({
      script: 'let value = (() => { throw new Error("initializer failed"); })()',
      sessionId: "session-1",
      wait: true,
    });
    expect(failedRedefinition.result).toMatchObject({
      result: "failed",
      error: { code: "script" },
    });
    expectSuccessData(
      await coordinator.execute({ script: "read()", sessionId: "session-1", wait: true }),
      28,
    );

    const mutationThenFailure = await coordinator.execute({
      script: 'let value = 21; globalThis.outside = 4; throw new Error("after mutation")',
      sessionId: "session-1",
      wait: true,
    });
    expect(mutationThenFailure.result).toMatchObject({
      result: "failed",
      error: { code: "script" },
    });
    expectSuccessData(
      await coordinator.execute({ script: "read()", sessionId: "session-1", wait: true }),
      30,
    );

    const thrownUndefined = await coordinator.execute({
      script: "throw undefined",
      sessionId: "session-1",
      wait: true,
    });
    expect(thrownUndefined.result).toMatchObject({
      result: "failed",
      error: { code: "script" },
    });

    const hostileThrownValue = await coordinator.execute({
      script: `
        throw new Proxy({}, {
          getOwnPropertyDescriptor() { throw new Error("descriptor trap"); },
          getPrototypeOf() { throw new Error("prototype trap"); },
        })
      `,
      sessionId: "session-1",
      wait: true,
    });
    expect(hostileThrownValue.result).toMatchObject({
      result: "failed",
      error: { code: "script", message: "Error: CodeMode Cell threw an unreadable value" },
    });

    const forgedSerializationName = await coordinator.execute({
      script: 'throw { name: "CodeModeSerializationError", message: "forged" }',
      sessionId: "session-1",
      wait: true,
    });
    expect(forgedSerializationName.result).toMatchObject({
      result: "failed",
      error: { code: "script" },
    });
  }, 30_000);

  test("groups one job drain, then drains chained and detached tool calls to a fixed point", async () => {
    const batches: number[][] = [];
    const coordinator = createCoordinator({
      toolNames: ["record"],
      executeToolBatch: async (batch) => {
        const values = batch.calls.map((call) => {
          // SAFETY: The real guest Cell in this test submits exactly this one-number JSON object.
          const input = call.input as { readonly value: number };
          return input.value;
        });
        batches.push(values);
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            result: call.input,
          })),
        };
      },
    });

    const result = await coordinator.execute({
      script: `
        const pair = await Promise.all([
          tools.record({ value: 1 }),
          tools.record({ value: 2 }),
        ]);
        tools.record({ value: 3 }).then(() => tools.record({ value: 4 }));
        pair.map((item) => item.value)
      `,
      wait: true,
    });

    expectSuccessData(result, [1, 2]);
    expect(batches).toEqual([[1, 2], [3], [4]]);
  }, 30_000);

  test("rejects hostile guest JSON without invoking accessors and recovers", async () => {
    let parentGetterCalled = false;
    const hostileParentResult = {};
    Object.defineProperty(hostileParentResult, "value", {
      enumerable: true,
      get() {
        parentGetterCalled = true;
        return 1;
      },
    });
    let callbackCalls = 0;
    const coordinator = createCoordinator({
      toolNames: ["hostile"],
      executeToolBatch: async (batch) => {
        callbackCalls += batch.calls.length;
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            // SAFETY: This deliberately violates the callback contract to exercise the hostile parent boundary.
            result: hostileParentResult as never,
          })),
        };
      },
    });

    const guestAccessor = await coordinator.execute({
      script: `
        globalThis.getterCalls = 0;
        const hostile = {};
        Object.defineProperty(hostile, "value", {
          enumerable: true,
          get() { globalThis.getterCalls += 1; return 1; },
        });
        await tools.hostile(hostile)
      `,
      wait: true,
    });
    expect(guestAccessor.result).toMatchObject({
      result: "failed",
      error: { code: "serialization" },
    });
    expect(callbackCalls).toBe(0);
    expectSuccessData(
      await coordinator.execute({
        script: "globalThis.getterCalls",
        sessionId: "session-1",
        wait: true,
      }),
      0,
    );

    const caughtParentFailure = await coordinator.execute({
      script: `
        try { await tools.hostile({}); }
        catch (error) { return { name: error.name, code: error.code }; }
      `,
      sessionId: "session-1",
      wait: true,
    });
    expectSuccessData(caughtParentFailure, { name: "CodeModeToolError", code: "serialization" });
    expect(parentGetterCalled).toBe(false);

    for (const script of [
      "const value = {}; value.self = value; value",
      "42n",
      "Symbol('nope')",
      "function nope() {} nope",
      "({ value: Promise.resolve(1) })",
      "Number.NaN",
      "const sparse = []; sparse.length = 1; sparse",
    ]) {
      const result = await coordinator.execute({ script, sessionId: "session-1", wait: true });
      expect(result.result, script).toMatchObject({
        result: "failed",
        error: { code: "serialization" },
      });
    }
    expectSuccessData(
      await coordinator.execute({ script: "6 * 7", sessionId: "session-1", wait: true }),
      42,
    );
  }, 30_000);

  test("refreshes exact dynamic tool keys while saved functions remain parent-rechecked", async () => {
    const currentToolNames = ["visible", "removed"];
    const coordinator = createCoordinator({
      toolNames: currentToolNames,
      executeToolBatch: async (batch) => ({
        results: batch.calls.map((call) =>
          currentToolNames.includes(call.toolName)
            ? { callId: call.callId, outcome: "success" as const, result: call.toolName }
            : {
                callId: call.callId,
                outcome: "error" as const,
                error: { code: "unavailable", message: "Tool is no longer exposed" },
              },
        ),
      }),
    });

    expectSuccessData(
      await coordinator.execute({
        script: "let savedRemoved = tools.removed; Object.keys(tools)",
        wait: true,
      }),
      ["visible", "removed"],
    );
    currentToolNames.splice(1, 1);
    const refreshed = await coordinator.execute({
      script: `
        let savedCode;
        try { await savedRemoved({}); } catch (error) { savedCode = error.code; }
        ({ keys: Object.keys(tools), savedCode, recursive: typeof tools.codemode_execute })
      `,
      sessionId: "session-1",
      wait: true,
    });
    expectSuccessData(refreshed, {
      keys: ["visible"],
      savedCode: "unavailable",
      recursive: "undefined",
    });
  }, 30_000);

  test("bounds oversized JSON in both directions and keeps serialization failures reusable", async () => {
    let callbackCalls = 0;
    const oversized = "x".repeat(8 * 1024 * 1024);
    const protocolExpanded = '"'.repeat(3 * 1024 * 1024);
    const coordinator = createCoordinator({
      toolNames: ["large"],
      executeToolBatch: async (batch) => {
        callbackCalls += batch.calls.length;
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            result: callbackCalls === 2 ? protocolExpanded : oversized,
          })),
        };
      },
    });

    const guestResult = await coordinator.execute({
      script: '"x".repeat(8 * 1024 * 1024)',
      wait: true,
    });
    expect(guestResult.result).toMatchObject({
      result: "failed",
      error: { code: "serialization" },
    });

    const guestInput = await coordinator.execute({
      script: 'await tools.large("x".repeat(8 * 1024 * 1024))',
      sessionId: "session-1",
      wait: true,
    });
    expect(guestInput.result).toMatchObject({ result: "failed", error: { code: "serialization" } });
    expect(callbackCalls).toBe(0);

    const parentResult = await coordinator.execute({
      script: `
        try { await tools.large({}); }
        catch (error) { return error.code; }
      `,
      sessionId: "session-1",
      wait: true,
    });
    expectSuccessData(parentResult, "serialization");
    const expandedParentResult = await coordinator.execute({
      script: `
        try { await tools.large({ expanded: true }); }
        catch (error) { return error.code; }
      `,
      sessionId: "session-1",
      wait: true,
    });
    expectSuccessData(expandedParentResult, "serialization");
    expect(callbackCalls).toBe(2);
    expectSuccessData(
      await coordinator.execute({ script: "42", sessionId: "session-1", wait: true }),
      42,
    );
  }, 30_000);

  test("returns pending before a syntax failure and retains repeated polling", async () => {
    const coordinator = createCoordinator();
    const pending = await coordinator.execute({ script: "let =", wait: false });
    expect(pending.result).toEqual({ result: "pending", sessionId: "session-1" });
    const failed = await pollTerminal(coordinator, "session-1");
    expect(failed.result).toMatchObject({ result: "failed", error: { code: "script" } });
    expect(coordinator.result("session-1").result).toEqual(failed.result);
    expectSuccessData(
      await coordinator.execute({ script: "42", sessionId: "session-1", wait: true }),
      42,
    );
  }, 30_000);

  test("makes timeout and outer abort fatal while quarantining late parent settlement and updates", async () => {
    const slowToolStarted = Promise.withResolvers<void>();
    const slowToolReleased = Promise.withResolvers<void>();
    const updates: string[] = [];
    const coordinator = createCoordinator({
      toolNames: ["slow"],
      executeToolBatch: async (batch) => {
        batch.onUpdate?.({ content: [{ type: "text", text: "started" }], details: {} });
        slowToolStarted.resolve();
        await slowToolReleased.promise;
        batch.onUpdate?.({ content: [{ type: "text", text: "late" }], details: {} });
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            result: null,
          })),
        };
      },
    });

    const timedOutPromise = coordinator.execute(
      { script: "await tools.slow({})", wait: true, timeoutMs: 30 },
      undefined,
      (update) =>
        updates.push(update.content[0]?.type === "text" ? update.content[0].text : "other"),
    );
    await slowToolStarted.promise;
    const timedOut = await timedOutPromise;
    expect(timedOut.result).toMatchObject({ result: "failed", error: { code: "timeout" } });
    slowToolReleased.resolve();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(updates).toEqual([
      '{"result":"pending","sessionId":"session-1"}',
      '{"result":"pending","sessionId":"session-1"}',
    ]);
    expect(
      (await coordinator.execute({ script: "1", sessionId: "session-1", wait: true })).result,
    ).toEqual(timedOut.result);

    const abortController = new AbortController();
    const abortCoordinator = createCoordinator({
      ids: ["abort-session"],
      toolNames: ["slow"],
      executeToolBatch: async () => new Promise(() => {}),
    });
    const abortedPromise = abortCoordinator.execute(
      { script: "await tools.slow({})", wait: true },
      abortController.signal,
    );
    setTimeout(() => abortController.abort(), 30);
    const aborted = await abortedPromise;
    expect(aborted.result).toMatchObject({ result: "failed", error: { code: "cancellation" } });
  }, 30_000);

  test("classifies a synchronous infinite loop as fatal timeout", async () => {
    const coordinator = createCoordinator();
    const result = await coordinator.execute({
      script: "while (true) {}",
      timeoutMs: 20,
      wait: true,
    });
    expect(result.result).toMatchObject({ result: "failed", error: { code: "timeout" } });
    expect(
      (await coordinator.execute({ script: "42", sessionId: "session-1", wait: true })).result,
    ).toEqual(result.result);
  }, 30_000);

  test("enforces busy, unknown, capacity, cancellation, and the 64-record terminal LRU", async () => {
    const toolStarted = Promise.withResolvers<void>();
    const toolReleased = Promise.withResolvers<void>();
    const ids = Array.from({ length: 80 }, (_, index) => `session-${index + 1}`);
    const coordinator = createCoordinator({
      maxSessions: 1,
      ids,
      toolNames: ["slow"],
      executeToolBatch: async (batch) => {
        toolStarted.resolve();
        await toolReleased.promise;
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            result: null,
          })),
        };
      },
    });

    expect(
      (await coordinator.execute({ script: "await tools.slow({})", wait: false })).result.result,
    ).toBe("pending");
    await toolStarted.promise;
    expect(
      (await coordinator.execute({ script: "1", sessionId: "session-1" })).result,
    ).toMatchObject({ result: "failed", error: { code: "busy" } });
    expect(coordinator.result("missing").result).toMatchObject({
      result: "failed",
      error: { code: "unknown" },
    });

    for (let index = 2; index <= 67; index += 1) {
      const result = await coordinator.execute({ script: "1" });
      expect(result.result).toMatchObject({
        result: "failed",
        sessionId: `session-${index}`,
        error: { code: "capacity" },
      });
    }
    expect(coordinator.result("session-2").result).toMatchObject({
      result: "failed",
      error: { code: "unknown" },
    });
    expect(coordinator.result("session-67").result).toMatchObject({
      result: "failed",
      error: { code: "capacity" },
    });

    const cancelled = await coordinator.cancel("session-1");
    expect(cancelled.result).toEqual({ result: "success", sessionId: "session-1" });
    expect(coordinator.result("session-1").result).toMatchObject({
      result: "failed",
      error: { code: "cancellation" },
    });
    toolReleased.resolve();
  }, 30_000);

  test("returns aggregate usage, added names, and termination metadata exactly once", async () => {
    let batchNumber = 0;
    const coordinator = createCoordinator({
      toolNames: ["step"],
      executeToolBatch: async (batch) => {
        batchNumber += 1;
        return {
          results: batch.calls.map((call) => ({
            callId: call.callId,
            outcome: "success" as const,
            result: null,
          })),
          usage: createUsage(batchNumber),
          addedToolNames: ["dynamic", "dynamic"],
        };
      },
    });
    const pending = await coordinator.execute({
      script: "await tools.step({}); await tools.step({}); 42",
      wait: false,
    });
    expect(pending.metadata).toBeUndefined();
    const terminal = await pollTerminal(coordinator, "session-1");
    expectSuccessData(terminal, 42);
    expect(terminal.metadata).toEqual({
      usage: createUsage(3),
      addedToolNames: ["dynamic"],
    });
    expect(coordinator.result("session-1").metadata).toBeUndefined();

    const terminatingCoordinator = createCoordinator({
      ids: ["terminated"],
      toolNames: ["stop"],
      executeToolBatch: async () => ({
        results: [],
        usage: createUsage(1),
        terminate: true,
      }),
    });
    const terminated = await terminatingCoordinator.execute({
      script: "try { await tools.stop({}); } catch { return 'caught'; }",
      wait: true,
    });
    expect(terminated.result).toMatchObject({ result: "failed", error: { code: "termination" } });
    expect(terminated.metadata).toEqual({ usage: createUsage(1), terminate: true });
  }, 30_000);
});
