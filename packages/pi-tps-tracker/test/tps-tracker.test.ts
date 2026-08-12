import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExtensionHandler = (event: any, context: any) => Promise<unknown>;

function createRecordingPi() {
  const handlers = new Map<string, ExtensionHandler>();
  return {
    handlers,
    pi: {
      on(event: string, handler: ExtensionHandler) {
        handlers.set(event, handler);
      },
    },
  };
}

function createContext(modelId = "test-model") {
  const status = vi.fn();
  const notify = vi.fn();
  return {
    context: {
      model: { id: modelId },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: status,
        notify,
      },
    },
    status,
    notify,
  };
}

async function loadTpsTracker(tiktokenFactory: () => Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("tiktoken", tiktokenFactory);
  return (await import("../src/index.js")).default;
}

describe("TPS Tracker extension", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.doUnmock("tiktoken");
    vi.useRealTimers();
  });

  it("prefers official provider output usage and resets totals for the next agent run", async () => {
    const extension = await loadTpsTracker(() => ({
      get_encoding: () => ({ encode_ordinary: (text: string) => Array(text.length).fill(0) }),
      encoding_for_model: () => ({ encode_ordinary: (text: string) => Array(text.length).fill(0) }),
    }));
    const recording = createRecordingPi();
    const { context, notify, status } = createContext();
    extension(recording.pi as never);

    await recording.handlers.get("agent_start")!({}, context);
    await recording.handlers.get("message_start")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant", usage: { output: 12 } },
        assistantMessageEvent: { type: "text_delta", delta: "first" },
      },
      context,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant", usage: { output: 12 } },
        assistantMessageEvent: { type: "text_delta", delta: "second" },
      },
      context,
    );
    await recording.handlers.get("message_end")!(
      { message: { role: "assistant", usage: { output: 12 } } },
      context,
    );
    await recording.handlers.get("agent_end")!({}, context);

    expect(status).toHaveBeenCalledWith("tps", expect.stringContaining("12 tok/s"));
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("12 tokens in 1.0s streaming"),
      "info",
    );

    await recording.handlers.get("agent_start")!({}, context);
    await recording.handlers.get("agent_end")!({}, context);
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringContaining("0 tokens in 0.0s streaming"),
      "info",
    );
  });

  it("registers the tracker lifecycle and starts each agent run in a waiting state", async () => {
    const encodingForModel = vi.fn(() => ({ encode_ordinary: () => [1] }));
    const extension = await loadTpsTracker(() => ({
      get_encoding: vi.fn(() => ({ encode_ordinary: () => [1] })),
      encoding_for_model: encodingForModel,
    }));
    const recording = createRecordingPi();
    const { context, status } = createContext("waiting-model");
    extension(recording.pi as never);

    expect([...recording.handlers.keys()]).toEqual([
      "agent_start",
      "message_start",
      "message_update",
      "message_end",
      "agent_end",
    ]);

    await recording.handlers.get("agent_start")!({}, context);
    await vi.dynamicImportSettled();

    expect(status).toHaveBeenCalledWith("tps", "⏱ waiting for output...");
    expect(encodingForModel).toHaveBeenCalledWith("waiting-model");
  });

  it("counts assistant text, thinking, and tool-call deltas but ignores other updates", async () => {
    const encodeOrdinary = vi.fn((text: string) => Array.from({ length: text.length }));
    const extension = await loadTpsTracker(() => ({
      get_encoding: vi.fn(() => ({ encode_ordinary: encodeOrdinary })),
      encoding_for_model: vi.fn(() => ({ encode_ordinary: encodeOrdinary })),
    }));
    const recording = createRecordingPi();
    const { context, notify, status } = createContext();
    extension(recording.pi as never);

    await recording.handlers.get("agent_start")!({}, context);
    await vi.dynamicImportSettled();
    await recording.handlers.get("message_start")!({ message: { role: "assistant" } }, context);
    await vi.advanceTimersByTimeAsync(1_000);
    for (const [type, delta] of [
      ["text_delta", "text"],
      ["thinking_delta", "think"],
      ["toolcall_delta", "tool"],
    ]) {
      await recording.handlers.get("message_update")!(
        { message: { role: "assistant" }, assistantMessageEvent: { type, delta } },
        context,
      );
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await recording.handlers.get("message_update")!(
      {
        message: { role: "user" },
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      },
      context,
    );
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "tool_result", delta: "ignored" },
      },
      context,
    );
    await recording.handlers.get("message_end")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("agent_end")!({}, context);

    expect(encodeOrdinary).toHaveBeenLastCalledWith("textthinktool");
    expect(status).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("13 tokens in 2.0s streaming"),
      "info",
    );
  });

  it("uses a model-keyed tokenizer when provider usage is absent", async () => {
    const encodingForModel = vi.fn(() => ({ encode_ordinary: () => [1, 2, 3] }));
    const extension = await loadTpsTracker(() => ({
      get_encoding: vi.fn(() => ({ encode_ordinary: () => [1] })),
      encoding_for_model: encodingForModel,
    }));
    const recording = createRecordingPi();
    const { context, notify } = createContext("model-a");
    extension(recording.pi as never);

    await recording.handlers.get("agent_start")!({}, context);
    await Promise.resolve();
    await recording.handlers.get("message_start")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "abcdef" },
      },
      context,
    );
    await recording.handlers.get("message_end")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("agent_end")!({}, context);

    expect(encodingForModel).toHaveBeenCalledWith("model-a");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("3 tokens"), "info");
  });

  it("resets tokenizer input per message and aggregates message tokens and stream time", async () => {
    const encodeOrdinary = vi.fn((text: string) => Array.from({ length: text.length }));
    const extension = await loadTpsTracker(() => ({
      get_encoding: vi.fn(() => ({ encode_ordinary: encodeOrdinary })),
      encoding_for_model: vi.fn(() => ({ encode_ordinary: encodeOrdinary })),
    }));
    const recording = createRecordingPi();
    const { context, notify } = createContext();
    extension(recording.pi as never);

    await recording.handlers.get("agent_start")!({}, context);
    await vi.dynamicImportSettled();
    await recording.handlers.get("message_start")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "fir" },
      },
      context,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "st" },
      },
      context,
    );
    await recording.handlers.get("message_end")!({ message: { role: "assistant" } }, context);
    const callsAfterFirstMessage = encodeOrdinary.mock.calls.length;

    await recording.handlers.get("message_start")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "se" },
      },
      context,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: "cond" },
      },
      context,
    );
    await recording.handlers.get("message_end")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("agent_end")!({}, context);

    const secondMessageInputs = encodeOrdinary.mock.calls
      .slice(callsAfterFirstMessage)
      .map(([text]) => text);
    expect(secondMessageInputs).toContain("second");
    expect(secondMessageInputs.every((text) => !text.includes("first"))).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("11 tokens in 3.0s streaming"),
      "info",
    );
  });

  it("reuses an encoder for one model and loads a new encoder for another model", async () => {
    const encodingForModel = vi.fn(() => ({ encode_ordinary: () => [1] }));
    const extension = await loadTpsTracker(() => ({
      get_encoding: vi.fn(() => ({ encode_ordinary: () => [1] })),
      encoding_for_model: encodingForModel,
    }));
    const recording = createRecordingPi();
    const first = createContext("model-a");
    const second = createContext("model-b");
    extension(recording.pi as never);

    await recording.handlers.get("agent_start")!({}, first.context);
    await vi.dynamicImportSettled();
    await recording.handlers.get("agent_start")!({}, first.context);
    await vi.dynamicImportSettled();
    await recording.handlers.get("agent_start")!({}, second.context);
    await vi.dynamicImportSettled();

    expect(encodingForModel.mock.calls).toEqual([["model-a"], ["model-b"]]);
  });

  it("falls back to four characters per token when the optional tokenizer cannot load", async () => {
    const extension = await loadTpsTracker(() => {
      throw new Error("optional tiktoken unavailable");
    });
    const recording = createRecordingPi();
    const { context, notify } = createContext();
    extension(recording.pi as never);

    await recording.handlers.get("agent_start")!({}, context);
    await recording.handlers.get("message_start")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "thinking_delta", delta: "abcdefgh" },
      },
      context,
    );
    await recording.handlers.get("message_end")!({ message: { role: "assistant" } }, context);
    await recording.handlers.get("agent_end")!({}, context);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("2 tokens"), "info");
  });

  it("ignores non-assistant and non-output updates", async () => {
    const extension = await loadTpsTracker(() => ({
      get_encoding: () => ({ encode_ordinary: () => [] }),
      encoding_for_model: () => ({ encode_ordinary: () => [] }),
    }));
    const recording = createRecordingPi();
    const { context, status } = createContext();
    extension(recording.pi as never);

    await recording.handlers.get("agent_start")!({}, context);
    await recording.handlers.get("message_update")!(
      {
        message: { role: "user" },
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      },
      context,
    );
    await recording.handlers.get("message_update")!(
      {
        message: { role: "assistant" },
        assistantMessageEvent: { type: "tool_result", delta: "ignored" },
      },
      context,
    );

    expect(status).toHaveBeenCalledTimes(1);
  });
});
