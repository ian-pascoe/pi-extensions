import { SessionManager, type ContextEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectTodoContext } from "../src/todo-context.js";

type Message = ContextEvent["messages"][number];
function state(manager: SessionManager, title: string | null): string {
  return manager.appendCustomEntry("pi-todo-state", {
    nextId: title === null ? 1 : 2,
    tasks: title === null ? [] : [{ id: 1, title, status: "pending" }],
  });
}
function user(manager: SessionManager, content: string): string {
  return manager.appendMessage({ role: "user", content, timestamp: manager.getEntries().length });
}
function project(
  manager: SessionManager,
  messages = manager.buildSessionContext().messages,
): Message[] {
  return projectTodoContext(manager.getBranch(), messages);
}
function snapshots(messages: Message[]) {
  return messages.flatMap((message) =>
    message.role === "custom" && message.customType === "pi-todo-context" ? [message.content] : [],
  );
}

describe("immutable Todo journal projection", () => {
  it("keeps legacy updates at fixed positions and preserves foreign projections verbatim", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Start");
    state(manager, "First");
    const first = project(manager);
    user(manager, "Continue");
    state(manager, "Second");
    state(manager, "Second");
    manager.appendCustomEntry("pi-todo-state", {
      nextId: 1,
      tasks: [{ id: 9, title: "Invalid", status: "pending" }],
    });
    const foreign: Message = {
      role: "custom",
      customType: "foreign",
      content: "Expanded by another extension",
      display: false,
      timestamp: 2,
    };
    const incoming = [...manager.buildSessionContext().messages, foreign];
    const result = project(manager, incoming);
    expect(result.slice(0, first.length)).toEqual(first);
    expect(snapshots(result)).toEqual(["Todo List:\n[ ] #1 First", "Todo List:\n[ ] #1 Second"]);
    expect(result.at(-1)).toBe(foreign);
    expect(incoming).toHaveLength(3);
    expect(project(manager, result)).toEqual(result);
    state(manager, null);
    state(manager, null);
    expect(snapshots(project(manager))).toEqual([
      "Todo List:\n[ ] #1 First",
      "Todo List:\n[ ] #1 Second",
      "Todo List:\nTodo List is empty",
    ]);
  });

  it("uses only selected-branch state across tree navigation and empty sessions", () => {
    const manager = SessionManager.inMemory();
    expect(project(manager)).toEqual([]);
    manager.appendCompaction("Foreign checkpoint", "missing", 0);
    expect(project(manager)).toEqual(manager.buildSessionContext().messages);
    manager.resetLeaf();
    const root = user(manager, "Root");
    state(manager, "Sibling");
    manager.branch(root);
    state(manager, "Selected");
    const selected = manager.getLeafId()!;
    expect(snapshots(project(manager))).toEqual(["Todo List:\n[ ] #1 Selected"]);
    manager.branch(root);
    expect(snapshots(project(manager))).toEqual([]);
    manager.branch(selected);
    expect(snapshots(project(manager))).toEqual(["Todo List:\n[ ] #1 Selected"]);
  });

  it("holds a pre-cutoff baseline fixed while retained states and future updates supersede it", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Old history");
    state(manager, "Before cutoff");
    const cutoff = user(manager, "Retained request");
    state(manager, "Retained change");
    manager.appendCompaction("Summary", cutoff, 1000);
    const first = project(manager);
    expect(first.map((m) => m.role)).toEqual(["compactionSummary", "custom", "user", "custom"]);
    expect(snapshots(first)).toEqual([
      "Todo List:\n[ ] #1 Before cutoff",
      "Todo List:\n[ ] #1 Retained change",
    ]);
    user(manager, "New request");
    state(manager, "Newest");
    expect(project(manager).slice(0, first.length)).toEqual(first);
    expect(project(manager, project(manager))).toEqual(project(manager));
  });

  it("supports an empty Tail and a cutoff on a state entry without inventing an earlier baseline", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Request");
    const cutoff = state(manager, "First state");
    manager.appendCompaction("State cutoff", cutoff, 1000);
    expect(snapshots(project(manager))).toEqual(["Todo List:\n[ ] #1 First state"]);
    const empty = manager.appendCompaction("Empty Tail", "unused", 1000);
    // Native appendCompaction can express an empty Tail by pointing at the checkpoint itself.
    const entry = manager.getEntry(empty);
    if (entry?.type !== "compaction") throw new Error("Missing checkpoint");
    const branch = manager
      .getBranch()
      .map((item) => (item.id === empty ? { ...entry, firstKeptEntryId: empty } : item));
    const messages: Message[] = [
      {
        role: "compactionSummary",
        summary: "Empty Tail",
        tokensBefore: 1000,
        timestamp: Date.parse(entry.timestamp),
      },
    ];
    expect(snapshots(projectTodoContext(branch, messages))).toEqual([
      "Todo List:\n[ ] #1 First state",
    ]);
  });

  it("keeps snapshots after all sibling results when tool calls share an ID", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Update twice");
    manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "same",
          name: "todo",
          arguments: { action: "add", title: "First" },
        },
        {
          type: "toolCall",
          id: "same",
          name: "todo",
          arguments: { action: "update", id: 1, title: "Second" },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    });
    state(manager, "First");
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "same",
      toolName: "todo",
      content: [{ type: "text", text: "First saved" }],
      isError: false,
      timestamp: 2,
    });
    state(manager, "Second");
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "same",
      toolName: "todo",
      content: [{ type: "text", text: "Second saved" }],
      isError: false,
      timestamp: 3,
    });
    const result = project(manager);
    expect(result.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "custom",
      "custom",
    ]);
    expect(snapshots(result)).toEqual(["Todo List:\n[ ] #1 First", "Todo List:\n[ ] #1 Second"]);
    expect(project(manager, result)).toEqual(result);
  });

  it("rejects destroyed or ambiguous anchors rather than relocating old snapshots", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Anchor");
    state(manager, "Task");
    expect(() => project(manager, [])).toThrow("anchor is missing or ambiguous");
    const messages = manager.buildSessionContext().messages;
    expect(() => project(manager, [...messages, ...messages])).toThrow(
      "anchor is missing or ambiguous",
    );
    user(manager, "Later anchor");
    state(manager, "Later Task");
    expect(() => project(manager, manager.buildSessionContext().messages.toReversed())).toThrow(
      "anchors are reordered",
    );
  });
});
