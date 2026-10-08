import { onTestFinished, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  AgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AdvisorFinding } from "../../src/advisor-contract.js";
import "./observer-extension.js";

/** Pi 0.86+ stores the system prompt as the leading session message. */
export const conversation = <T extends { role: string }>(messages: T[]) =>
  messages.filter((message) => message.role !== "system");

/**
 * An observed SDK session using the offline fixture provider; `settings` extend its defaults and
 * `extensions` are loaded after the fixture extension.
 */
export async function activeFixture(
  settings: NonNullable<Parameters<typeof SettingsManager.inMemory>[0]> = {},
  extensions: string[] = [],
) {
  const dir = await mkdtemp(join(tmpdir(), "advisor-observer-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...settings,
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./observer-extension.ts", import.meta.url)),
        ...extensions,
      ],
    },
  });
  const model = modelRuntime.getModel("observer-fixture", "model");
  if (!model) throw new Error("Missing fixture model");
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("No replacement");
  });
  await runtime.session.bindExtensions({ mode: "print" });
  onTestFinished(async () => {
    await runtime.session.abort();
    await runtime.dispose();
  });
  return runtime.session;
}

/** One private Advisor request: its full context and the prompt text it ends with. */
export interface PrivateRequest {
  systemPrompt: Context["systemPrompt"];
  tools: { name: string; description: string; parameters: unknown }[];
  messages: Context["messages"];
  text: string;
  /** Private compaction summaries requested before this request. */
  summariesBefore: number;
}

/** Fixture behavior beyond the observed tool batches. */
export interface LongSessionOptions {
  /** Observed tool-result text by batch ID. */
  result?: (id: string) => string;
  /** Whether an observed tool result is an error; unset keeps the native (missing-file) error. */
  isError?: (id: string) => boolean;
  /**
   * Arguments of the `advisor_report` call answering each Review request, in order, or a
   * legacy single-finding report.
   */
  report?: (
    review: number,
    request: PrivateRequest,
  ) => { findings: AdvisorFinding[] } | { severity: string; message?: string };
  /** Usage recorded on every private Advisor response, such as a priced cost. */
  usage?: AssistantMessage["usage"];
  /** Report each private response's input as Pi's chars/4 estimate of its context. */
  reportContextTokens?: boolean;
  /**
   * Report each private response's input as its provider would: the cached system prompt and
   * tools at Pi's estimate, and the messages at this multiple of Pi's chars/4 estimate.
   */
  tokenRatio?: number;
  /** Private compaction summary requests, recorded in order. */
  summaries?: Context[];
  /** Milliseconds each Review response is held, by timer, before it completes. */
  reviewDelayMs?: number;
  /** Milliseconds each compaction summary is held, by timer, before it completes. */
  summaryDelayMs?: number;
  /** Hold every compaction summary until its request is aborted. */
  hangSummaries?: boolean;
  /** Error message for the first observed response, such as a retryable provider error. */
  firstError?: string;
  /** Delay the response to a Review request, such as until the observed agent moves on. */
  hold?: (review: number, request: PrivateRequest) => Promise<void> | undefined;
}

/**
 * A long observed session: each request runs its listed number of tool batches, whose results
 * `result` writes. Private requests are recorded in order.
 */
