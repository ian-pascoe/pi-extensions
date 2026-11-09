import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  normalizeContext,
  type AssistantMessage,
  type Context,
  type Model,
  type TranscriptContext,
  type StreamFunction,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  createCodemodeExtension,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, overflow, reply, toolCall } from "./sdk-harness.js";

const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));

const Payload = Type.Object({
  messages: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    }),
  ),
  system: Type.Unknown(),
  tools: Type.Optional(Type.Unknown()),
});

async function serialize(request: {
  systemPrompt: string;
  messages: Context["messages"];
  toolDefinitions: Context["tools"];
}) {
  return capturePayload(
    getModel("anthropic", "claude-sonnet-4-5"),
    normalizeContext({
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.toolDefinitions ?? [],
    }),
  );
}

/** The installed Anthropic serializer's payload for `context`, stopped before transport. */
async function capturePayload(model: Model<"anthropic-messages">, context: TranscriptContext) {
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  // The internal serializer is intentionally not exported. Pin this offline integration
  // to the installed implementation, never to a reference checkout or HTTP client.
  const api: { stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }> } =
    await import(new URL("./api/anthropic-messages.js", entry).href);
  const sentinel = "STOP BEFORE ANTHROPIC TRANSPORT";
  let captured: unknown;
  let transports = 0;
  const response = await api
    .stream(model, context, {
      client: {
        beta: {
          messages: {
            create() {
              transports++;
              throw new Error("Unexpected transport");
            },
          },
        },
      },
      cacheRetention: "long",
      onPayload(payload) {
        captured = structuredClone(payload);
        throw new Error(sentinel);
      },
    })
    .result();
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain(sentinel);
  expect(transports).toBe(0);
  if (!Value.Check(Payload, captured)) throw new Error("Unexpected installed Anthropic payload");
  return captured;
}

async function expectWrittenPrefix(
  previous: Parameters<typeof serialize>[0],
  next: Parameters<typeof serialize>[0],
) {
  expectPayloadPrefix(await serialize(previous), await serialize(next));
}

function expectPayloadPrefix(
  before: Awaited<ReturnType<typeof capturePayload>>,
  after: Awaited<ReturnType<typeof capturePayload>>,
) {
  expect(after.system).toEqual(before.system);
  expect(after.tools).toEqual(before.tools);
  const blocks = (payload: typeof before) =>
    payload.messages.flatMap((message) =>
      message.content.map((content) => ({ role: message.role, content })),
    );
  const oldBlocks = blocks(before);
  const endpoint = oldBlocks.findLastIndex((block) => block.content.cache_control !== undefined);
  expect(endpoint).toBeGreaterThan(-1);
  const withoutCacheAnnotations = (items: typeof oldBlocks) =>
    items.map(({ role, content: { cache_control: _cache, ...content } }) => ({ role, content }));
  expect(withoutCacheAnnotations(blocks(after).slice(0, endpoint + 1))).toEqual(
    withoutCacheAnnotations(oldBlocks.slice(0, endpoint + 1)),
  );
}

// Runs three prompts, a Rollover compaction, and two provider serializations in one SDK session, so it needs more than the 20 s default.
it("keeps ordered tool definitions and system prompt stable around model-only Rollover under codemode only", async () => {
  const f = await createSdkHarness([contextManagement, createCodemodeExtension()], {
    settings: SettingsManager.inMemory({
      codemode: { mode: "only" },
      compaction: { enabled: true, keepRecentTokens: 500, reserveTokens: 512 },
      retry: { enabled: false },
    }),
  });
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), "codemode"]);
  f.responses.push(reply("Before."));
  await f.session.prompt("Start " + "history ".repeat(400));
  f.responses.push(toolCall("context_rollover", { handoff: "Continue." }), reply("Checkpointed."));
  await f.session.prompt("Roll over");
  f.responses.push(reply("After."));
  await f.session.prompt("Continue");
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  const first = f.requests[0]!;
  expect(first.tools).toContain("context_rollover");
  for (const request of f.requests) {
    expect(request.tools).toEqual(first.tools);
    expect(request.toolDefinitions).toEqual(first.toolDefinitions);
    expect(request.systemPrompt).toBe(first.systemPrompt);
  }
  // The installed provider serializer sends identical system and tool prefixes.
  const before = await serialize(first);
  const after = await serialize(f.requests.at(-1)!);
  expect(after.system).toEqual(before.system);
  expect(after.tools).toEqual(before.tools);
  expect(f.providerRequests).toEqual([]);
}, 30_000);

