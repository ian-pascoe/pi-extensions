import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  combineEvidence,
  evidenceItemsCost,
  evidenceRefs,
  evidenceTokens,
  fitEvidence,
  messageOrigins,
  projectEvidence,
  projectEvidenceItem,
  shortenEvidence,
  toolCallRef,
  type EvidenceItem,
} from "../src/evidence.js";

const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } as const;
const assistant = (content: Extract<Message, { role: "assistant" }>["content"]) => ({
  ...fauxAssistantMessage(""),
  content,
  stopReason: "toolUse" as const,
});
const marker = (omitted: number) => `[cut ${omitted}]`;

const messages: Message[] = [
  { role: "user", content: "Do it.", timestamp: 1 },
  assistant([
    { type: "thinking", thinking: "plan", thinkingSignature: "S" },
    { type: "thinking", thinking: "", thinkingSignature: "S" },
    { type: "thinking", thinking: "x", thinkingSignature: "E", redacted: true },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } },
  ]),
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "T".repeat(500) }, image],
    isError: false,
    timestamp: 3,
  },
  { ...assistant([{ type: "text", text: "done" }]), stopReason: "error", errorMessage: "boom" },
];

const items = (source: readonly Message[]): EvidenceItem[] =>
  source.flatMap((message) => {
    const item = projectEvidenceItem(message);
    return item ? [item] : [];
  });

describe("evidence projection", () => {
  it("projects messages and links calls to results by reference", () => {
    const evidence = projectEvidence(messages);
    const ref = toolCallRef("call-1");
    expect(ref).toMatch(/^[\w-]{8}$/);
    expect(evidence.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "thinking", redacted: true },
        { type: "toolCall", ref, name: "read", arguments: { path: "a" } },
      ],
    });
    expect(evidence.messages[3]).toMatchObject({ stopReason: "error", errorMessage: "boom" });
    expect(evidence.images).toEqual([image]);
    expect(evidenceRefs(evidence.messages)).toEqual([ref, ref]);
    expect(toolCallRef("call-1")).toBe(toolCallRef("call-1"));
  });

  it("projects one message with its own images, or nothing for an unknown role", () => {
    const [toolResult] = messages.slice(2, 3);
    expect(toolResult && projectEvidenceItem(toolResult)).toEqual({
      message: projectEvidence(messages.slice(2, 3)).messages[0],
      images: [image],
    });
    const [future]: Message[] = JSON.parse(JSON.stringify([{ role: "futureRole", content: "x" }]));
    expect(future && projectEvidenceItem(future)).toBeUndefined();
  });

  it("estimates tokens from the serialized messages plus images", () => {
    const text = projectEvidence(messages.slice(0, 1));
    expect(evidenceTokens(text)).toBe(Math.ceil(JSON.stringify(text.messages).length / 4));
    expect(evidenceTokens(projectEvidence(messages))).toBeGreaterThan(
      evidenceTokens({ ...projectEvidence(messages), images: [] }),
    );
  });

  it("attributes converted user messages to their original role", () => {
    const origins = messageOrigins(
      [
        { role: "user", content: "hello", timestamp: 5 },
        { role: "user", content: "Command output", timestamp: 6 },
      ],
      [
        { role: "user", content: "hello", timestamp: 5 },
        {
          role: "bashExecution",
          command: "ls",
          output: "x",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 6,
        },
      ],
    );
    expect(origins).toEqual(["user", "bashExecution"]);
  });

  it("pairs a rewritten message with the next unused source of its timestamp", () => {
    const bash = (timestamp: number) =>
      ({
        role: "bashExecution",
        command: "ls",
        output: "x",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp,
      }) as const;
    // A context hook rewrote the text, so no converted source matches exactly.
    expect(
      messageOrigins([{ role: "user", content: "rewritten", timestamp: 6 }], [bash(6)]),
    ).toEqual(["bashExecution"]);
    expect(
      messageOrigins([{ role: "user", content: "rewritten", timestamp: 9 }], [bash(6)]),
    ).toEqual(["unknown"]);
  });

  it("keeps messages that share a timestamp apart by content, then by order", () => {
    const custom = (content: string) =>
      ({ role: "custom", customType: "note", content, display: true, timestamp: 7 }) as const;
    const user = (content: string): Message => ({ role: "user", content, timestamp: 7 });
    const sources = [custom("finding"), { role: "user", content: "hello", timestamp: 7 } as const];
    // Exact conversions claim their own source regardless of position.
    expect(
      messageOrigins(
        [
          { role: "user", content: [{ type: "text", text: "finding" }], timestamp: 7 },
          user("hello"),
        ],
        sources,
      ),
    ).toEqual(["custom", "user"]);
    // One exact match leaves the remaining source to the one rewritten message.
    expect(messageOrigins([user("changed"), user("hello")], sources)).toEqual(["custom", "user"]);
    // Nothing exact: the k-th unmatched message takes the k-th unused source.
    expect(messageOrigins([user("a"), user("b")], sources)).toEqual(["custom", "user"]);
    expect(messageOrigins([user("a"), user("b"), user("c")], sources)).toEqual([
      "custom",
      "user",
      "unknown",
    ]);
  });
});

