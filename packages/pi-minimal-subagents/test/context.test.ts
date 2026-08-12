import { describe, expect, it } from "vitest";
import {
  assembleImportedContext,
  buildSubagentSystemPrompt,
  contextContainsImages,
  snapshotCommittedContext,
} from "../src/minimal-subagents-context.js";

describe("minimal subagents context", () => {
  it("clones committed messages and omits only a streaming assistant tail", () => {
    const messages = [
      { role: "user", content: "question", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 2 },
    ] as never[];
    const snapshot = snapshotCommittedContext(messages, true);
    expect(snapshot).toEqual([messages[0]]);
    expect(snapshot[0]).not.toBe(messages[0]);
    expect(snapshotCommittedContext(messages, false)).toHaveLength(2);
  });

  it("selects inherited, compact, and omitted imported context", () => {
    const messages = [{ role: "user", content: "question", timestamp: 1 }] as never[];
    expect(assembleImportedContext("inherit", messages)).toEqual({ messages, compact: false });
    expect(assembleImportedContext("compact", messages)).toEqual({ messages, compact: true });
    expect(assembleImportedContext("omit", messages)).toEqual({ messages: [], compact: false });
  });

  it("detects image blocks and writes delegation boundaries into the child prompt", () => {
    expect(
      contextContainsImages([
        { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
      ] as never[]),
    ).toBe(true);
    expect(contextContainsImages([{ role: "user", content: "plain" }] as never[])).toBe(false);
    expect(
      buildSubagentSystemPrompt("child", "root", { canSpawn: true, remainingDepth: 1 }),
    ).toContain("Remaining delegation depth: 1.");
    expect(
      buildSubagentSystemPrompt("child", "root", { canSpawn: false, remainingDepth: 0 }),
    ).toContain("Delegation is owned by your parent.");
  });
});
