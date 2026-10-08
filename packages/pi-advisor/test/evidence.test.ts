import { expect, it } from "vitest";
import { fauxAssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import {
  messageOrigins,
  projectEvidence,
  projectObservedSetup,
  selectContextSeed,
  toolCallRef,
} from "../src/advisor-evidence.js";
import { seedBudget, sessionTokenLimit } from "../src/advisor-settings.js";

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

const code = (index: number) =>
  `export function parse${index}(input: string): Node {\n  if (input === "\\n") return { "kind": "newline", "path": "C:\\\\src\\\\${index}" };\n\treturn parseExpression(input, { "strict": true });\n}\n`;

/** A long observed conversation: one request, then tool batches with the given results. */
function conversation(batches: number, result: (index: number) => string): Message[] {
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
        content: [{ type: "text", text: result(index) }],
        isError: false,
        timestamp: 2,
      },
    );
  }
  messages.push({ ...assistant([{ type: "text", text: "Refactor done." }]), stopReason: "stop" });
  return messages;
}

/** Pi's chars/4 estimate of the seed JSON a Review actually receives. */
const sentTokens = (seed: ReturnType<typeof selectContextSeed>) =>
  Math.ceil(
    JSON.stringify({ observedSetup: seed.observedSetup, messages: seed.messages }).length / 4,
  );

it.each([
  ["large results", conversation(40, (index) => `result ${index} ${"x".repeat(4000)}`)],
  ["many small turns", conversation(600, (index) => `ok ${index}`)],
  ["code-heavy results", conversation(40, (index) => code(index).repeat(40))],
])("bounds the sent Context Seed by its token budget with %s", (_name, messages) => {
  const budget = 6_000;
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: budget });
  const full = selectContextSeed({ ...transcript, messages }, { budgetTokens: 10_000_000 });
  expect(sentTokens(full)).toBeGreaterThan(budget * 2);
  expect(sentTokens(seed)).toBeLessThanOrEqual(budget);
  // The budget is used, not merely respected.
  expect(sentTokens(seed)).toBeGreaterThan(budget * 0.75);
  expect(seed.observedSetup).toEqual(projectObservedSetup(transcript));
  expect(seed.messages[0]).toEqual({
    role: "user",
    content: "Original request: refactor the parser.",
  });
  expect(seed.messages.at(-1)).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Refactor done." }],
  });
  // After the request, the newest messages form one contiguous tail.
  const tail = seed.kept.slice(1);
  expect(tail).toEqual(tail.map((_position, index) => messages.length - tail.length + index));
  expect(seed.kept[1]).toBeGreaterThan(1);
});

it("seeds the whole conversation when it fits the budget", () => {
  const messages = conversation(3, (index) => `result ${index}`);
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: 1_000_000 });
  expect(seed.messages).toEqual(projectEvidence(messages).messages);
  expect(seed.kept).toEqual(messages.map((_message, index) => index));
  expect(seed.shortened).toBe(0);
});

it("never separates a tool call from its result at any budget", () => {
  const messages = conversation(4, (index) => `result ${index} ${"y".repeat(3000 * index)}`);
  messages.splice(
    -1,
    0,
    assistant([
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
    ]),
    ...["a", "b"].map((id): Message => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: "z".repeat(5000) }],
      isError: false,
      timestamp: 3,
    })),
  );
  for (let budget = 100; budget < 8_000; budget += 250) {
    const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: budget });
    const calls = seed.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.ref] : []))
        : [],
    );
    const results = seed.messages.flatMap((message) =>
      message.role === "toolResult" ? [message.ref] : [],
    );
    expect(results).toEqual(calls);
  }
});

it("always keeps the newest turn and its request, shortening oversized text with a marker", () => {
  const messages: Message[] = [
    ...conversation(3, (index) => `result ${index}`),
    { role: "user", content: "Now read the big log.", timestamp: 3 },
    assistant([{ type: "toolCall", id: "log", name: "read", arguments: { path: "big.log" } }]),
    {
      role: "toolResult",
      toolCallId: "log",
      toolName: "read",
      content: [{ type: "text", text: "L".repeat(200_000) }],
      isError: false,
      timestamp: 4,
    },
  ];
  for (const budget of [3_000, 200]) {
    const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: budget });
    const [request, prompt, call, result] = seed.messages;
    expect(request).toEqual({ role: "user", content: "Original request: refactor the parser." });
    expect(prompt).toEqual({ role: "user", content: "Now read the big log." });
    expect(call).toMatchObject({ role: "assistant", content: [{ name: "read" }] });
    expect(result).toMatchObject({ role: "toolResult", ref: toolCallRef("log") });
    expect(JSON.stringify(result)).toMatch(/characters omitted from the Context Seed/);
    expect(seed.kept.slice(-3)).toEqual([
      messages.length - 3,
      messages.length - 2,
      messages.length - 1,
    ]);
    expect(seed.shortened).toBeGreaterThan(0);
    if (budget === 3_000) expect(sentTokens(seed)).toBeLessThanOrEqual(budget);
  }
});

