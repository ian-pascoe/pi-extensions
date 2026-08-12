import { describe, expect, test } from "vitest";
import { stripEchoedRecallQuery } from "../src/recall.js";

describe("stripEchoedRecallQuery", () => {
  test("removes the echoed query from ByteRover summary headers", () => {
    const query = "Recall useful context.\n\nRecent conversation:\n\n---\n[user]: latest question";
    const content =
      `**Summary**: Found 1 relevant topic for "${query}":\n\n` +
      `**Details**:\n\n### useful_context\n\nKeep this recalled context.`;

    const stripped = stripEchoedRecallQuery(content, query);

    expect(stripped).toContain("**Summary**: Found 1 relevant topic:");
    expect(stripped).toContain("Keep this recalled context.");
    expect(stripped).not.toContain("Recall useful context");
    expect(stripped).not.toContain("[user]: latest question");
  });
});
