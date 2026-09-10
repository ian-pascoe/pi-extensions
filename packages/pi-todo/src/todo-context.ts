import { isDeepStrictEqual } from "node:util";
import {
  buildSessionContext,
  type ContextEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  formatTodoList,
  parseTodoStateSnapshot,
  TodoStateRecord,
  type TodoStateSnapshot,
} from "./todo-list.js";

type Message = ContextEvent["messages"][number];
const ProjectionDetails = Type.Object(
  {
    version: Type.Literal(1),
    stateEntryId: Type.String(),
    checkpointId: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** Validates both the serialized shape and Todo List invariants at the journal boundary. */
export function todoStateFromEntry(entry: SessionEntry): TodoStateSnapshot | undefined {
  if (
    entry.type !== "custom" ||
    entry.customType !== "pi-todo-state" ||
    !Value.Check(TodoStateRecord, entry.data)
  )
    return undefined;
  return parseTodoStateSnapshot(entry.data);
}

function snapshotMessage(
  entry: SessionEntry,
  state: TodoStateSnapshot,
  checkpointId: string | null,
): Message {
  return {
    role: "custom",
    customType: "pi-todo-context",
    display: false,
    content: `Todo List:\n${formatTodoList(state.tasks)}`,
    timestamp: Date.parse(entry.timestamp),
    details: { version: 1, stateEntryId: entry.id, checkpointId },
  };
}

/** Reprojects only Todo-owned snapshots at immutable journal boundaries, never at the live tail. */
export function projectTodoContext(
  branch: readonly SessionEntry[],
  incoming: ContextEvent["messages"],
): ContextEvent["messages"] {
  const messages = incoming.filter(
    (message) =>
      !(
        message.role === "custom" &&
        message.customType === "pi-todo-context" &&
        Value.Check(ProjectionDetails, message.details)
      ),
  );
  if (!branch.some((entry) => todoStateFromEntry(entry))) return messages;
  const checkpoint = branch.findLast((entry) => entry.type === "compaction");
  let start = 0;
  let anchor: Message | undefined;
  let previousContent: string | undefined;
  const insertions = new Map<number, Message[]>();
  let previousIndex = -1;
  const insert = (snapshot: Message): void => {
    let index = -1;
    if (anchor) {
      // ponytail: linear exact matching per mutation; index fingerprints if large journals make this measurable.
      const matches = messages.flatMap((message, i) =>
        isDeepStrictEqual(message, anchor) ? [i] : [],
      );
      if (matches.length !== 1)
        throw new Error(
          "Todo context anchor is missing or ambiguous; cannot preserve snapshot order",
        );
      index = matches[0]!;
    }
    if (index < previousIndex) throw new Error("Todo context anchors are reordered");
    previousIndex = index;
    const group = insertions.get(index) ?? [];
    group.push(snapshot);
    insertions.set(index, group);
  };
  if (checkpoint) {
    start = branch.findIndex((entry) => entry.id === checkpoint.firstKeptEntryId);
    const checkpointIndex = branch.indexOf(checkpoint);
    if (start < 0 || start > checkpointIndex)
      throw new Error("Todo checkpoint cutoff is unavailable");
    anchor = buildSessionContext([checkpoint], checkpoint.id).messages[0];
    for (const entry of branch.slice(0, start).toReversed()) {
      const state = todoStateFromEntry(entry);
      if (!state) continue;
      previousContent = formatTodoList(state.tasks);
      insert(snapshotMessage(entry, state, checkpoint.id));
      break;
    }
  }
  const outstanding = new Map<string, number>();
  let pending: Message[] = [];
  for (const entry of branch.slice(start)) {
    if (entry === checkpoint) continue;
    const state = todoStateFromEntry(entry);
    if (state) {
      const content = formatTodoList(state.tasks);
      if (
        content !== previousContent &&
        (previousContent !== undefined || state.tasks.length > 0)
      ) {
        const snapshot = snapshotMessage(entry, state, null);
        if (outstanding.size > 0) pending.push(snapshot);
        else insert(snapshot);
      }
      previousContent = content;
      continue;
    }
    const message = buildSessionContext([entry], entry.id).messages[0];
    if (!message) continue;
    if (message.role === "assistant") {
      if (outstanding.size > 0 && pending.length > 0)
        throw new Error("Todo mutation has an incomplete tool group");
      outstanding.clear();
      for (const block of message.content)
        if (block.type === "toolCall")
          outstanding.set(block.id, (outstanding.get(block.id) ?? 0) + 1);
    } else if (message.role === "toolResult") {
      const remaining = (outstanding.get(message.toolCallId) ?? 0) - 1;
      if (remaining > 0) outstanding.set(message.toolCallId, remaining);
      else outstanding.delete(message.toolCallId);
    }
    anchor = message;
    if (outstanding.size === 0 && pending.length > 0) {
      for (const snapshot of pending) insert(snapshot);
      pending = [];
    }
  }
  if (pending.length > 0) throw new Error("Todo mutation has an incomplete tool group");
  return [
    ...(insertions.get(-1) ?? []),
    ...messages.flatMap((message, index) => [message, ...(insertions.get(index) ?? [])]),
  ];
}