export function longSessionStream(
  batches: Record<string, number>,
  privateRequests: PrivateRequest[],
  options: LongSessionOptions = {},
) {
  const {
    result = (id: string) => `result ${id} ${"x".repeat(8_000)}`,
    isError,
    report = () => ({ findings: [] }),
    usage,
    reportContextTokens,
    tokenRatio,
    summaries,
    reviewDelayMs,
    summaryDelayMs,
    hangSummaries,
    hold,
  } = options;
  let { firstError } = options;
  let reviews = 0;
  let summaryCount = 0;
  return {
    stream(model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      let held: Promise<void> | undefined;
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        const request = context.messages.at(-1);
        const text =
          request?.role === "user" && Array.isArray(request.content)
            ? request.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("")
            : "";
        const recorded: PrivateRequest = {
          systemPrompt: context.systemPrompt,
          tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
          messages: structuredClone(context.messages),
          text,
          summariesBefore: summaryCount,
        };
        privateRequests.push(structuredClone(recorded));
        if (usage) message.usage = structuredClone(usage);
        if (reportContextTokens) {
          const input = Math.ceil(JSON.stringify(context).length / 4);
          message.usage = { ...message.usage, input, totalTokens: input + message.usage.output };
        }
        if (tokenRatio) {
          const setup = Math.ceil(JSON.stringify([context.systemPrompt, context.tools]).length / 4);
          const input =
            setup + Math.ceil(Math.ceil(JSON.stringify(context.messages).length / 4) * tokenRatio);
          message.usage = { ...message.usage, input, totalTokens: input + message.usage.output };
        }
        if (!text.startsWith("Consultation request")) {
          message.content = [
            {
              type: "toolCall",
              id: `report-${++reviews}`,
              name: "advisor_report",
              arguments: report(reviews, recorded),
            },
          ];
          message.stopReason = "toolUse";
          held = hold?.(reviews, recorded);
        }
      } else if (!context.tools?.length) {
        summaryCount++;
        summaries?.push(structuredClone(context));
        if (hangSummaries) {
          streamOptions?.signal?.addEventListener(
            "abort",
            () =>
              stream.push({
                type: "error",
                reason: "aborted",
                error: { ...message, stopReason: "aborted" },
              }),
            { once: true },
          );
          return stream;
        }
        if (usage) message.usage = structuredClone(usage);
        message.content = [
          { type: "text", text: "Summary: the user asked to refactor the parser." },
        ];
      } else if (firstError) {
        const errorMessage = firstError;
        firstError = undefined;
        queueMicrotask(() =>
          stream.push({
            type: "error",
            reason: "error",
            error: { ...message, stopReason: "error", errorMessage },
          }),
        );
        return stream;
      } else {
        const start = context.messages.findLastIndex((entry) => entry.role === "user");
        const request = context.messages[start];
        const text = request?.role === "user" ? JSON.stringify(request.content) : "";
        const done = context.messages.slice(start).filter((entry) => entry.role === "toolResult");
        const planned = Object.entries(batches).find(([prompt]) => text.includes(prompt))?.[1];
        if (done.length < (planned ?? 0)) {
          const id = `${start}-${done.length}`;
          message.content = [
            { type: "toolCall", id, name: "read", arguments: { path: `/missing-advisor-${id}` } },
          ];
          message.stopReason = "toolUse";
        }
      }
      const done = () =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      const delay = privateRole ? reviewDelayMs : context.tools?.length ? 0 : summaryDelayMs;
      if (held) void held.then(done);
      else if (delay) setTimeout(done, delay);
      else queueMicrotask(done);
      return stream;
    },
    toolResult: (event: ToolResultEvent): ToolResultEventResult => {
      const rewritten: ToolResultEventResult = {
        content: [{ type: "text", text: result(event.toolCallId) }],
      };
      if (isError) rewritten.isError = isError(event.toolCallId);
      return rewritten;
    },
  };
}

/** A private prompt's header line and its JSON payload, exactly as sent. */
export function seedPayload(request: PrivateRequest | undefined) {
  const text = request?.text ?? "";
  const newline = text.indexOf("\n");
  const json = text.slice(newline + 1);
  return {
    header: text.slice(0, newline),
    /** Pi's chars/4 estimate of the payload the Advisor received. */
    tokens: Math.ceil(json.length / 4),
    evidence: JSON.parse(json || "{}"),
  };
}

/** Advisor prompt-cache proof: a later request extends the earlier context unchanged. */
export function expectPrefix(
  later: PrivateRequest | undefined,
  earlier: PrivateRequest | undefined,
) {
  expect(earlier?.messages.length).toBeGreaterThan(0);
  expect(later?.messages.slice(0, earlier?.messages.length)).toEqual(earlier?.messages);
}
