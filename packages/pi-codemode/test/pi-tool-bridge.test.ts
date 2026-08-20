import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import {
  capturePiAgentSession,
  type CapturedPiAgentSession,
} from "../src/pi-agent-session-capture.js";
import {
  executePiToolBridgeBatch,
  type PiToolBridgeBatchResult,
  type PiToolBridgeCallSuccess,
} from "../src/pi-tool-bridge.js";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const fixtureDirectories: string[] = [];

function deterministicNow(...values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

function usage(units: number): Usage {
  return {
    input: units,
    output: units,
    cacheRead: units,
    cacheWrite: units,
    cacheWrite1h: units,
    reasoning: units,
    totalTokens: units * 4,
    cost: {
      input: units,
      output: units,
      cacheRead: units,
      cacheWrite: units,
      total: units * 4,
    },
  };
}

type BridgeFixture = {
  readonly captured: CapturedPiAgentSession;
  readonly contextRecords: ExtensionContext[];
  readonly executedNames: string[];
  readonly hookRecords: string[];
  readonly pi: ExtensionAPI;
  readonly releaseSignalIgnoringTool: () => void;
  readonly replace: (value: string) => void;
  readonly session: AgentSession;
  readonly tempDirectory: string;
  readonly toolValues: number[];
};

async function createBridgeFixture(): Promise<BridgeFixture> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-codemode-bridge-"));
  fixtureDirectories.push(tempDirectory);
  await writeFile(join(tempDirectory, "README.md"), "# pi-extensions bridge fixture\n");
  const settingsManager = SettingsManager.inMemory();
  const executedNames: string[] = [];
  const hookRecords: string[] = [];
  const contextRecords: ExtensionContext[] = [];
  const toolValues: number[] = [];
  const signalIgnoringGate = Promise.withResolvers<void>();
  const closureToken = "registered-extension-closure";
  let extensionApi: ExtensionAPI | undefined;

  const resourceLoader = new DefaultResourceLoader({
    cwd: tempDirectory,
    agentDir: tempDirectory,
    settingsManager,
    extensionFactories: [
      (pi) => {
        extensionApi = pi;
        const registerReplaceable = (value: string): void => {
          pi.registerTool({
            name: "replaceable",
            label: "Replaceable",
            description: "Proves fresh exact wrapper lookup.",
            parameters: Type.Object({}, { additionalProperties: false }),
            async execute() {
              executedNames.push(`replaceable:${value}`);
              return { content: [{ type: "text", text: value }], details: { value } };
            },
          });
        };

        pi.registerTool({
          name: "mutated",
          label: "Mutated",
          description: "Exercises prepare, validation, hook mutation, updates, and usage.",
          parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
          prepareArguments(argumentsValue) {
            // SAFETY: This compatibility hook is the boundary for raw model arguments; Number(undefined) deliberately fails later schema validation.
            const input = argumentsValue as { readonly value?: unknown };
            return { value: Number(input.value) + 1 };
          },
          async execute(_toolCallId, input, signal, onUpdate, context) {
            executedNames.push("mutated");
            toolValues.push(input.value);
            contextRecords.push(context);
            onUpdate?.({
              content: [{ type: "text", text: "accepted update" }],
              details: { phase: "accepted" },
            });
            setTimeout(() => {
              onUpdate?.({
                content: [{ type: "text", text: "late update" }],
                details: { phase: "late" },
              });
            }, 5);
            return {
              content: [
                { type: "text", text: `${closureToken}:${input.value}:${String(signal?.aborted)}` },
              ],
              details: { handler: true },
              usage: usage(1),
            };
          },
        });
        pi.registerTool({
          name: "context_echo",
          label: "Context Echo",
          description: "Returns its live ExtensionContext.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_toolCallId, _input, _signal, _onUpdate, context) {
            executedNames.push("context_echo");
            contextRecords.push(context);
            return {
              content: [{ type: "text", text: closureToken }],
              details: { cwd: context.cwd, closureToken },
            };
          },
        });
        pi.registerTool({
          name: "blocked",
          label: "Blocked",
          description: "Must never execute when blocked by the hook.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("blocked");
            return { content: [], details: {} };
          },
        });
        pi.registerTool({
          name: "throws",
          label: "Throws",
          description: "Throws from the exact registered handler.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("throws");
            throw new Error("distinctive registered throw");
          },
        });
        pi.registerTool({
          name: "forced-error",
          label: "Forced Error",
          description: "Becomes an error in the result hook.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("forced-error");
            return { content: [{ type: "text", text: "handler success" }], details: {} };
          },
        });
        pi.registerTool({
          name: "image-source",
          label: "Image Source",
          description: "Returns an image normalized by AgentSession's installed result hook.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("image-source");
            return { content: [{ type: "text", text: "replace me" }], details: {} };
          },
        });
        pi.registerTool({
          name: "terminate-block",
          label: "Terminate Block",
          description: "Is blocked with termination.",
          parameters: Type.Object({}, { additionalProperties: false }),
          executionMode: "sequential",
          async execute() {
            executedNames.push("terminate-block");
            return { content: [], details: {} };
          },
        });
        pi.registerTool({
          name: "terminate-result",
          label: "Terminate Result",
          description: "Returns a terminating handler result.",
          parameters: Type.Object({}, { additionalProperties: false }),
          executionMode: "sequential",
          async execute() {
            executedNames.push("terminate-result");
            return {
              content: [{ type: "text", text: "terminate" }],
              details: {},
              terminate: true,
            };
          },
        });
        pi.registerTool({
          name: "sibling",
          label: "Sibling",
          description: "Must be skipped after termination.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("sibling");
            return { content: [], details: {} };
          },
        });
        for (const [name, delay, executionMode] of [
          ["parallel-left", 15, "parallel"],
          ["parallel-right", 5, "parallel"],
          ["sequential-middle", 5, "sequential"],
        ] as const) {
          pi.registerTool({
            name,
            label: name,
            description: `Records ${name} execution order.`,
            parameters: Type.Object({}, { additionalProperties: false }),
            executionMode,
            async execute() {
              executedNames.push(`${name}:start`);
              await new Promise((resolve) => setTimeout(resolve, delay));
              executedNames.push(`${name}:end`);
              return { content: [{ type: "text", text: name }], details: {} };
            },
          });
        }
        pi.registerTool({
          name: "add-tool",
          label: "Add Tool",
          description: "Adds a tool through the live extension API.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("add-tool");
            pi.registerTool({
              name: "added-dynamic",
              label: "Added Dynamic",
              description: "Dynamically added exact handler.",
              parameters: Type.Object({}, { additionalProperties: false }),
              async execute() {
                executedNames.push("added-dynamic");
                return { content: [{ type: "text", text: "dynamic" }], details: {} };
              },
            });
            return { content: [{ type: "text", text: "added" }], details: {} };
          },
        });
        pi.registerTool({
          name: "abort-aware",
          label: "Abort Aware",
          description: "Records whether aborted work reached the handler.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("abort-aware");
            return { content: [], details: {} };
          },
        });
        pi.registerTool({
          name: "parallel-terminate-result",
          label: "Parallel Terminate Result",
          description: "Terminates while a parallel sibling ignores cancellation.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute() {
            executedNames.push("parallel-terminate-result");
            return {
              content: [{ type: "text", text: "parallel terminate" }],
              details: {},
              terminate: true,
            };
          },
        });
        pi.registerTool({
          name: "signal-ignoring",
          label: "Signal Ignoring",
          description: "Waits for a test gate without observing its abort signal.",
          parameters: Type.Object({}, { additionalProperties: false }),
          async execute(_toolCallId, _input, _signal, onUpdate) {
            executedNames.push("signal-ignoring:start");
            await signalIgnoringGate.promise;
            executedNames.push("signal-ignoring:end");
            onUpdate?.({
              content: [{ type: "text", text: "late ignored update" }],
              details: { phase: "late-ignored" },
            });
            return { content: [{ type: "text", text: "ignored" }], details: {} };
          },
        });
        registerReplaceable("original");

        pi.on("tool_call", (event) => {
          hookRecords.push(`before:${event.toolName}`);
          if (event.toolName === "mutated") {
            event.input.value = Number(event.input.value) + 1;
          }
          if (event.toolName === "blocked") {
            return { block: true, reason: "blocked by distinctive extension hook" };
          }
          if (event.toolName === "terminate-block") {
            return { block: true, reason: "terminating block", terminate: true };
          }
          return undefined;
        });
        pi.on("tool_result", (event) => {
          hookRecords.push(`after:${event.toolName}:${String(event.isError)}`);
          if (event.toolName === "mutated") {
            return {
              content: [{ type: "text", text: "mutated result hook" }],
              details: { resultHook: true },
              usage: usage(2),
            };
          }
          if (event.toolName === "forced-error") {
            return {
              content: [{ type: "text", text: "forced error from result hook" }],
              details: { forced: true },
              isError: true,
            };
          }
          if (event.toolName === "image-source") {
            return {
              content: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }],
              details: { image: true },
            };
          }
          return undefined;
        });
      },
    ],
  });
  await resourceLoader.reload();
  const model = getModel("anthropic", "claude-sonnet-4-5");
  if (model === undefined) throw new Error("Pi CodeMode bridge test: missing pinned model fixture");
  const session = (
    await createAgentSession({
      cwd: tempDirectory,
      agentDir: tempDirectory,
      model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(tempDirectory),
      settingsManager,
    })
  ).session;
  if (extensionApi === undefined) {
    throw new Error("Pi CodeMode bridge test: extension API was not created");
  }
  const capturedResult = capturePiAgentSession(extensionApi);
  if (!capturedResult.ok) {
    throw new Error(`Pi CodeMode bridge test: ${capturedResult.warning}`);
  }

  const activeExtensionApi = extensionApi;
  const replace = (value: string): void => {
    activeExtensionApi.registerTool({
      name: "replaceable",
      label: "Replaceable",
      description: "Replacement exact wrapper.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        executedNames.push(`replaceable:${value}`);
        return { content: [{ type: "text", text: value }], details: { value } };
      },
    });
  };

  return {
    captured: capturedResult.capabilities,
    contextRecords,
    executedNames,
    hookRecords,
    pi: extensionApi,
    releaseSignalIgnoringTool: signalIgnoringGate.resolve,
    replace,
    session,
    tempDirectory,
    toolValues,
  };
}

