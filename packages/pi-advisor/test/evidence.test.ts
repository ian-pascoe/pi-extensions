import { expect, it } from "vitest";
import { fauxAssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  projectEvidence,
  projectObservedSetup,
  selectContextSeed,
  toolCallRef,
} from "../src/advisor-evidence.js";
import { seedBudget } from "../src/advisor-settings.js";

const longCallId = `call_${"x".repeat(420)}|fc_${"y".repeat(40)}`;
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
const usage = fauxAssistantMessage("").usage;
const assistant = (content: Extract<Message, { role: "assistant" }>["content"]) => ({
  ...fauxAssistantMessage(""),
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "fixture-model",
  responseId: "msg_01FixtureResponseIdentifier",
  usage,
  stopReason: "toolUse" as const,
  timestamp: 1700000000000,
});

/** A representative observed transcript as Pi stores it, signatures and display details included. */
const transcript: Context = {
  systemPrompt: "You are a coding agent. Follow the user's instructions.",
  tools: [
    {
      name: "read",
      description: `Read the contents of a file. Supports text files and images.\n${"Long usage guidance. ".repeat(40)}`,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path to read".repeat(10) } },
        required: ["path"],
      },
    },
    {
      name: "bash",
      description: "Execute a bash command in the current working directory",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Command".repeat(20) } },
        required: ["command"],
      },
    },
  ],
  messages: [
    { role: "user", content: "Fix the failing parser test.", timestamp: 1700000000000 },
    assistant([
      {
        type: "thinking",
        thinking: "I should read the parser first.",
        thinkingSignature: "S".repeat(1200),
      },
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "E".repeat(800),
        redacted: true,
      },
      { type: "text", text: "Reading the parser.", textSignature: "T".repeat(120) },
      {
        type: "toolCall",
        id: longCallId,
        name: "read",
        arguments: { path: "src/parser.ts" },
        thoughtSignature: "G".repeat(600),
      },
    ]),
    {
      role: "toolResult",
      toolCallId: longCallId,
      toolName: "read",
      content: [{ type: "text", text: "ENOENT: src/parser.ts" }, image],
      details: { screen: "#".repeat(3000), truncation: { content: "~".repeat(1000) } },
      nestedCalls: { calls: [{ id: "nested", name: "ls", status: "ok" }], complete: true },
      isError: true,
      timestamp: 1700000000001,
    },
    {
      role: "user",
      content: [{ type: "text", text: "Here is the screenshot." }, image],
      timestamp: 1700000000002,
    },
    {
      ...assistant([{ type: "text", text: "Partial" }]),
      stopReason: "error",
      errorMessage: "Provider overloaded",
      diagnostics: [
        {
          type: "provider_retry",
          timestamp: 1700000000003,
          details: { transformations: ["~".repeat(500)] },
        },
      ],
    },
    { ...assistant([{ type: "text", text: "Truncated answ" }]), stopReason: "length" },
  ],
};

/** The pre-#339 projection: Pi's stored messages verbatim, images swapped for attachment indexes. */
function legacySeed(context: Context): string {
  let attachment = 0;
  const messages = context.messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) =>
          block.type === "image" ? { type: "image", attachment: ++attachment } : block,
        )
      : message.content,
  }));
  return JSON.stringify({
    context: { systemPrompt: context.systemPrompt, tools: context.tools },
    messages,
  });
}

function projectedSeed(context: Context): string {
  return JSON.stringify({
    observedSetup: projectObservedSetup(context),
    messages: projectEvidence(context.messages).messages,
  });
}

/** Every object key in a JSON document, at any depth. */
function keys(json: string): Set<string> {
  const seen = new Set<string>();
  JSON.parse(json, (key, value) => {
    seen.add(key);
    return value;
  });
  return seen;
}

it("projects Review evidence to what the observed model received", () => {
  const { messages, images } = projectEvidence(transcript.messages);
  const ref = toolCallRef(longCallId);
  expect(ref).toMatch(/^[\w-]{8}$/);
  expect(messages).toEqual([
    { role: "user", content: "Fix the failing parser test." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should read the parser first." },
        { type: "thinking", redacted: true },
        { type: "text", text: "Reading the parser." },
        { type: "toolCall", ref, name: "read", arguments: { path: "src/parser.ts" } },
      ],
    },
    {
      role: "toolResult",
      ref,
      toolName: "read",
      isError: true,
      content: [
        { type: "text", text: "ENOENT: src/parser.ts" },
        { type: "image", attachment: 1 },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Here is the screenshot." },
        { type: "image", attachment: 2 },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Partial" }],
      stopReason: "error",
      errorMessage: "Provider overloaded",
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Truncated answ" }],
      stopReason: "length",
    },
  ]);
  expect(images).toEqual([image, image]);
});

it("keeps tool-call references compact and stable across projections", () => {
  expect(toolCallRef(longCallId)).toBe(toolCallRef(longCallId));
  expect(toolCallRef("call-1")).not.toBe(toolCallRef("call-2"));
  const later = projectEvidence(transcript.messages.slice(2)).messages[0];
  expect(later).toMatchObject({ role: "toolResult", ref: toolCallRef(longCallId) });
});

it("presents the Observed Setup as tool names with one-line summaries", () => {
  expect(projectObservedSetup(transcript)).toEqual({
    systemPrompt: transcript.systemPrompt,
    tools: [
      { name: "read", summary: "Read the contents of a file." },
      { name: "bash", summary: "Execute a bash command in the current working directory" },
    ],
  });
});

