import type {
  AgentEndEvent,
  AgentStartEvent,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTiktokenTokenizedOutputCounterLoader,
  type TokenizedOutputCounter,
  type TokenizedOutputCounterLoader,
  registerTpsTracker,
  type TpsTrackerContext,
  type TpsTrackerLifecycleHost,
  type TiktokenRuntime,
  type TiktokenRuntimeLoader,
} from "../src/tps-tracker-core.js";

class RecordingLifecycleHost implements TpsTrackerLifecycleHost {
  agentStart: Parameters<TpsTrackerLifecycleHost["onAgentStart"]>[0] | undefined;
  messageStart: Parameters<TpsTrackerLifecycleHost["onMessageStart"]>[0] | undefined;
  messageUpdate: Parameters<TpsTrackerLifecycleHost["onMessageUpdate"]>[0] | undefined;
  messageEnd: Parameters<TpsTrackerLifecycleHost["onMessageEnd"]>[0] | undefined;
  agentEnd: Parameters<TpsTrackerLifecycleHost["onAgentEnd"]>[0] | undefined;

  onAgentStart(handler: Parameters<TpsTrackerLifecycleHost["onAgentStart"]>[0]) {
    this.agentStart = handler;
  }
  onMessageStart(handler: Parameters<TpsTrackerLifecycleHost["onMessageStart"]>[0]) {
    this.messageStart = handler;
  }
  onMessageUpdate(handler: Parameters<TpsTrackerLifecycleHost["onMessageUpdate"]>[0]) {
    this.messageUpdate = handler;
  }
  onMessageEnd(handler: Parameters<TpsTrackerLifecycleHost["onMessageEnd"]>[0]) {
    this.messageEnd = handler;
  }
  onAgentEnd(handler: Parameters<TpsTrackerLifecycleHost["onAgentEnd"]>[0]) {
    this.agentEnd = handler;
  }
}

class RecordingTrackerContext implements TpsTrackerContext {
  modelId: string | undefined;
  readonly statuses: string[] = [];
  readonly notifications: string[] = [];

  constructor(modelId = "test-model") {
    this.modelId = modelId;
  }
  render(_color: "accent" | "dim" | "success", text: string) {
    return text;
  }
  notify(message: string) {
    this.notifications.push(message);
  }
  setStatus(_key: string, text: string) {
    this.statuses.push(text);
  }
}

class RecordingTokenCounterLoader implements TokenizedOutputCounterLoader {
  readonly requestedModelIds: (string | undefined)[] = [];
  constructor(private readonly counter: TokenizedOutputCounter | null) {}
  async loadTokenizedOutputCounter(modelId: string | undefined) {
    this.requestedModelIds.push(modelId);
    return this.counter;
  }
}

function assistantMessage(output = 0): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function messageStartEvent(): MessageStartEvent {
  return { type: "message_start", message: assistantMessage() };
}

function messageUpdateEvent(delta: string, output = 0): MessageUpdateEvent {
  const message = assistantMessage(output);
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
  };
}

function messageEndEvent(output = 0): MessageEndEvent {
  return { type: "message_end", message: assistantMessage(output) };
}

