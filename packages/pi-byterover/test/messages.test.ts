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

describe("pi session message helpers", () => {
  test("extracts user and assistant text from Pi session entries", () => {
    const messages = extractPiSessionMessages([
      {
        type: "message",
        id: "u1",
        message: { role: "user", content: " question " },
      },
      {
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: " first " },
            { type: "tool-call", text: "ignored" },
            { type: "text", text: "   " },
            { type: "text", text: "second" },
            { type: "custom", value: "ignored" },
          ],
        },
      },
      {
        type: "message",
        id: "system",
        message: { role: "system", content: "ignored" },
      },
      {
        type: "message",
        id: 123,
        message: { role: "user", content: "ignored" },
      },
      { type: "tool_result", id: "tool", message: { role: "assistant", content: "ignored" } },
      { type: "custom", id: "custom", message: { role: "user", content: "ignored" } },
      { type: "compaction", id: "compact", message: { role: "assistant", content: "ignored" } },
    ]);

    expect(messages).toEqual([
      { id: "u1", role: "user", text: " question " },
      { id: "a1", role: "assistant", text: "first\nsecond" },
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