it("preserves the emergency Rollover Todo endpoint without replaying an oversized tool result", async () => {
  const largeOutput: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "large_output",
      label: "Large output",
      description: "Return oversized History",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "DATA-ONLY ".repeat(20_000) }], details: {} };
      },
    });
  };
  const f = await createSdkHarness([largeOutput, contextManagement], {
    additionalExtensionPaths: [todoPath],
    contextWindow: 16_000,
  });
  f.responses.push(toolCall("todo", { action: "add", title: "Emergency Task" }), reply("Added."));
  await f.session.prompt("Remember this Task");
  f.responses.push(toolCall("large_output", {}), overflow(), reply("Recovered."));
  await f.session.prompt("Read oversized output");
  expect(f.requests).toHaveLength(5);
  expect(JSON.stringify(f.requests[3]?.messages)).toContain("DATA-ONLY");
  const fresh = f.requests[4]!;
  expect(JSON.stringify(fresh.messages)).toContain("Emergency Task");
  expect(JSON.stringify(fresh.messages)).toContain("saved Handoff may be stale or absent");
  expect(JSON.stringify(fresh.messages)).not.toContain("DATA-ONLY");
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  // History keeps the archived result even though the new Context Window omits it.
  expect(JSON.stringify(f.manager.getBranch())).toContain("DATA-ONLY");
  f.responses.push(reply("Continued."));
  await f.session.prompt("Continue unchanged");
  await expectWrittenPrefix(fresh, f.requests.at(-1)!);
  f.responses.push(toolCall("todo", { action: "clear" }), reply("Cleared."));
  await f.session.prompt("Clear after Emergency Rollover");
  await expectWrittenPrefix(fresh, f.requests.at(-1)!);
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("Todo List is empty");
  expect(f.providerRequests).toEqual([]);
});

for (const transition of ["native", "rollover"] as const) {
  for (const keepRecentTokens of transition === "native" ? [0] : [500]) {
    it(`preserves the first ${transition} Todo endpoint with retention ${keepRecentTokens} through later mutations`, async () => {
      const f = await createSdkHarness([contextManagement], {
        additionalExtensionPaths: [todoPath],
        keepRecentTokens,
        contextSettings: { tailTokens: keepRecentTokens },
      });
      f.responses.push(
        toolCall("todo", { action: "add", title: "Before cutoff" }),
        reply("Added."),
      );
      await f.session.prompt("Add a Task");
      f.responses.push(reply("Separated."));
      await f.session.prompt("discard ".repeat(4000));
      f.responses.push(
        toolCall("todo", { action: "update", id: 1, title: "Retained update" }),
        reply("Updated."),
      );
      await f.session.prompt("Update before the checkpoint");
      if (transition === "native") f.responses.push(overflow());
      else f.responses.push(toolCall("context_rollover", { handoff: "Continue the Task." }));
      f.responses.push(reply("Resumed."));
      await f.session.prompt("Continue across the checkpoint");
      const fresh = f.requests.at(-1)!;
      expect(JSON.stringify(fresh.messages)).toContain("Retained update");
      const baseline = fresh.messages.find(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("Todo List state from the pi-todo extension"),
      );
      expect(JSON.stringify(baseline)).toContain(
        transition === "native" ? "Retained update" : "Before cutoff",
      );
      f.responses.push(reply("Unchanged."));
      await f.session.prompt("Continue unchanged");
      await expectWrittenPrefix(fresh, f.requests.at(-1)!);
      const unchanged = f.requests.at(-1)!;
      f.responses.push(
        toolCall("todo", { action: "update", id: 1, title: "After checkpoint" }),
        reply("Changed."),
      );
      await f.session.prompt("Change the Task after checkpoint");
      await expectWrittenPrefix(unchanged, f.requests.at(-1)!);
      await expectWrittenPrefix(fresh, f.requests.at(-1)!);
      expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain("After checkpoint");
      expect(f.providerRequests).toEqual([]);
    });
  }
}

