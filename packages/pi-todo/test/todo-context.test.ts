import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { SessionManager, type ContextEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_INSTRUCTION, projectTodoContext } from "../src/todo-context.js";

type Message = ContextEvent["messages"][number];
const HEADER = "Todo List state from the pi-todo extension (not a user message):\n";
const CHECKPOINT = `\n\n${CHECKPOINT_INSTRUCTION}`;
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
    expect(snapshots(result)).toEqual([`${HEADER}[ ] #1 First`, `${HEADER}[ ] #1 Second`]);
    expect(result.at(-1)).toBe(foreign);
    expect(incoming).toHaveLength(3);
    expect(project(manager, result)).toEqual(result);
    state(manager, null);
    state(manager, null);
    expect(snapshots(project(manager))).toEqual([
      `${HEADER}[ ] #1 First`,
      `${HEADER}[ ] #1 Second`,
      `${HEADER}Todo List is empty`,
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
    expect(snapshots(project(manager))).toEqual([`${HEADER}[ ] #1 Selected`]);
    manager.branch(root);
    expect(snapshots(project(manager))).toEqual([]);
    manager.branch(selected);
    expect(snapshots(project(manager))).toEqual([`${HEADER}[ ] #1 Selected`]);
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
    // The Tail's last Snapshot already sits where the next Context Window resumes, so the
    // Checkpoint Snapshot replaces it instead of repeating the list.
    expect(snapshots(first)).toEqual([
      `${HEADER}[ ] #1 Before cutoff`,
      `${HEADER}[ ] #1 Retained change${CHECKPOINT}`,
    ]);
    user(manager, "New request");
    state(manager, "Newest");
    expect(project(manager).slice(0, first.length)).toEqual(first);
    expect(project(manager, project(manager))).toEqual(project(manager));
  });

  it("anchors past Pi system state that context handlers never receive", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "system", content: "Instructions", timestamp: 0 });
    user(manager, "Old history");
    state(manager, "Before cutoff");
    const cutoff = user(manager, "Retained request");
    manager.appendMessage({ role: "system", content: "", toolsAdded: [], timestamp: 1 });
    state(manager, "Retained change");
    manager.appendCompaction("Summary", cutoff, 1000);
    const context = manager.buildSessionContext().messages;
    expect(context[0]?.role).toBe("system");
    const projected = project(
      manager,
      context.filter((message) => message.role !== "system"),
    );
    expect(projected.map((m) => m.role)).toEqual(["compactionSummary", "custom", "user", "custom"]);
    expect(snapshots(projected)).toEqual([
      `${HEADER}[ ] #1 Before cutoff`,
      `${HEADER}[ ] #1 Retained change${CHECKPOINT}`,
    ]);
  });

  it("supports an empty Tail and a cutoff on a state entry without inventing an earlier baseline", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Request");
    const cutoff = state(manager, "First state");
    manager.appendCompaction("State cutoff", cutoff, 1000);
    expect(snapshots(project(manager))).toEqual([`${HEADER}[ ] #1 First state${CHECKPOINT}`]);
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
    // With an empty Tail, the Checkpoint Snapshot takes the baseline's place.
    expect(snapshots(projectTodoContext(branch, messages))).toEqual([
      `${HEADER}[ ] #1 First state${CHECKPOINT}`,
    ]);
  });

  function assistantCalls(manager: SessionManager, ids: string[]): void {
    manager.appendMessage({
      role: "assistant",
      content: ids.map((id) => ({ type: "toolCall", id, name: "todo", arguments: {} })),
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
  }
  function toolResult(
    manager: SessionManager,
    id: string,
    text?: string,
    isError = false,
    details: JsonObject = {},
  ): void {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "todo",
      content: [{ type: "text", text: text ?? `${id} saved at ${manager.getEntries().length}` }],
      isError,
      details,
      timestamp: 2,
    });
  }

  it("projects only the final state of a tool group after all sibling results, even when calls share an ID", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Update twice");
    assistantCalls(manager, ["same", "same"]);
    state(manager, "First");
    toolResult(manager, "same");
    state(manager, "Second");
    toolResult(manager, "same");
    const result = project(manager);
    expect(result.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "custom",
    ]);
    expect(snapshots(result)).toEqual([`${HEADER}[ ] #1 Second`]);
    expect(project(manager, result)).toEqual(result);
  });

  it("projects one snapshot per tool group and keeps earlier groups fixed", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Work");
    assistantCalls(manager, ["a", "b"]);
    state(manager, "A1");
    toolResult(manager, "a");
    state(manager, "A2");
    toolResult(manager, "b");
    const first = project(manager);
    assistantCalls(manager, ["c", "d"]);
    state(manager, "B1");
    toolResult(manager, "c");
    state(manager, "B2");
    toolResult(manager, "d");
    const second = project(manager);
    expect(snapshots(second)).toEqual([`${HEADER}[ ] #1 A2`, `${HEADER}[ ] #1 B2`]);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "custom",
      "assistant",
      "toolResult",
      "toolResult",
      "custom",
    ]);
  });

  it("projects nothing for a tool group that ends in the state it began with", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Start");
    state(manager, "Stable");
    assistantCalls(manager, ["a", "b"]);
    state(manager, "Temporary");
    toolResult(manager, "a");
    state(manager, "Stable");
    toolResult(manager, "b");
    expect(snapshots(project(manager))).toEqual([`${HEADER}[ ] #1 Stable`]);
  });

  const fullList = (tasks: JsonValue) => ({ action: "list", tasks });
  const task = (title: string): JsonObject[] => [{ id: 1, title, status: "pending" }];

  it("skips the Snapshot when the group's last todo result carries the complete resulting list", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Batch add");
    assistantCalls(manager, ["a"]);
    state(manager, "Task");
    toolResult(manager, "a", "Added 1 Task\n[ ] #1 Task", false, {
      action: "add",
      tasks: task("Task"),
    });
    const first = project(manager);
    expect(snapshots(first)).toEqual([]);
    expect(project(manager, first)).toEqual(first);
    assistantCalls(manager, ["b"]);
    state(manager, "Task");
    toolResult(manager, "b", "[ ] #1 Task", false, fullList(task("Task")));
    expect(snapshots(project(manager))).toEqual([]);
    assistantCalls(manager, ["c"]);
    state(manager, "Other");
    toolResult(manager, "c", "Updated Task #1", false, {
      action: "update",
      task: task("Other")[0]!,
    });
    const second = project(manager);
    expect(snapshots(second)).toEqual([`${HEADER}[ ] #1 Other`]);
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it("checks the group's last todo result, not its last message", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Go");
    assistantCalls(manager, ["a", "b"]);
    state(manager, "Task");
    toolResult(manager, "a", "list", false, fullList(task("Task")));
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "b",
      toolName: "bash",
      content: [{ type: "text", text: "other tool" }],
      isError: false,
      timestamp: 3,
    });
    expect(snapshots(project(manager))).toEqual([]);
  });

  it("keeps the Snapshot when the last todo result is partial, stale, or an error", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Go");
    assistantCalls(manager, ["a", "b"]);
    state(manager, "One");
    toolResult(manager, "a", "x", false, fullList(task("One")));
    state(manager, "Two");
    toolResult(manager, "b", "x", false, { action: "update", tasks: task("Two").slice(1) });
    assistantCalls(manager, ["c", "d"]);
    state(manager, "Three");
    toolResult(manager, "c", "x", false, fullList(task("Three")));
    toolResult(manager, "d", "x", true, fullList(task("Three")));
    assistantCalls(manager, ["e"]);
    state(manager, "Four");
    toolResult(manager, "e", "x", false, fullList(task("Stale")));
    expect(snapshots(project(manager))).toEqual([
      `${HEADER}[ ] #1 Two`,
      `${HEADER}[ ] #1 Three`,
      `${HEADER}[ ] #1 Four`,
    ]);
  });

  function codemodeResult(
    manager: SessionManager,
    id: string,
    text: string,
    isError = false,
    calledTodo = true,
  ): void {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "codemode",
      content: [{ type: "text", text }],
      isError,
      timestamp: 4,
      nestedCalls: {
        calls: calledTodo ? [{ id: `${id}/1`, name: "todo", status: "ok" }] : [],
        complete: true,
      },
    });
  }
  const script = (output: string) => `Script completed\nWall time 0.1 seconds\nOutput:\n${output}`;
  const shown = (tasks: JsonValue, action = "list") => JSON.stringify({ action, tasks });

  it("skips the Snapshot when a codemode result shows the complete final list from nested todo results", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Script");
    assistantCalls(manager, ["a"]);
    state(manager, "One");
    state(manager, "Final");
    codemodeResult(manager, "a", script(shown(task("Final"), "add")));
    expect(snapshots(project(manager))).toEqual([]);
    assistantCalls(manager, ["b"]);
    state(manager, "Pretty");
    codemodeResult(
      manager,
      "b",
      script(
        `==> text 1/2 <==\nDone\n==> text 2/2 <==\n${JSON.stringify({ action: "list", tasks: task("Pretty") }, null, 2)}`,
      ),
    );
    assistantCalls(manager, ["c"]);
    state(manager, null);
    codemodeResult(manager, "c", script(shown([])));
    expect(snapshots(project(manager))).toEqual([]);
  });

  it("finds the list inside a wrapper value or a bare task array the script returned", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Script");
    assistantCalls(manager, ["a"]);
    state(manager, "Wrapped");
    codemodeResult(
      manager,
      "a",
      script(JSON.stringify({ after: JSON.parse(shown(task("Wrapped"))) })),
    );
    assistantCalls(manager, ["b"]);
    state(manager, "Bare");
    codemodeResult(manager, "b", script(JSON.stringify(task("Bare"))));
    expect(snapshots(project(manager))).toEqual([]);
  });

  it("keeps the Snapshot when a codemode result does not show exactly the final list", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Script");
    assistantCalls(manager, ["a"]);
    state(manager, "Hidden");
    codemodeResult(manager, "a", script("added 1 task"));
    assistantCalls(manager, ["b"]);
    state(manager, "Changed");
    codemodeResult(manager, "b", script(shown(task("Before"))));
    assistantCalls(manager, ["c"]);
    state(manager, "Failed");
    codemodeResult(manager, "c", script(shown(task("Failed"))), true);
    assistantCalls(manager, ["d"]);
    state(manager, "Latest");
    codemodeResult(manager, "d", script(`${shown(task("Latest"))}\n${shown(task("Earlier"))}`));
    assistantCalls(manager, ["e"]);
    state(manager, "Partial");
    codemodeResult(
      manager,
      "e",
      script(JSON.stringify({ action: "update", task: task("Partial")[0] })),
    );
    assistantCalls(manager, ["f"]);
    state(manager, "Prose");
    codemodeResult(manager, "f", script("tasks: [ ] #1 Prose (not JSON)"));
    expect(snapshots(project(manager))).toEqual([
      `${HEADER}[ ] #1 Hidden`,
      `${HEADER}[ ] #1 Changed`,
      `${HEADER}[ ] #1 Failed`,
      `${HEADER}[ ] #1 Latest`,
      `${HEADER}[ ] #1 Partial`,
      `${HEADER}[ ] #1 Prose`,
    ]);
  });

  it("ignores a codemode result that never called todo, keeping the earlier todo result as the anchor", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Mixed");
    assistantCalls(manager, ["a", "b", "c"]);
    state(manager, "Task");
    toolResult(manager, "a", "list", false, fullList(task("Task")));
    codemodeResult(manager, "b", script("unrelated"), false, false);
    // Even a printed list is not evidence for a script that made no todo call.
    codemodeResult(manager, "c", script(shown(task("Other"))), false, false);
    expect(snapshots(project(manager))).toEqual([]);
  });

  it("recovers from stray brackets in prose but keeps the Snapshot for oversized or desynchronized output", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Script");
    assistantCalls(manager, ["a"]);
    state(manager, "Big");
    codemodeResult(manager, "a", script(`${"x".repeat(70_000)}\n${shown(task("Big"))}`));
    assistantCalls(manager, ["b"]);
    state(manager, "Noisy");
    codemodeResult(manager, "b", script(`} ] "oops [ { \n${shown(task("Noisy"))}`));
    assistantCalls(manager, ["c"]);
    state(manager, "Desynced");
    // An unterminated string inside an open bracket swallows everything after it.
    codemodeResult(manager, "c", script(`{ "oops\n${shown(task("Desynced"))}`));
    expect(snapshots(project(manager))).toEqual([
      `${HEADER}[ ] #1 Big`,
      `${HEADER}[ ] #1 Desynced`,
    ]);
  });

  it("judges a mixed group by its last todo or codemode result", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Mixed");
    assistantCalls(manager, ["a", "b"]);
    state(manager, "Direct");
    toolResult(manager, "a", "x", false, { action: "update", task: task("Direct")[0]! });
    codemodeResult(manager, "b", script(shown(task("Direct"))));
    assistantCalls(manager, ["c", "d"]);
    state(manager, "Later");
    codemodeResult(manager, "c", script(shown(task("Later"))));
    toolResult(manager, "d", "x", false, { action: "update", task: task("Later")[0]! });
    expect(snapshots(project(manager))).toEqual([`${HEADER}[ ] #1 Later`]);
  });

  type Status = "pending" | "active" | "completed";
  function tasksState(manager: SessionManager, tasks: Array<[string, Status]>): JsonObject[] {
    const records = tasks.map(([title, status], index) => ({ id: index + 1, title, status }));
    manager.appendCustomEntry("pi-todo-state", { nextId: tasks.length + 1, tasks: records });
    return records;
  }

  it("asks to reconcile unfinished Tasks created in the Tail where the next Context Window resumes", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Old history");
    state(manager, null);
    const cutoff = user(manager, "Plan the work");
    assistantCalls(manager, ["a"]);
    const added = tasksState(manager, [
      ["Research", "pending"],
      ["Build", "pending"],
    ]);
    // A batch add shows the full list, so the Tail itself carries no Snapshot of it.
    toolResult(manager, "a", "Added 2 Tasks", false, { action: "add", tasks: added });
    user(manager, "Keep going");
    manager.appendCompaction("Handoff with its own next actions", cutoff, 1000);
    const first = project(manager);
    expect(first.map((m) => m.role)).toEqual([
      "compactionSummary",
      "custom",
      "user",
      "assistant",
      "toolResult",
      "user",
      "custom",
    ]);
    expect(snapshots(first)).toEqual([
      `${HEADER}Todo List is empty`,
      `${HEADER}[ ] #1 Research\n[ ] #2 Build${CHECKPOINT}`,
    ]);
    expect(first.at(-1)).toMatchObject({ details: { checkpointId: expect.any(String) } });

    user(manager, "New request");
    assistantCalls(manager, ["b"]);
    const updated = tasksState(manager, [
      ["Research", "completed"],
      ["Build", "active"],
    ]);
    toolResult(manager, "b", "Updated Task #1", false, { action: "update", task: updated[0]! });
    const second = project(manager);
    expect(second.slice(0, first.length)).toEqual(first);
    // Later Snapshots are ordinary: the instruction appears once per checkpoint.
    expect(snapshots(second).at(-1)).toBe(`${HEADER}[x] #1 Research\n[>] #2 Build`);
    expect(project(manager, second)).toEqual(second);
  });

  it("adds no Checkpoint Snapshot when every Task is completed or the list is empty", () => {
    const manager = SessionManager.inMemory();
    user(manager, "Work");
    tasksState(manager, [
      ["Done", "completed"],
      ["Also done", "completed"],
    ]);
    const cutoff = user(manager, "Retained");
    manager.appendCompaction("Summary", cutoff, 1000);
    expect(snapshots(project(manager))).toEqual([`${HEADER}[x] #1 Done\n[x] #2 Also done`]);
    state(manager, null);
    const next = user(manager, "After clearing");
    manager.appendCompaction("Second summary", next, 1000);
    expect(snapshots(project(manager))).toEqual([`${HEADER}Todo List is empty`]);
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