it("drops signatures, display details and provider metadata from the seed", () => {
  const before = legacySeed(transcript);
  const after = projectedSeed(transcript);
  const forbidden = [
    "thinkingSignature",
    "textSignature",
    "thoughtSignature",
    "signature",
    "details",
    "nestedCalls",
    "responseId",
    "api",
    "provider",
    "usage",
    "timestamp",
    "toolCallId",
    "id",
    "parameters",
    "diagnostics",
    "transformations",
  ];
  expect([...keys(after)].filter((key) => forbidden.includes(key))).toEqual([]);
  const signatureAndDetails =
    JSON.stringify(transcript.messages).length -
    JSON.stringify(
      transcript.messages.map((message) =>
        JSON.parse(
          JSON.stringify(message, (key, value) =>
            /signature$/i.test(key) || key === "details" || key === "diagnostics"
              ? undefined
              : value,
          ),
        ),
      ),
    ).length;
  expect(before.length - after.length).toBeGreaterThanOrEqual(signatureAndDetails);
  // Recorded fixture sizes (characters of seed JSON), before and after #339.
  expect({ before: before.length, after: after.length }).toEqual({ before: 11914, after: 1071 });
});

it("omits unknown future content and tolerates malformed tool-call IDs", () => {
  const future: Message[] = JSON.parse(
    JSON.stringify([
      {
        role: "assistant",
        content: [
          { type: "serverToolUse", payload: "opaque" },
          { type: "toolCall", name: "read" },
        ],
        stopReason: "toolUse",
      },
      { role: "user", content: [{ type: "audio", data: "opaque" }] },
      { role: "futureRole", content: "opaque" },
    ]),
  );
  expect(projectEvidence(future).messages).toEqual([
    {
      role: "assistant",
      content: [{ type: "toolCall", ref: expect.stringMatching(/^[\w-]{8}$/), name: "read" }],
    },
    { role: "user", content: [] },
  ]);
});

/** A long observed conversation: one request, then many tool batches with large results. */
function longConversation(batches: number): Message[] {
  const messages: Message[] = [
    { role: "user", content: "Original request: refactor the parser.", timestamp: 1 },
  ];
  for (let index = 0; index < batches; index++) {
    messages.push(
      assistant([
        { type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `f${index}` } },
      ]),
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read",
        content: [{ type: "text", text: `result ${index} ${"x".repeat(4000)}` }],
        isError: false,
        timestamp: 2,
      },
    );
  }
  messages.push({ ...assistant([{ type: "text", text: "Refactor done." }]), stopReason: "stop" });
  return messages;
}

const seedTokens = (seed: ReturnType<typeof selectContextSeed>) =>
  estimateTokens({ role: "user", content: JSON.stringify(seed.observedSetup), timestamp: 0 }) +
  seed.messages.reduce((total, message) => total + estimateTokens(message), 0);

it("bounds the Context Seed by its token budget, keeping the setup, request and newest tool batches", () => {
  const messages = longConversation(40);
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: 6_000 });
  expect(seedTokens(seed)).toBeLessThanOrEqual(6_000);
  expect(seed.observedSetup).toEqual(projectObservedSetup(transcript));
  expect(seed.messages[0]).toBe(messages[0]);
  expect(seed.messages.at(-1)).toBe(messages.at(-1));
  // The newest messages form one contiguous tail that starts at a whole tool batch.
  const tail = seed.messages.slice(1);
  const start = messages.findIndex((message) => message === tail[0]);
  expect(tail).toEqual(messages.slice(start));
  expect(messages[start]?.role).toBe("assistant");
  expect(tail.length).toBeGreaterThan(2);
  expect(seed.omitted).toBe(messages.length - seed.messages.length);
  expect(seed.omitted).toBeGreaterThan(0);
});

it("seeds the whole conversation when it fits the budget", () => {
  const messages = longConversation(3);
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: 1_000_000 });
  expect(seed.messages).toEqual(messages);
  expect(seed.omitted).toBe(0);
});

it("never splits a tool call from its result, even when only part of a batch would fit", () => {
  const messages = longConversation(4);
  const parallel = assistant([
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
  ]);
  const result = (id: string): Message => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "y".repeat(4000) }],
    isError: false,
    timestamp: 3,
  });
  const reply = messages.pop();
  if (!reply) throw new Error("Missing final reply");
  messages.push(parallel, result("a"), result("b"), reply);
  // Room for the final reply and one of the two results, but not the whole batch.
  const budget =
    seedTokens(
      selectContextSeed({ ...transcript, messages: messages.slice(0, 1) }, { budgetTokens: 0 }),
    ) +
    estimateTokens(reply) +
    estimateTokens(result("b")) +
    estimateTokens(parallel);
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: budget });
  expect(seed.messages).toEqual([messages[0], reply]);
});

it("keeps the compaction summary and the first request after it as the original request", () => {
  const summary: Message = {
    role: "user",
    content:
      "The conversation history before this point was compacted: goal is the parser refactor.",
    timestamp: 1,
  };
  const followUp: Message = { role: "user", content: "Now also add tests.", timestamp: 4 };
  const kept = longConversation(6).slice(1);
  const messages = [summary, ...kept.slice(0, 6), followUp, ...kept.slice(6)];
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: 0, compacted: true });
  expect(seed.messages).toEqual([summary, followUp]);
  expect(seed.omitted).toBe(messages.length - 2);
  // Without compaction only the first user message is the original request.
  expect(selectContextSeed({ ...transcript, messages }, { budgetTokens: 0 }).messages).toEqual([
    summary,
  ]);
});

it("derives the automatic seed budget from the Advisor model's context window", () => {
  expect(seedBudget("auto", 200_000)).toBe(50_000);
  expect(seedBudget("auto", 1_000_000)).toBe(250_000);
  // Models without a declared window use Pi's 128k fallback.
  expect(seedBudget("auto", 0)).toBe(32_000);
  expect(seedBudget(12_345, 200_000)).toBe(12_345);
});