describe("evidence shortening and fitting", () => {
  it("shortens long text and arguments with the caller's marker", () => {
    const source = items(messages);
    const [, call, result] = shortenEvidence(source, 10, marker);
    expect(result?.message).toMatchObject({
      content: [{ type: "text", text: `${"T".repeat(10)}\n[cut 490]` }, { type: "image" }],
    });
    expect(result?.images).toEqual([image]);
    expect(call).toBe(source[1]);
  });

  it("keeps unchanged items by identity and never grows text", () => {
    const source = items(messages);
    const shortened = shortenEvidence(source, 10, marker);
    expect(shortened[0]).toBe(source[0]);
    expect(shortened[3]).toBe(source[3]);
    expect(shortenEvidence(source, 1000, marker)).toEqual(source);
  });

  it("marks oversized tool-call arguments as non-parsing JSON", () => {
    const call = items([
      assistant([
        { type: "toolCall", id: "c", name: "write", arguments: { text: "A".repeat(400) } },
      ]),
    ]);
    const [shortened] = shortenEvidence(call, 20, marker);
    expect(shortened?.message).toMatchObject({
      content: [{ arguments: { shortenedJson: expect.stringContaining("[cut ") } }],
    });
  });

  it("fits items to the longest limit that meets the allowance", () => {
    const source = items(messages);
    const full = evidenceItemsCost(source);
    expect(fitEvidence(source, full, marker)).toEqual(source);
    const allowance = full - 60;
    const fitted = fitEvidence(source, allowance, marker);
    expect(fitted).toBeDefined();
    expect(evidenceItemsCost(fitted ?? [])).toBeLessThanOrEqual(allowance);
    expect(fitEvidence(source, 1, marker)).toBeUndefined();
  });

  it("picks the longest per-string limit that fits, not merely one that fits", () => {
    const source: EvidenceItem[] = [
      { message: { role: "user", content: "x".repeat(2000) }, images: [] },
    ];
    const allowance = Math.floor(evidenceItemsCost(source) / 2);
    const fitted = fitEvidence(source, allowance, marker);
    const limit = JSON.stringify(fitted?.[0]?.message.content).indexOf("\\n[cut ") - 1; // minus the opening quote
    expect(limit).toBeGreaterThan(0);
    expect(evidenceItemsCost(shortenEvidence(source, limit, marker))).toBeLessThanOrEqual(
      allowance,
    );
    expect(evidenceItemsCost(shortenEvidence(source, limit + 1, marker))).toBeGreaterThan(
      allowance,
    );
  });

  it("combines items, renumbering image attachments", () => {
    const [toolResult] = items(messages.slice(2, 3));
    const two = toolResult ? [toolResult, toolResult] : [];
    const combined = combineEvidence(two);
    expect(combined.images).toHaveLength(2);
    expect(
      combined.messages.map((m) => (m.role === "toolResult" ? m.content[1] : undefined)),
    ).toEqual([
      { type: "image", attachment: 1 },
      { type: "image", attachment: 2 },
    ]);
  });
});
