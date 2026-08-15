/** Tracks output-token throughput for each Pi agent run. */
import type {
  AgentEndEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import type { Tiktoken, TiktokenEncoding } from "tiktoken";
import { Type } from "typebox";
import { Value } from "typebox/value";

const STATUS_KEY = "tps";
const CHARS_PER_TOKEN = 4;
const TOKENIZE_INTERVAL_MS = 250;
const TIKTOKEN_ENCODINGS = new Set<string>([
  "gpt2",
  "r50k_base",
  "p50k_base",
  "p50k_edit",
  "cl100k_base",
  "o200k_base",
]);
const TiktokenModelEncodingDocumentSchema = Type.Object(
  {},
  { additionalProperties: Type.String() },
);

type TrackerState = {
  messageStart: number | null;
  streamStart: number | null;
  lastStreamAt: number | null;
  streamedText: string;
  estimatedStreamedTokens: number;
  tokenizedStreamedTokens: number;
  lastTokenizedAt: number;
  totalOutputTokens: number;
  totalStreamMs: number;
};

/** Counts text with the optional tokenizer chosen for the active model. */
export interface TokenizedOutputCounter {
  countOutputTokens(text: string): number;
}

/** Loads an optional output-token counter for a Pi model ID. */
export interface TokenizedOutputCounterLoader {
  loadTokenizedOutputCounter(modelId: string | undefined): Promise<TokenizedOutputCounter | null>;
}

/** Reads tiktoken encodings and model mappings behind the optional-runtime boundary. */
export interface TiktokenRuntime {
  getEncoding(encoding: TiktokenEncoding): TokenizedOutputCounter;
  findModelEncoding(modelId: string | undefined): string | undefined;
}

/** Dynamically acquires the optional tiktoken runtime for the production token counter. */
export interface TiktokenRuntimeLoader {
  loadTiktokenRuntime(): Promise<TiktokenRuntime>;
}

/** Supplies time to the tracker core so streaming durations remain testable. */
export interface TrackerClock {
  now(): number;
}

/** The narrow UI contract used by the TPS tracker lifecycle. */
export interface TpsTrackerContext {
  modelId: string | undefined;
  render(color: "accent" | "dim" | "success", text: string): string;
  notify(message: string): void;
  setStatus(key: string, text: string): void;
}

/** Registers the typed TPS tracker lifecycle events needed by the tracker core. */
export interface TpsTrackerLifecycleHost {
  onAgentStart(
    handler: (event: AgentStartEvent, context: TpsTrackerContext) => Promise<void>,
  ): void;
  onMessageStart(
    handler: (event: MessageStartEvent, context: TpsTrackerContext) => Promise<void>,
  ): void;
  onMessageUpdate(
    handler: (event: MessageUpdateEvent, context: TpsTrackerContext) => Promise<void>,
  ): void;
  onMessageEnd(
    handler: (event: MessageEndEvent, context: TpsTrackerContext) => Promise<void>,
  ): void;
  onAgentEnd(handler: (event: AgentEndEvent, context: TpsTrackerContext) => Promise<void>): void;
}

const systemClock: TrackerClock = { now: () => Date.now() };

function createState(): TrackerState {
  return {
    messageStart: null,
    streamStart: null,
    lastStreamAt: null,
    streamedText: "",
    estimatedStreamedTokens: 0,
    tokenizedStreamedTokens: 0,
    lastTokenizedAt: 0,
    totalOutputTokens: 0,
    totalStreamMs: 0,
  };
}

function resetMessageState(state: TrackerState) {
  state.messageStart = null;
  state.streamStart = null;
  state.lastStreamAt = null;
  state.streamedText = "";
  state.estimatedStreamedTokens = 0;
  state.tokenizedStreamedTokens = 0;
  state.lastTokenizedAt = 0;
}

function outputTokens(event: MessageUpdateEvent | MessageEndEvent) {
  if (event.message.role !== "assistant") return 0;
  return event.message.usage?.output ?? 0;
}

function outputDeltaText(event: MessageUpdateEvent) {
  const { assistantMessageEvent } = event;
  switch (assistantMessageEvent.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return assistantMessageEvent.delta;
    default:
      return "";
  }
}

function tpsLabel(tps: number) {
  return tps > 0 ? `${Math.round(tps)} tok/s` : "N/A";
}

function isTiktokenEncoding(value: string): value is TiktokenEncoding {
  return TIKTOKEN_ENCODINGS.has(value);
}

function tokenLabel(officialTokens: number, tokenizedTokens: number, estimatedTokens: number) {
  if (officialTokens > 0) return `${Math.round(officialTokens)} tok`;
  if (tokenizedTokens > 0) return `${Math.round(tokenizedTokens)} tok`;
  return `~${Math.round(estimatedTokens)} tok`;
}

const dynamicTiktokenRuntimeLoader: TiktokenRuntimeLoader = {
  async loadTiktokenRuntime() {
    const [tiktoken, modelEncodings] = await Promise.all([
      import("tiktoken"),
      import("tiktoken/model_to_encoding.json", { with: { type: "json" } }),
    ]);
    const modelEncodingDocument = modelEncodings.default;
    if (!Value.Check(TiktokenModelEncodingDocumentSchema, modelEncodingDocument)) {
      throw new Error("TPS Tracker tiktoken model mapping is invalid");
    }
    return {
      getEncoding: (encoding) => {
        const tokenizer: Tiktoken = tiktoken.get_encoding(encoding);
        return { countOutputTokens: (text) => tokenizer.encode_ordinary(text).length };
      },
      findModelEncoding: (modelId) => {
        const encodingEntry = Object.entries(modelEncodingDocument).find(
          ([knownModel]) => knownModel === modelId,
        );
        return encodingEntry?.[1];
      },
    };
  },
};

/** Creates the production adapter that dynamically loads tiktoken and model encoding data. */
export function createTiktokenTokenizedOutputCounterLoader(
  runtimeLoader: TiktokenRuntimeLoader = dynamicTiktokenRuntimeLoader,
): TokenizedOutputCounterLoader {
  return {
    async loadTokenizedOutputCounter(modelId) {
      try {
        const runtime = await runtimeLoader.loadTiktokenRuntime();
        const encoding = runtime.findModelEncoding(modelId);
        const selectedEncoding: TiktokenEncoding =
          encoding && isTiktokenEncoding(encoding) ? encoding : "o200k_base";
        return runtime.getEncoding(selectedEncoding);
      } catch {
        return null;
      }
    },
  };
}

/** Registers TPS tracker behavior through a narrow lifecycle host and injected time/tokenizer effects. */
export function registerTpsTracker(
  host: TpsTrackerLifecycleHost,
  tokenCounterLoader: TokenizedOutputCounterLoader = createTiktokenTokenizedOutputCounterLoader(),
  clock: TrackerClock = systemClock,
) {
  const state = createState();
  let counterPromise: Promise<TokenizedOutputCounter | null> | null = null;
  let counter: TokenizedOutputCounter | null = null;
  let counterModelId: string | undefined;

  function startCounterLoad(modelId: string | undefined) {
    if (counter && counterModelId === modelId) return Promise.resolve(counter);
    if (counterPromise && counterModelId === modelId) return counterPromise;
    counter = null;
    counterModelId = modelId;
    counterPromise = tokenCounterLoader
      .loadTokenizedOutputCounter(modelId)
      .then((loadedCounter) => {
        counter = loadedCounter;
        return loadedCounter;
      });
    return counterPromise;
  }

  function countTokensNow(text: string, modelId: string | undefined) {
    if (text.length === 0) return 0;
    if (!counter || counterModelId !== modelId) {
      void startCounterLoad(modelId);
      return null;
    }
    return counter.countOutputTokens(text);
  }

  function tokenCountForStatus(now: number, modelId: string | undefined) {
    if (now - state.lastTokenizedAt < TOKENIZE_INTERVAL_MS && state.tokenizedStreamedTokens > 0) {
      return state.tokenizedStreamedTokens;
    }
    const tokenizedTokens = countTokensNow(state.streamedText, modelId);
    state.lastTokenizedAt = now;
    if (tokenizedTokens != null) {
      state.tokenizedStreamedTokens = tokenizedTokens;
      return tokenizedTokens;
    }
    return state.estimatedStreamedTokens;
  }

  async function finalMessageTokens(officialTokens: number, modelId: string | undefined) {
    if (officialTokens > 0) return officialTokens;
    const loadedCounter = await startCounterLoad(modelId);
    const tokenizedTokens = loadedCounter?.countOutputTokens(state.streamedText);
    return tokenizedTokens ?? Math.round(state.estimatedStreamedTokens);
  }

  host.onAgentStart(async (_event, context) => {
    state.totalOutputTokens = 0;
    state.totalStreamMs = 0;
    resetMessageState(state);
    context.setStatus(STATUS_KEY, context.render("dim", "⏱ waiting for output..."));
    void startCounterLoad(context.modelId);
  });

  host.onMessageStart(async (event, context) => {
    if (event.message.role !== "assistant") return;
    state.messageStart = clock.now();
    state.streamStart = null;
    state.lastStreamAt = null;
    state.streamedText = "";
    state.estimatedStreamedTokens = 0;
    state.tokenizedStreamedTokens = 0;
    state.lastTokenizedAt = 0;
    void startCounterLoad(context.modelId);
  });

  host.onMessageUpdate(async (event, context) => {
    if (event.message.role !== "assistant") return;
    const delta = outputDeltaText(event);
    if (delta.length === 0) return;
    const now = clock.now();
    state.messageStart ??= now;
    state.streamStart ??= now;
    state.lastStreamAt = now;
    state.streamedText += delta;
    state.estimatedStreamedTokens += Math.max(0, delta.length / CHARS_PER_TOKEN);

    const elapsed = Math.max((now - state.streamStart) / 1000, 0);
    const officialTokens = outputTokens(event);
    const currentTokens = officialTokens || tokenCountForStatus(now, context.modelId);
    if (elapsed > 0 && currentTokens > 0) {
      const tps = currentTokens / elapsed;
      context.setStatus(
        STATUS_KEY,
        `${context.render("accent", tpsLabel(tps))} ${context.render(
          "dim",
          `(${tokenLabel(officialTokens, state.tokenizedStreamedTokens, state.estimatedStreamedTokens)} / ${elapsed.toFixed(1)}s)`,
        )}`,
      );
    }
  });

  host.onMessageEnd(async (event, context) => {
    if (event.message.role !== "assistant") return;
    const messageTokens = await finalMessageTokens(outputTokens(event), context.modelId);
    const timingStart = state.streamStart ?? state.messageStart;
    const timingEnd = state.lastStreamAt ?? clock.now();
    if (timingStart && timingEnd >= timingStart && messageTokens > 0) {
      state.totalOutputTokens += messageTokens;
      state.totalStreamMs += Math.max(0, timingEnd - timingStart);
    }
    resetMessageState(state);
  });

  host.onAgentEnd(async (_event, context) => {
    const elapsed = state.totalStreamMs / 1000;
    const tps = state.totalOutputTokens > 0 && elapsed > 0 ? state.totalOutputTokens / elapsed : 0;
    const icon = tps > 0 ? context.render("success", "✓") : context.render("dim", "•");
    const formattedTps =
      tps > 0 ? context.render("accent", tpsLabel(tps)) : context.render("dim", "N/A");
    const detail = context.render(
      "dim",
      `${Math.round(state.totalOutputTokens)} tokens in ${elapsed.toFixed(1)}s streaming`,
    );
    context.notify(`${icon} ${formattedTps}  ${detail}`);
    context.setStatus(STATUS_KEY, context.render("dim", `done — ${tpsLabel(tps)}`));
    resetMessageState(state);
  });
}

function tpsTrackerContext(context: ExtensionContext): TpsTrackerContext {
  return {
    modelId: context.model?.id,
    render: (color, text) => context.ui.theme.fg(color, text),
    notify: (message) => context.ui.notify(message, "info"),
    setStatus: (key, text) => context.ui.setStatus(key, text),
  };
}

/** Installs the TPS tracker into Pi's extension lifecycle. */
export default function tpsTrackerExtension(pi: ExtensionAPI) {
  registerTpsTracker({
    onAgentStart: (handler) =>
      pi.on("agent_start", (event, context) => handler(event, tpsTrackerContext(context))),
    onMessageStart: (handler) =>
      pi.on("message_start", (event, context) => handler(event, tpsTrackerContext(context))),
    onMessageUpdate: (handler) =>
      pi.on("message_update", (event, context) => handler(event, tpsTrackerContext(context))),
    onMessageEnd: (handler) =>
      pi.on("message_end", (event, context) => handler(event, tpsTrackerContext(context))),
    onAgentEnd: (handler) =>
      pi.on("agent_end", (event, context) => handler(event, tpsTrackerContext(context))),
  });
}
