import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Context, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

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
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  // The internal serializer is intentionally not exported. Pin this offline integration
  // to the installed implementation, never to a reference checkout or HTTP client.
  const api: { stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }> } =
    await import(new URL("./api/anthropic-messages.js", entry).href);
  const sentinel = "STOP BEFORE ANTHROPIC TRANSPORT";
  let captured: unknown;
  let transports = 0;
  const response = await api
    .stream(
      getModel("anthropic", "claude-sonnet-4-5"),
      {
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.toolDefinitions ?? [],
      },
      {
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
      },
    )
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
  const before = await serialize(previous);
  const after = await serialize(next);
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

it("aborts the installed Anthropic SDK before fetch when a Todo journal anchor is missing", async () => {
  const removeAnchor: ExtensionFactory = (pi) => {
    pi.on("context", (event) => ({
      messages: event.messages.filter((message) => message.role !== "toolResult"),
    }));
  };
  const { default: todo }: { default: ExtensionFactory } = await import(todoPath);
  const f = await createSdkHarness([removeAnchor, todo]);
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const api: { stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }> } =
    await import(new URL("./api/anthropic-messages.js", entry).href);
  const sdk: { default: new (options: { apiKey: string; fetch: typeof fetch }) => object } =
    await import(createRequire(entry).resolve("@anthropic-ai/sdk"));
  let fetches = 0;
  const client = new sdk.default({
    apiKey: "TEST-NOT-A-REAL-KEY",
    fetch: async () => {
      fetches++;
      throw new Error("Unexpected network attempt");
    },
  });
  let streams = 0;
  let aborted = false;
  const scripted = f.session.agent.streamFunction!;
  f.session.agent.streamFunction = (model, context, options) => {
    if (streams++ === 0) return scripted(model, context, options);
    aborted = options?.signal?.aborted ?? false;
    return api.stream(getModel("anthropic", "claude-sonnet-4-5"), context, {
      ...options,
      client,
      maxRetries: 0,
    });
  };
  f.responses.push(toolCall("todo", { action: "add", title: "Cannot locate this snapshot" }));
  await f.session.prompt("Add a Task then continue");
  expect(streams).toBe(2);
  expect(aborted).toBe(true);
  expect(fetches).toBe(0);
  expect(f.extensionErrors).toContainEqual(
    expect.objectContaining({
      event: "context",
      error: expect.stringContaining("Todo context anchor is missing or ambiguous"),
    }),
  );
  expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  expect(f.providerRequests).toEqual([]);
});

it("retains the written conversation endpoint when ordinary history grows", async () => {
  const f = await createSdkHarness([]);
  f.responses.push(reply("First."));
  await f.session.prompt("Start");
  f.responses.push(reply("Second."));
  await f.session.prompt("Continue");
  await expectWrittenPrefix(f.requests[0]!, f.requests[1]!);
});

it("retains the written Todo endpoint through an unchanged next user turn", async () => {
  const f = await createSdkHarness([], { additionalExtensionPaths: [todoPath] });
  f.responses.push(
    toolCall("todo", { action: "add", title: "Preserve this Task" }),
    reply("Saved."),
  );
  await f.session.prompt("Remember a Task");
  f.responses.push(reply("Unchanged."));
  await f.session.prompt("Continue without changes");
  expect(f.requests, JSON.stringify(f.events)).toHaveLength(3);
  expect(f.session.resourceLoader.getExtensions().errors).toEqual([]);
  // requests are captured after Pi's real convertToLlm has converted custom messages.
  await expectWrittenPrefix(f.requests[1]!, f.requests[2]!);
});

it("preserves written snapshots through updates, no-ops, and explicit empty state", async () => {
  const f = await createSdkHarness([], { additionalExtensionPaths: [todoPath] });
  f.responses.push(toolCall("todo", { action: "add", title: "Original Task" }), reply("Added."));
  await f.session.prompt("Add a Task");
  for (const action of [
    { action: "update", id: 1, title: "Renamed Task" },
    { action: "update", id: 1, title: "Renamed Task" },
    { action: "list" },
    { action: "remove", id: 1 },
    { action: "clear" },
  ]) {
    const previous = f.requests.at(-1)!;
    f.responses.push(toolCall("todo", action), reply("Action finished."));
    await f.session.prompt(`Run ${action.action}`);
    expect(f.requests.at(-1)).toBeDefined();
    await expectWrittenPrefix(previous, f.requests.at(-1)!);
  }
  const snapshots = f.requests
    .at(-1)!
    .messages.filter(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Todo List:"),
    );
  expect(snapshots).toHaveLength(3);
  expect(JSON.stringify(snapshots[0])).toContain("Original Task");
  expect(JSON.stringify(snapshots[1])).toContain("Renamed Task");
  expect(JSON.stringify(snapshots[2])).toContain("Todo List is empty");
  expect(f.requests).toHaveLength(12);
  expect(f.providerRequests).toEqual([]);
});

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
  f.responses.push(toolCall("large_output", {}), reply("Recovered."));
  await f.session.prompt("Read oversized output");
  expect(f.requests).toHaveLength(4);
  const fresh = f.requests[3]!;
  expect(JSON.stringify(fresh.messages)).toContain("Emergency Task");
  expect(JSON.stringify(fresh.messages)).toContain("saved Handoff may be stale or absent");
  expect(JSON.stringify(fresh.messages)).not.toContain("DATA-ONLY");
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
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
  for (const tailTokens of [0, 500]) {
    it(`preserves the first ${transition} Todo endpoint with Tail ${tailTokens} through later mutations`, async () => {
      const f = await createSdkHarness([contextManagement], {
        additionalExtensionPaths: [todoPath],
        contextSettings: { tailTokens },
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
      if (transition === "native") await f.session.compact();
      else f.responses.push(toolCall("context_rollover", { handoff: "Continue the Task." }));
      f.responses.push(reply("Resumed."));
      await f.session.prompt("Continue across the checkpoint");
      const fresh = f.requests.at(-1)!;
      expect(JSON.stringify(fresh.messages)).toContain("Retained update");
      const baseline = fresh.messages.find(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Todo List:"),
      );
      expect(JSON.stringify(baseline)).toContain(
        tailTokens === 0 ? "Retained update" : "Before cutoff",
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