it("takes the original request from real user requests, not converted summaries or findings", () => {
  const user = (content: string, timestamp: number): Message => ({
    role: "user",
    content,
    timestamp,
  });
  const summary = user("The conversation history before this point was compacted: parser goal.", 1);
  const nitText = "Advisor nit: rename the helper.";
  const nit = user(nitText, 2);
  const command = user("Ran `ls`\n```\nsrc\n```", 3);
  const request = user("Now also add tests.", 4);
  const rest = conversation(8, (index) => `result ${index} ${"x".repeat(2000)}`).slice(1);
  const messages = [summary, nit, command, request, ...rest];
  const origins = messageOrigins(messages, [
    { role: "compactionSummary", summary: "parser goal.", tokensBefore: 1, timestamp: 1 },
    { role: "custom", customType: "pi-advisor", content: nitText, display: true, timestamp: 2 },
    {
      role: "bashExecution",
      command: "ls",
      output: "src",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 3,
    },
    request,
    ...rest,
  ]);
  expect(origins.slice(0, 4)).toEqual(["compactionSummary", "custom", "bashExecution", "user"]);
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: 1_500, origins });
  expect(seed.messages.slice(0, 2)).toEqual([
    { role: "user", content: summary.content },
    { role: "user", content: request.content },
  ]);
  // Without a compaction summary, a finding delivered before the request is not the request.
  const uncompacted = selectContextSeed(
    { ...transcript, messages: messages.slice(1) },
    { budgetTokens: 1_500, origins: origins.slice(1) },
  );
  expect(uncompacted.messages[0]).toEqual({ role: "user", content: request.content });
});

it("pairs messages that share a timestamp in order when a context hook rewrote one", () => {
  const typed = [
    { type: "text", text: "Describe this screenshot." },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  ] as const;
  // Image blocking rewrote the request, and a before_agent_start message shares its timestamp.
  const messages: Message[] = [
    { role: "user", content: [typed[0]], timestamp: 5 },
    { role: "user", content: [{ type: "text", text: "Injected reminder" }], timestamp: 5 },
  ];
  expect(
    messageOrigins(messages, [
      { role: "user", content: [...typed], timestamp: 5 },
      {
        role: "custom",
        customType: "reminder",
        content: "Injected reminder",
        display: false,
        timestamp: 5,
      },
    ]),
  ).toEqual(["user", "custom"]);
});

it("keeps no original request when compaction cut the turn that held it", () => {
  const summary: Message = { role: "user", content: "Compacted: parser goal.", timestamp: 1 };
  const concern: Message = {
    role: "user",
    content: "Advisor concern: tests skipped.",
    timestamp: 2,
  };
  const messages: Message[] = [
    summary,
    concern,
    ...conversation(1, () => "L".repeat(50_000)).slice(1),
  ];
  const origins = messageOrigins(messages, [
    { role: "compactionSummary", summary: "parser goal.", tokensBefore: 1, timestamp: 1 },
    {
      role: "custom",
      customType: "pi-advisor",
      content: "Advisor concern: tests skipped.",
      display: true,
      timestamp: 2,
    },
  ]);
  expect(origins.slice(0, 2)).toEqual(["compactionSummary", "custom"]);
  const seed = selectContextSeed({ ...transcript, messages }, { budgetTokens: 800, origins });
  // The summary is the original request; the delivered concern is not, so it is omitted.
  expect(seed.kept).toEqual([0, 2, 3, 4]);
  expect(seed.messages[0]).toEqual({ role: "user", content: summary.content });
});

it("derives the automatic seed budget from the Advisor model's context window", () => {
  expect(seedBudget("auto", 200_000)).toBe(50_000);
  // Large windows are capped absolutely, below the automatic Advisor Session cap.
  expect(seedBudget("auto", 400_000)).toBe(50_000);
  expect(seedBudget("auto", 1_000_000)).toBe(50_000);
  // Models without a declared window use Pi's 128k fallback.
  expect(seedBudget("auto", 0)).toBe(32_000);
  expect(seedBudget(12_345, 200_000)).toBe(12_345);
  // An explicit budget never exceeds a declared window.
  expect(seedBudget(500_000, 200_000)).toBe(200_000);
  expect(seedBudget(500_000, undefined)).toBe(500_000);
});

it("derives the automatic Advisor Session cap from the window, bounded absolutely", () => {
  expect(sessionTokenLimit("auto", 200_000)).toBe(100_000);
  expect(sessionTokenLimit("auto", 400_000)).toBe(100_000);
  expect(sessionTokenLimit("auto", 1_000_000)).toBe(100_000);
  // Smaller windows keep their fractions, below the ceilings.
  expect(sessionTokenLimit("auto", 128_000)).toBe(64_000);
  // Models without a declared window use Pi's 128k fallback.
  expect(sessionTokenLimit("auto", 0)).toBe(64_000);
  // An automatic Context Seed always fits under the automatic cap.
  for (const window of [0, 32_000, 200_000, 400_000, 1_000_000, 2_000_000])
    expect(seedBudget("auto", window)).toBeLessThanOrEqual(sessionTokenLimit("auto", window) / 2);
  expect(sessionTokenLimit(150_000, 1_000_000)).toBe(150_000);
  // An explicit cap never exceeds a declared window.
  expect(sessionTokenLimit(500_000, 200_000)).toBe(200_000);
  expect(sessionTokenLimit(500_000, undefined)).toBe(500_000);
});