it("keeps the written prefix stable through filtered History calls", async () => {
  const f = await createSdkHarness([contextManagement]);
  f.responses.push(reply("Noted."));
  await f.session.prompt("Remember the needle phrase");
  const before = f.requests.at(-1)!;
  f.responses.push(
    toolCall("context_history", { action: "search", query: "needle", type: "message" }, "search-1"),
    toolCall("context_history", { action: "list", role: "user" }, "list-1"),
    reply("Searched."),
  );
  await f.session.prompt("Find it");
  for (const request of f.requests) {
    expect(request.tools).toEqual(before.tools);
    expect(request.toolDefinitions).toEqual(before.toolDefinitions);
    expect(request.systemPrompt).toBe(before.systemPrompt);
  }
  await expectWrittenPrefix(before, f.requests.at(-1)!);
  expect(f.providerRequests).toEqual([]);
});

function thinkingReply(text: string): AssistantMessage {
  const message = reply(text);
  return {
    ...message,
    content: [
      { type: "thinking", thinking: "Reasoning for " + text, thinkingSignature: "sig-" + text },
      ...message.content,
    ],
  };
}

it("keeps the written prefix and thinking blocks through idle-triggered messages and tool changes", async () => {
  let api: ExtensionAPI | undefined;
  const lateTool: ExtensionFactory = (pi) => {
    api = pi;
    pi.registerTool({
      name: "late_tool",
      label: "Late tool",
      description: "Activated mid-session",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "late" }], details: {} };
      },
    });
  };
  // Managed-effort models bind thinking blocks to their prefix and drop them on a mismatch.
  const f = await createSdkHarness([contextManagement, lateTool], {
    defaultSystemPrompt: true,
    modelId: "claude-opus-5-5",
  });
  f.session.setActiveToolsByName(
    f.session.getActiveToolNames().filter((name) => name !== "late_tool"),
  );
  f.responses.push(thinkingReply("First."));
  await f.session.prompt("Start");
  // Like a pi-termctrl Exit notification while idle: the run skips before_agent_start.
  f.responses.push(thinkingReply("Noticed."));
  api?.sendMessage(
    { customType: "pi-termctrl-exit", content: "t1 exited", display: true },
    { triggerTurn: true, deliverAs: "steer" },
  );
  await vi.waitFor(() => expect(f.transcripts).toHaveLength(2));
  await f.session.waitForIdle();
  // Like tool_search activating a tool between runs.
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), "late_tool"]);
  f.responses.push(thinkingReply("Loaded."));
  await f.session.prompt("Use the late tool next");
  f.responses.push(thinkingReply("Done."));
  await f.session.prompt("Continue");
  expect(f.transcripts).toHaveLength(4);
  const payloads = [];
  for (const messages of f.transcripts)
    payloads.push(await capturePayload(f.model, normalizeContext({ messages })));
  for (const [index, payload] of payloads.entries())
    if (index > 0) expectPayloadPrefix(payloads[index - 1]!, payload);
  const thinking = payloads
    .at(-1)!
    .messages.flatMap((message) => message.content)
    .filter((block) => block.type === "thinking");
  expect(thinking.map((block) => block.signature)).toEqual([
    "sig-First.",
    "sig-Noticed.",
    "sig-Loaded.",
  ]);
  expect(f.providerRequests).toEqual([]);
});