function outerAssistantMessage(captured: CapturedPiAgentSession): AssistantMessage {
  const model = captured.agent.state.model;
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "outer-codemode-call",
        name: "codemode_execute",
        arguments: { script: "nested" },
      },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(0),
    stopReason: "toolUse",
    timestamp: 1234,
  };
}

function successfulCall(batch: PiToolBridgeBatchResult, index: number): PiToolBridgeCallSuccess {
  const outcome = batch.calls[index];
  if (outcome === undefined || !outcome.ok) {
    throw new Error(
      `Pi CodeMode bridge test: expected successful call ${index}, got ${outcome?.error.message ?? "missing"}`,
    );
  }
  return outcome;
}

function textContent(result: PiToolBridgeCallSuccess): string[] {
  return result.value.content.flatMap((content) => (content.type === "text" ? [content.text] : []));
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("capturePiAgentSession", () => {
  test("captures a real pinned AgentSession and restores the exact prototype descriptor", async () => {
    const descriptorBefore = Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools");
    const fixture = await createBridgeFixture();

    expect(fixture.captured.session).toBe(fixture.session);
    expect(fixture.captured.getToolRegistry().has("read")).toBe(true);
    expect(fixture.captured.getToolRegistry().has("context_echo")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools")).toEqual(
      descriptorBefore,
    );

    const contextTool = fixture.captured.getToolRegistry().get("context_echo");
    if (contextTool === undefined)
      throw new Error("Pi CodeMode bridge test: missing context_echo wrapper");
    const parametersDescriptor = Object.getOwnPropertyDescriptor(contextTool, "parameters");
    Object.defineProperty(contextTool, "parameters", { configurable: true, value: undefined });
    try {
      expect(() => fixture.captured.getToolRegistry()).toThrow("capability lost");
    } finally {
      if (parametersDescriptor === undefined) Reflect.deleteProperty(contextTool, "parameters");
      else Object.defineProperty(contextTool, "parameters", parametersDescriptor);
    }

    const detachedApi = { getAllTools: () => [] };
    const failed = capturePiAgentSession(detachedApi);
    expect(failed).toMatchObject({ ok: false });
    expect(Object.getOwnPropertyDescriptor(AgentSession.prototype, "getAllTools")).toEqual(
      descriptorBefore,
    );
    fixture.session.dispose();
  });
});

describe("executePiToolBridgeBatch", () => {
  test("uses built-in and registered wrappers with their live ExtensionContext without transcript writes", async () => {
    const fixture = await createBridgeFixture();
    const messageCount = fixture.captured.agent.state.messages.length;
    const controller = new AbortController();
    const batch = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [
        { callId: "read-1", name: "read", input: { path: "README.md" } },
        { callId: "context-1", name: "context_echo", input: {} },
      ],
      outerAssistantMessage: outerAssistantMessage(fixture.captured),
      signal: controller.signal,
      onTerminate: () => controller.abort(),
    });

    expect(textContent(successfulCall(batch, 0)).join("\n")).toContain("pi-extensions");
    expect(successfulCall(batch, 1).value.details).toEqual({
      cwd: fixture.tempDirectory,
      closureToken: "registered-extension-closure",
    });
    expect(fixture.contextRecords).toHaveLength(1);
    expect(fixture.contextRecords[0]?.cwd).toBe(fixture.tempDirectory);
    expect(fixture.captured.agent.state.messages).toHaveLength(messageCount);
    fixture.session.dispose();
  });

  test("mirrors prepare, validate, hook mutation/result merging, images, usage, and update lifetime", async () => {
    const fixture = await createBridgeFixture();
    const observedBefore: Array<{
      readonly assistantMessage: AssistantMessage;
      readonly inputValue: unknown;
      readonly mutatedValue: unknown;
      readonly signal: AbortSignal | undefined;
      readonly stateMatches: boolean;
    }> = [];
    const observedAfter: AssistantMessage[] = [];
    const installedBefore = fixture.captured.agent.beforeToolCall;
    const installedAfter = fixture.captured.agent.afterToolCall;
    if (installedBefore === undefined || installedAfter === undefined) {
      throw new Error("Pi CodeMode bridge test: AgentSession hooks were not installed");
    }
    fixture.captured.agent.beforeToolCall = async (context, signal) => {
      const inputValue = Object.getOwnPropertyDescriptor(context.args, "value")?.value;
      const result = await installedBefore(context, signal);
      observedBefore.push({
        assistantMessage: context.assistantMessage,
        inputValue,
        mutatedValue: Object.getOwnPropertyDescriptor(context.args, "value")?.value,
        signal,
        stateMatches:
          context.context.messages === fixture.captured.agent.state.messages &&
          context.context.tools === fixture.captured.agent.state.tools,
      });
      return result;
    };
    fixture.captured.agent.afterToolCall = async (context, signal) => {
      observedAfter.push(context.assistantMessage);
      return installedAfter(context, signal);
    };

    const updates: Array<{ readonly callId: string; readonly result: AgentToolResult<unknown> }> =
      [];
    const controller = new AbortController();
    const outer = outerAssistantMessage(fixture.captured);
    const batch = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [
        { callId: "mutated-1", name: "mutated", input: { value: "40" } },
        { callId: "image-1", name: "image-source", input: {} },
      ],
      outerAssistantMessage: outer,
      signal: controller.signal,
      onTerminate: () => controller.abort(),
      onUpdate: (callId, result) => updates.push({ callId, result }),
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(fixture.toolValues).toEqual([42]);
    expect(
      observedBefore.map(({ inputValue, mutatedValue }) => [inputValue, mutatedValue]),
    ).toEqual([
      [41, 42],
      [undefined, undefined],
    ]);
    expect(
      observedBefore.every(
        ({ assistantMessage }) => assistantMessage === observedBefore[0]?.assistantMessage,
      ),
    ).toBe(true);
    expect(
      observedAfter.every(
        (assistantMessage) => assistantMessage === observedBefore[0]?.assistantMessage,
      ),
    ).toBe(true);
    expect(observedBefore[0]?.assistantMessage).toMatchObject({
      api: outer.api,
      provider: outer.provider,
      model: outer.model,
      timestamp: outer.timestamp,
    });
    expect(observedBefore[0]?.assistantMessage.content).toEqual([
      { type: "toolCall", id: "mutated-1", name: "mutated", arguments: { value: "40" } },
      { type: "toolCall", id: "image-1", name: "image-source", arguments: {} },
    ]);
    expect(
      observedBefore.every(
        ({ signal, stateMatches }) => signal === controller.signal && stateMatches,
      ),
    ).toBe(true);
    expect(textContent(successfulCall(batch, 0))).toEqual(["mutated result hook"]);
    expect(successfulCall(batch, 0).value.details).toEqual({ resultHook: true });
    expect(successfulCall(batch, 1).value.content).toEqual([
      { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
    ]);
    expect(batch.usage).toEqual(usage(2));
    expect(updates.map(({ callId, result }) => [callId, result.details])).toEqual([
      ["mutated-1", { phase: "accepted" }],
    ]);

    const aggregatedUsage = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [
        { callId: "mutated-usage-1", name: "mutated", input: { value: "0" } },
        { callId: "mutated-usage-2", name: "mutated", input: { value: "1" } },
      ],
      signal: controller.signal,
      onTerminate: () => controller.abort(),
    });
    expect(aggregatedUsage.usage).toEqual(usage(4));
    fixture.session.dispose();
  });

  test("does not execute invalid or blocked calls and finalizes thrown and isError results through the result hook", async () => {
    const fixture = await createBridgeFixture();
    const controller = new AbortController();
    const batch = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [
        { callId: "invalid-1", name: "mutated", input: {} },
        { callId: "blocked-1", name: "blocked", input: {} },
        { callId: "throws-1", name: "throws", input: {} },
        { callId: "forced-1", name: "forced-error", input: {} },
      ],
      signal: controller.signal,
      onTerminate: () => controller.abort(),
    });

    expect(batch.calls.every((call) => !call.ok)).toBe(true);
    expect(fixture.executedNames).toEqual(expect.arrayContaining(["throws", "forced-error"]));
    expect(fixture.executedNames).not.toEqual(expect.arrayContaining(["mutated", "blocked"]));
    expect(fixture.hookRecords).not.toContain("before:mutated");
    expect(fixture.hookRecords).toContain("before:blocked");
    expect(fixture.hookRecords).toContain("after:throws:true");
    expect(fixture.hookRecords).toContain("after:forced-error:false");
    expect(fixture.hookRecords.some((entry) => entry.startsWith("after:blocked"))).toBe(false);
    expect(batch.calls[2]).toMatchObject({
      ok: false,
      error: { message: "distinctive registered throw", terminate: false },
    });
    expect(batch.calls[3]).toMatchObject({
      ok: false,
      error: { message: "forced error from result hook", terminate: false },
    });
    expect(batch.terminate).toBe(false);
    fixture.session.dispose();
  });

  test("propagates terminating blocks/results, aborts siblings, and honors exact after-hook termination override", async () => {
    const fixture = await createBridgeFixture();
    const blockedController = new AbortController();
    let blockedTerminations = 0;
    const blocked = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [
        { callId: "terminate-block-1", name: "terminate-block", input: {} },
        { callId: "sibling-1", name: "sibling", input: {} },
      ],
      signal: blockedController.signal,
      onTerminate: () => {
        blockedTerminations += 1;
        blockedController.abort();
      },
    });
    expect(blocked.terminate).toBe(true);
    expect(blockedTerminations).toBe(1);
    expect(blockedController.signal.aborted).toBe(true);
    expect(fixture.executedNames).not.toContain("terminate-block");
    expect(fixture.executedNames).not.toContain("sibling");
    expect(blocked.calls).toHaveLength(2);

    const resultController = new AbortController();
    let resultTerminations = 0;
    const terminatingResult = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [
        { callId: "terminate-result-1", name: "terminate-result", input: {} },
        { callId: "sibling-2", name: "sibling", input: {} },
      ],
      signal: resultController.signal,
      onTerminate: () => {
        resultTerminations += 1;
        resultController.abort();
      },
    });
    expect(terminatingResult.terminate).toBe(true);
    expect(resultTerminations).toBe(1);
    expect(fixture.executedNames.filter((name) => name === "terminate-result")).toHaveLength(1);
    expect(fixture.executedNames).not.toContain("sibling");

    const parallelController = new AbortController();
    const parallelUpdates: AgentToolResult<unknown>[] = [];
    const timeout = Promise.withResolvers<never>();
    const timeoutHandle = setTimeout(
      () => timeout.reject(new Error("parallel termination did not return promptly")),
      1_000,
    );
    let parallelTermination: PiToolBridgeBatchResult;
    try {
      parallelTermination = await Promise.race([
        executePiToolBridgeBatch(fixture.captured, {
          now: deterministicNow(),
          calls: [
            {
              callId: "parallel-terminate-1",
              name: "parallel-terminate-result",
              input: {},
            },
            { callId: "signal-ignoring-1", name: "signal-ignoring", input: {} },
          ],
          signal: parallelController.signal,
          onTerminate: () => parallelController.abort(),
          onUpdate: (_callId, update) => parallelUpdates.push(update),
        }),
        timeout.promise,
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
    expect(parallelTermination.terminate).toBe(true);
    expect(parallelController.signal.aborted).toBe(true);
    expect(parallelTermination.calls.map((call) => call.callId)).toEqual([
      "parallel-terminate-1",
      "signal-ignoring-1",
    ]);
    expect(parallelTermination.calls.every((call) => !call.ok && call.error.terminate)).toBe(true);
    expect(fixture.executedNames).toContain("signal-ignoring:start");
    expect(fixture.executedNames).not.toContain("signal-ignoring:end");

    fixture.releaseSignalIgnoringTool();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(parallelUpdates).toEqual([]);
    expect(fixture.hookRecords.some((record) => record.startsWith("after:signal-ignoring"))).toBe(
      false,
    );

    const installedAfter = fixture.captured.agent.afterToolCall;
    if (installedAfter === undefined)
      throw new Error("Pi CodeMode bridge test: missing result hook");
    fixture.captured.agent.afterToolCall = async (context, signal) => ({
      ...(await installedAfter(context, signal)),
      terminate: false,
    });
    const overrideController = new AbortController();
    const overridden = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [{ callId: "terminate-result-2", name: "terminate-result", input: {} }],
      signal: overrideController.signal,
      onTerminate: () => overrideController.abort(),
    });
    expect(overridden.terminate).toBe(false);
    expect(overrideController.signal.aborted).toBe(false);

    const abortController = new AbortController();
    abortController.abort();
    const aborted = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [{ callId: "abort-1", name: "abort-aware", input: {} }],
      signal: abortController.signal,
      onTerminate: () => {},
    });
    expect(aborted.calls[0]).toMatchObject({ ok: false, error: { code: "cancellation" } });
    expect(fixture.executedNames).not.toContain("abort-aware");
    fixture.session.dispose();
  });

  test("runs mixed modes correctly and refreshes replacement/added wrappers", async () => {
    const fixture = await createBridgeFixture();
    const parallelController = new AbortController();
    const parallel = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(10, 20, 50, 70),
      calls: [
        { callId: "left-1", name: "parallel-left", input: {} },
        { callId: "right-1", name: "parallel-right", input: {} },
      ],
      signal: parallelController.signal,
      onTerminate: () => parallelController.abort(),
    });
    expect(fixture.executedNames.slice(0, 2)).toEqual([
      "parallel-left:start",
      "parallel-right:start",
    ]);

    expect(parallel.presentation).toEqual([
      { callId: "left-1", name: "parallel-left", outcome: "success", elapsedMs: 60 },
      { callId: "right-1", name: "parallel-right", outcome: "success", elapsedMs: 30 },
    ]);

    fixture.executedNames.length = 0;
    const sequentialController = new AbortController();
    const sequential = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(100, 130, 200, 240, 300, 350),
      calls: [
        { callId: "left-2", name: "parallel-left", input: {} },
        { callId: "middle-1", name: "sequential-middle", input: {} },
        { callId: "right-2", name: "parallel-right", input: {} },
      ],
      signal: sequentialController.signal,
      onTerminate: () => sequentialController.abort(),
    });
    expect(fixture.executedNames).toEqual([
      "parallel-left:start",
      "parallel-left:end",
      "sequential-middle:start",
      "sequential-middle:end",
      "parallel-right:start",
      "parallel-right:end",
    ]);
    expect(sequential.presentation).toEqual([
      { callId: "left-2", name: "parallel-left", outcome: "success", elapsedMs: 30 },
      { callId: "middle-1", name: "sequential-middle", outcome: "success", elapsedMs: 40 },
      { callId: "right-2", name: "parallel-right", outcome: "success", elapsedMs: 50 },
    ]);

    const replacementController = new AbortController();
    const first = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [{ callId: "replace-1", name: "replaceable", input: {} }],
      signal: replacementController.signal,
      onTerminate: () => replacementController.abort(),
    });
    expect(textContent(successfulCall(first, 0))).toEqual(["original"]);
    fixture.replace("replacement");
    const second = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [{ callId: "replace-2", name: "replaceable", input: {} }],
      signal: replacementController.signal,
      onTerminate: () => replacementController.abort(),
    });
    expect(textContent(successfulCall(second, 0))).toEqual(["replacement"]);

    const added = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [{ callId: "add-1", name: "add-tool", input: {} }],
      signal: replacementController.signal,
      onTerminate: () => replacementController.abort(),
    });
    expect(added.addedToolNames).toEqual(["added-dynamic"]);
    const dynamic = await executePiToolBridgeBatch(fixture.captured, {
      now: deterministicNow(),
      calls: [{ callId: "dynamic-1", name: "added-dynamic", input: {} }],
      signal: replacementController.signal,
      onTerminate: () => replacementController.abort(),
    });
    expect(textContent(successfulCall(dynamic, 0))).toEqual(["dynamic"]);
    fixture.session.dispose();
  });
});