function requireHandler<T>(handler: T | undefined): T {
  if (handler === undefined) throw new Error("Expected registered TPS lifecycle handler");
  return handler;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TPS Tracker extension", () => {
  it("prefers Official Output Count and resets totals for each agent run", async () => {
    const host = new RecordingLifecycleHost();
    const context = new RecordingTrackerContext();
    registerTpsTracker(host, new RecordingTokenCounterLoader(null));

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await requireHandler(host.messageStart)(messageStartEvent(), context);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("first", 12), context);
    vi.advanceTimersByTime(1_000);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("second", 12), context);
    await requireHandler(host.messageEnd)(messageEndEvent(12), context);
    await requireHandler(host.agentEnd)(
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      context,
    );

    expect(context.statuses).toContain("12 tok/s (12 tok / 1.0s)");
    expect(context.notifications).toContain("✓ 12 tok/s  12 tokens in 1.0s streaming");

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await requireHandler(host.agentEnd)(
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      context,
    );
    expect(context.notifications).toContain("• N/A  0 tokens in 0.0s streaming");
  });

  it("uses a model-keyed Tokenized Output Count when provider usage is absent", async () => {
    const host = new RecordingLifecycleHost();
    const context = new RecordingTrackerContext("model-a");
    const loader = new RecordingTokenCounterLoader({ countOutputTokens: () => 3 });
    registerTpsTracker(host, loader);

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await requireHandler(host.messageStart)(messageStartEvent(), context);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("abcdef"), context);
    await requireHandler(host.messageEnd)(messageEndEvent(), context);
    await requireHandler(host.agentEnd)(
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      context,
    );

    expect(loader.requestedModelIds).toEqual(["model-a"]);
    expect(context.notifications).toContain("• N/A  3 tokens in 0.0s streaming");
  });

  it("uses Estimated Output Count when the tokenizer is unavailable", async () => {
    const host = new RecordingLifecycleHost();
    const context = new RecordingTrackerContext();
    registerTpsTracker(host, new RecordingTokenCounterLoader(null));

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await requireHandler(host.messageStart)(messageStartEvent(), context);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("abcdefgh"), context);
    await requireHandler(host.messageEnd)(messageEndEvent(), context);
    await requireHandler(host.agentEnd)(
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      context,
    );

    expect(context.notifications).toContain("• N/A  2 tokens in 0.0s streaming");
  });

  it("counts all output delta variants and ignores non-output update events", async () => {
    const host = new RecordingLifecycleHost();
    const context = new RecordingTrackerContext();
    const inputs: string[] = [];
    registerTpsTracker(
      host,
      new RecordingTokenCounterLoader({
        countOutputTokens: (text) => {
          inputs.push(text);
          return text.length;
        },
      }),
    );
    const message = assistantMessage();

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await requireHandler(host.messageStart)(messageStartEvent(), context);
    await requireHandler(host.messageUpdate)(
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "text",
          partial: message,
        },
      },
      context,
    );
    vi.advanceTimersByTime(1_000);
    await requireHandler(host.messageUpdate)(
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "think",
          partial: message,
        },
      },
      context,
    );
    vi.advanceTimersByTime(1_000);
    await requireHandler(host.messageUpdate)(
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "tool",
          partial: message,
        },
      },
      context,
    );
    await requireHandler(host.messageEnd)(messageEndEvent(), context);

    await requireHandler(host.messageUpdate)(
      {
        type: "message_update",
        message: { role: "user", content: "ignored", timestamp: 0 },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "ignored",
          partial: message,
        },
      },
      context,
    );
    await requireHandler(host.messageUpdate)(
      {
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
      },
      context,
    );

    expect(inputs).toContain("textthinktool");
    expect(inputs).not.toContain("textthinktoolignored");
  });

  it("caches a Tokenized Output Count per model and reloads when the model changes", async () => {
    const host = new RecordingLifecycleHost();
    const context = new RecordingTrackerContext("model-a");
    const loader = new RecordingTokenCounterLoader({ countOutputTokens: () => 1 });
    registerTpsTracker(host, loader);

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await Promise.resolve();
    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    context.modelId = "model-b";
    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );

    expect(loader.requestedModelIds).toEqual(["model-a", "model-b"]);
  });

  it("throttles Tokenized Output Count status calculation for 250 milliseconds", async () => {
    const host = new RecordingLifecycleHost();
    const context = new RecordingTrackerContext();
    const inputs: string[] = [];
    registerTpsTracker(
      host,
      new RecordingTokenCounterLoader({
        countOutputTokens: (text) => {
          inputs.push(text);
          return text.length;
        },
      }),
    );

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await Promise.resolve();
    await requireHandler(host.messageStart)(messageStartEvent(), context);
    vi.advanceTimersByTime(1_000);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("first"), context);
    vi.advanceTimersByTime(100);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("second"), context);
    vi.advanceTimersByTime(250);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("third"), context);

    expect(inputs).toEqual(["first", "firstsecondthird"]);
  });

  it("resets tokenized message text while aggregating multiple messages", async () => {
    const host = new RecordingLifecycleHost();
    const context = new RecordingTrackerContext();
    const inputs: string[] = [];
    registerTpsTracker(
      host,
      new RecordingTokenCounterLoader({
        countOutputTokens: (text) => {
          inputs.push(text);
          return text.length;
        },
      }),
    );

    await requireHandler(host.agentStart)(
      { type: "agent_start" } satisfies AgentStartEvent,
      context,
    );
    await Promise.resolve();
    await requireHandler(host.messageStart)(messageStartEvent(), context);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("first"), context);
    vi.advanceTimersByTime(1_000);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("!"), context);
    await requireHandler(host.messageEnd)(messageEndEvent(), context);
    await requireHandler(host.messageStart)(messageStartEvent(), context);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("second"), context);
    vi.advanceTimersByTime(2_000);
    await requireHandler(host.messageUpdate)(messageUpdateEvent("!"), context);
    await requireHandler(host.messageEnd)(messageEndEvent(), context);
    await requireHandler(host.agentEnd)(
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      context,
    );

    expect(inputs).toContain("second!");
    expect(
      inputs.filter((text) => text.includes("second")).every((text) => !text.includes("first")),
    ).toBe(true);
    expect(context.notifications).toContain("✓ 4 tok/s  13 tokens in 3.0s streaming");
  });

  it("uses o200k_base when a model has no recognized tiktoken encoding", async () => {
    const selectedEncodings: string[] = [];
    const runtime: TiktokenRuntime = {
      findModelEncoding: () => undefined,
      getEncoding: (encoding) => {
        selectedEncodings.push(encoding);
        return { countOutputTokens: (text) => text.length };
      },
    };
    const runtimeLoader: TiktokenRuntimeLoader = {
      loadTiktokenRuntime: async () => runtime,
    };

    const counter =
      await createTiktokenTokenizedOutputCounterLoader(runtimeLoader).loadTokenizedOutputCounter(
        "unknown-pi-model",
      );

    expect(counter?.countOutputTokens("abc")).toBe(3);
    expect(selectedEncodings).toEqual(["o200k_base"]);
  });
});
