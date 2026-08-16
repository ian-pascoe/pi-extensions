import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  extractPiSessionMessages,
  formatMessage,
  formatMessages,
  selectMessagesForRecall,
  selectMessagesInTurn,
  type PiSessionMessage,
  turnKey,
} from "../src/messages.js";

const message = (id: string, role: "user" | "assistant", text: string): PiSessionMessage => ({
  id,
  role,
  text,
});

const userEntry = (id: string, content: string): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-08-15T00:00:00.000Z",
  message: { role: "user", content, timestamp: 1 },
});

const assistantEntry = (id: string, text: string): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-08-15T00:00:00.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  },
});

describe("pi session message helpers", () => {
  test("extracts user and assistant text from Pi session entries", () => {
    const messages = extractPiSessionMessages([
      userEntry("u1", " question "),
      assistantEntry("a1", " first "),
      {
        type: "custom",
        id: "custom",
        parentId: null,
        timestamp: "2026-08-15T00:00:00.000Z",
        customType: "test",
      },
    ]);

    expect(messages).toEqual([
      { id: "u1", role: "user", text: " question " },
      { id: "a1", role: "assistant", text: "first" },
    ]);
  });

  test("formats messages and skips empty text", () => {
    expect(formatMessage(message("u1", "user", " question "))).toBe("[user]: question");
    expect(formatMessage(message("a1", "assistant", " "))).toBe("");
    expect(
      formatMessages([message("u1", "user", " question "), message("a1", "assistant", " ")]),
    ).toBe("[user]: question");
  });

  test("selects the latest turn back to the most recent user message", () => {
    const selected = selectMessagesInTurn([
      message("u1", "user", "old question"),
      message("a1", "assistant", "old answer"),
      message("u2", "user", "latest question"),
      message("a2", "assistant", "latest answer"),
    ]);

    expect(selected.map((item) => item.id)).toEqual(["u2", "a2"]);
    expect(turnKey(selected)).toBe("u2:a2");
  });

  test("keeps the complete message list when it has no user message", () => {
    const messages = [
      message("a1", "assistant", "first answer"),
      message("a2", "assistant", "second answer"),
    ];

    expect(selectMessagesInTurn(messages)).toEqual(messages);
  });

  test("selects recent substantive messages within maxRecallTurns", () => {
    const selected = selectMessagesForRecall(
      [
        message("u1", "user", "old question"),
        message("a1", "assistant", "old answer"),
        message("u2", "user", "middle question"),
        message("a2", "assistant", "middle answer"),
        message("empty", "assistant", "   "),
        message("u3", "user", "latest question"),
      ],
      { maxRecallTurns: 2, maxRecallChars: 4096 },
    );

    expect(selected.map((item) => item.id)).toEqual(["u2", "a2", "u3"]);
  });

  test("selects recent messages within maxRecallChars", () => {
    const selected = selectMessagesForRecall(
      [
        message("u1", "user", "old question"),
        message("a1", "assistant", "old answer"),
        message("u2", "user", "latest question"),
        message("a2", "assistant", "latest answer"),
      ],
      { maxRecallTurns: 10, maxRecallChars: 51 },
    );

    expect(formatMessages(selected)).toBe("[user]: latest question\n\n[assistant]: latest answer");
    expect(selected.map((item) => item.id)).toEqual(["u2", "a2"]);
  });
});
