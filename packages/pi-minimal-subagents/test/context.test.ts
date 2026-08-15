import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  assembleImportedContext,
  buildSubagentSystemPrompt,
  contextContainsImages,
  snapshotCommittedContext,
} from "../src/minimal-subagents-context.js";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(content: UserMessage["content"], timestamp = 1): UserMessage {
  return { role: "user", content, timestamp };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 2,
  };
}

describe("minimal subagents context", () => {
  it("clones committed messages and omits only a streaming assistant tail", () => {
    const messages: AgentMessage[] = [userMessage("question"), assistantMessage("partial")];
    const snapshot = snapshotCommittedContext(messages, true);
    expect(snapshot).toEqual([messages[0]]);
    expect(snapshot[0]).not.toBe(messages[0]);
    expect(snapshotCommittedContext(messages, false)).toHaveLength(2);
  });

  it("selects inherited, compact, and omitted imported context", () => {
    const messages: AgentMessage[] = [userMessage("question")];
    expect(assembleImportedContext("inherit", messages)).toEqual({ messages, compact: false });
    expect(assembleImportedContext("compact", messages)).toEqual({ messages, compact: true });
    expect(assembleImportedContext("omit", messages)).toEqual({ messages: [], compact: false });
  });

  it("detects image blocks and writes delegation boundaries into the child prompt", () => {
    expect(
      contextContainsImages([userMessage([{ type: "image", data: "x", mimeType: "image/png" }])]),
    ).toBe(true);
    expect(contextContainsImages([userMessage("plain")])).toBe(false);
    expect(
      buildSubagentSystemPrompt("child", "root", { canSpawn: true, remainingDepth: 1 }),
    ).toContain("Remaining delegation depth: 1.");
    expect(
      buildSubagentSystemPrompt("child", "root", { canSpawn: false, remainingDepth: 0 }),
    ).toContain("Delegation is owned by your parent.");
  });
});
