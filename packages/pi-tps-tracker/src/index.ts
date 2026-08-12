/**
 * TPS Tracker Extension
 *
 * Tracks tokens per second during model generation and reports
 * final TPS statistics at the end of each agent run.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Tiktoken, TiktokenModel } from "tiktoken";

const STATUS_KEY = "tps";
const CHARS_PER_TOKEN = 4;
const TOKENIZE_INTERVAL_MS = 250;

type AssistantDeltaEvent = {
  type?: string;
  delta?: unknown;
};

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

type TiktokenModule = typeof import("tiktoken");

let encoderPromise: Promise<Tiktoken | null> | null = null;
let encoder: Tiktoken | null = null;
let encoderModelId: string | undefined;

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

function positiveFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function outputTokens(message: { usage?: { output?: unknown } }) {
  return positiveFiniteNumber(message.usage?.output);
}

function deltaText(delta: unknown) {
  if (typeof delta === "string") return delta;
  if (delta == null) return "";
  return String(delta);
}

function isOutputDelta(event: AssistantDeltaEvent) {
  return (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta"
  );
}

function tpsLabel(tps: number) {
  return tps > 0 ? `${Math.round(tps)} tok/s` : "N/A";
}

function modelId(ctx: ExtensionContext) {
  return ctx.model?.id;
}

function createEncoder(tiktoken: TiktokenModule, activeModelId: string | undefined) {
  if (!activeModelId) return tiktoken.get_encoding("o200k_base");

  try {
    return tiktoken.encoding_for_model(activeModelId as TiktokenModel);
  } catch {
    return tiktoken.get_encoding("o200k_base");
  }
}

function startEncoderLoad(activeModelId?: string) {
  if (encoder && encoderModelId === activeModelId) return Promise.resolve(encoder);
  if (encoderPromise && encoderModelId === activeModelId) return encoderPromise;

  encoder = null;
  encoderModelId = activeModelId;
  encoderPromise = import("tiktoken")
    .then((tiktoken: TiktokenModule) => {
      encoder = createEncoder(tiktoken, activeModelId);
      return encoder;
    })
    .catch(() => null);

  return encoderPromise;
}

function countTokensNow(text: string, activeModelId: string | undefined) {
  if (text.length === 0) return 0;
  if (!encoder || encoderModelId !== activeModelId) {
    void startEncoderLoad(activeModelId);
    return null;
  }

  return encoder.encode_ordinary(text).length;
}

function tokenCountForStatus(state: TrackerState, now: number, activeModelId: string | undefined) {
  if (now - state.lastTokenizedAt < TOKENIZE_INTERVAL_MS && state.tokenizedStreamedTokens > 0) {
    return state.tokenizedStreamedTokens;
  }

  const tokenizedTokens = countTokensNow(state.streamedText, activeModelId);
  state.lastTokenizedAt = now;

  if (tokenizedTokens != null) {
    state.tokenizedStreamedTokens = tokenizedTokens;
    return tokenizedTokens;
  }

  return state.estimatedStreamedTokens;
}

async function finalMessageTokens(
  state: TrackerState,
  officialTokens: number,
  activeModelId: string | undefined,
) {
  if (officialTokens > 0) return officialTokens;

  const tiktokenEncoder = await startEncoderLoad(activeModelId);
  const tokenizedTokens = tiktokenEncoder?.encode_ordinary(state.streamedText).length;
  if (tokenizedTokens != null) return tokenizedTokens;

  return Math.round(state.estimatedStreamedTokens);
}

function tokenLabel(officialTokens: number, tokenizedTokens: number, estimatedTokens: number) {
  if (officialTokens > 0) return `${Math.round(officialTokens)} tok`;
  if (tokenizedTokens > 0) return `${Math.round(tokenizedTokens)} tok`;
  return `~${Math.round(estimatedTokens)} tok`;
}

export default function (pi: ExtensionAPI) {
  const state = createState();

  pi.on("agent_start", async (_event, ctx) => {
    state.totalOutputTokens = 0;
    state.totalStreamMs = 0;
    resetMessageState(state);

    const theme = ctx.ui.theme;
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "⏱ waiting for output..."));
    void startEncoderLoad(modelId(ctx));
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    state.messageStart = Date.now();
    state.streamStart = null;
    state.lastStreamAt = null;
    state.streamedText = "";
    state.estimatedStreamedTokens = 0;
    state.tokenizedStreamedTokens = 0;
    state.lastTokenizedAt = 0;
    void startEncoderLoad(modelId(ctx));
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent as AssistantDeltaEvent;
    if (!isOutputDelta(streamEvent)) return;

    const delta = deltaText(streamEvent.delta);
    if (delta.length === 0) return;

    const now = Date.now();
    state.messageStart ??= now;
    state.streamStart ??= now;
    state.lastStreamAt = now;
    state.streamedText += delta;
    state.estimatedStreamedTokens += Math.max(0, delta.length / CHARS_PER_TOKEN);

    const elapsed = Math.max((now - state.streamStart) / 1000, 0);
    const officialTokens = outputTokens(event.message);
    const currentTokens = officialTokens || tokenCountForStatus(state, now, modelId(ctx));

    if (elapsed > 0 && currentTokens > 0) {
      const tps = currentTokens / elapsed;
      const theme = ctx.ui.theme;
      ctx.ui.setStatus(
        STATUS_KEY,
        `${theme.fg("accent", tpsLabel(tps))} ${theme.fg(
          "dim",
          `(${tokenLabel(
            officialTokens,
            state.tokenizedStreamedTokens,
            state.estimatedStreamedTokens,
          )} / ${elapsed.toFixed(1)}s)`,
        )}`,
      );
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const messageTokens = await finalMessageTokens(
      state,
      outputTokens(event.message),
      modelId(ctx),
    );
    const timingStart = state.streamStart ?? state.messageStart;
    const timingEnd = state.lastStreamAt ?? Date.now();

    if (timingStart && timingEnd >= timingStart && messageTokens > 0) {
      state.totalOutputTokens += messageTokens;
      state.totalStreamMs += Math.max(0, timingEnd - timingStart);
    }

    resetMessageState(state);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const elapsed = state.totalStreamMs / 1000;
    const tps = state.totalOutputTokens > 0 && elapsed > 0 ? state.totalOutputTokens / elapsed : 0;

    const theme = ctx.ui.theme;
    const icon = tps > 0 ? theme.fg("success", "✓") : theme.fg("dim", "•");
    const formattedTps = tps > 0 ? theme.fg("accent", tpsLabel(tps)) : theme.fg("dim", "N/A");
    const detail = theme.fg(
      "dim",
      `${Math.round(state.totalOutputTokens)} tokens in ${elapsed.toFixed(1)}s streaming`,
    );

    ctx.ui.notify(`${icon} ${formattedTps}  ${detail}`, "info");
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `done — ${tpsLabel(tps)}`));
    resetMessageState(state);
  });
}
