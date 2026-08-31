import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  assembleImportedContext,
  buildRecentAgentActivity,
  buildSubagentSystemPrompt,
  contextContainsImages,
  selectChildAgentTranscript,
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

  it("builds a bounded recent activity tail with reasoning and message text", () => {
    const assistant: AssistantMessage = {
      ...assistantMessage("unused"),
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Inspecting the source" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
      ],
    };
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "image", data: "private image", mimeType: "image/png" }],
      isError: false,
      timestamp: 3,
    };
    const activity = buildRecentAgentActivity([userMessage("task"), assistant, toolResult]);
    expect(activity).toMatchObject([
      { label: "user message", content: "task" },
      { label: "reasoning", content: "private reasoning" },
      { label: "assistant message", content: "Inspecting the source" },
      { label: "tool call read" },
      { label: "tool result read", content: "(no text content)" },
    ]);
    expect(JSON.stringify(activity)).toContain("private reasoning");
    expect(JSON.stringify(activity)).not.toContain("private image");

    const largeResults: ToolResultMessage[] = Array.from({ length: 13 }, (_, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "exec_command",
      content: [{ type: "text", text: `${"x".repeat(200)}\n`.repeat(25) }],
      isError: false,
      timestamp: index,
    }));
    const bounded = buildRecentAgentActivity(largeResults);
    expect(bounded).toHaveLength(12);
    expect(bounded[0]).toMatchObject({ label: "tool result exec_command", truncated: true });
    expect(Buffer.byteLength(bounded[0]?.content ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
    expect(bounded[0]?.content.split("\n").length ?? 0).toBeLessThanOrEqual(20);
  });

  it("selects a bounded image-free transcript while preserving tool call/result pairs", () => {
    const firstCall = {
      ...assistantMessage("old work"),
      content: [
        { type: "text" as const, text: "old work" },
        { type: "toolCall" as const, id: "call-across-cutoff", name: "read", arguments: {} },
      ],
    };
    const filler = Array.from({ length: 24 }, (_, index) => userMessage(`filler ${index}`));
    const pairedResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-across-cutoff",
      toolName: "read",
      content: [
        { type: "text", text: "paired" },
        { type: "image", data: "private image", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 30,
    };
    const orphanResult: ToolResultMessage = {
      ...pairedResult,
      toolCallId: "orphan",
      content: [{ type: "text", text: "orphan" }],
      timestamp: 31,
    };
    const streaming = {
      ...assistantMessage("streaming now"),
      timestamp: 32,
    };

    const snapshot = selectChildAgentTranscript(
      [firstCall, ...filler, pairedResult, orphanResult],
      streaming,
    );

    expect(snapshot.messages.length).toBeLessThanOrEqual(48);
    expect(snapshot.messages[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-across-cutoff",
        },
      ],
    });
    expect(snapshot.messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-across-cutoff" }),
    );
    expect(snapshot.messages).not.toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "orphan" }),
    );
    expect(snapshot.messages.at(snapshot.streamingAssistantIndex ?? -1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "streaming now" }],
    });
    expect(JSON.stringify(snapshot.messages)).not.toContain("private image");

    const outsidePairWindow = selectChildAgentTranscript([
      firstCall,
      ...Array.from({ length: 80 }, (_, index) => userMessage(`newer ${index}`)),
      pairedResult,
    ]);
    expect(outsidePairWindow.messages).not.toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-across-cutoff" }),
    );
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
