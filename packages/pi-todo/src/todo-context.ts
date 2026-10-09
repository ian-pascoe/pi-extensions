import { isDeepStrictEqual } from "node:util";
import {
  buildSessionContext,
  type ContextEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  formatTodoList,
  parseTodoStateSnapshot,
  TodoStateRecord,
  TodoTaskRecord,
  type TodoStateSnapshot,
} from "./todo-list.js";

type Message = ContextEvent["messages"][number];
/** Marks a snapshot as extension state so the model does not read it as user-authored. */
const SNAPSHOT_HEADER = "Todo List state from the pi-todo extension (not a user message):";
const ListDetails = Type.Object({ tasks: Type.Array(Type.Unknown()) });
const ProjectionDetails = Type.Object(
  {
    version: Type.Literal(1),
    stateEntryId: Type.String(),
    checkpointId: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** Context handlers never receive system messages, so anchors must skip Pi's system state. */
function conversationMessage(entry: SessionEntry): Message | undefined {
  return buildSessionContext([entry], entry.id).messages.find(
    (message) => message.role !== "system",
  );
}

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

/** A printed result's `tasks`, or a bare non-empty Task array a script returned. */
const ShownTasks = Type.Union([
  Type.Object({ tasks: Type.Array(TodoTaskRecord) }),
  Type.Array(TodoTaskRecord, { minItems: 1 }),
]);
/** Longer output is treated as not showing the list; Pi itself truncates output near this size. */
const MAX_SCANNED_OUTPUT_CHARS = 65_536;

/**
 * The last Todo List a `codemode` script printed as JSON, however deeply it nested it.
 *
 * Deliberate coupling to codemode's output text: Pi records a script's nested calls on the
 * `codemode` tool result without their results (`nestedCalls` holds names, arguments and
 * statuses only), so what the model saw can only be read from the output. This is a best-effort
 * dedupe: anything unrecognised keeps the Snapshot, which is always safe.
 *
 * One pass tracks bracket nesting and string state, and parses each balanced value that mentions
 * Tasks, so the cost is bounded by output size times nesting depth.
 */
function lastListInText(text: string): readonly Static<typeof TodoTaskRecord>[] | undefined {
  let last: readonly Static<typeof TodoTaskRecord>[] | undefined;
  if (text.length > MAX_SCANNED_OUTPUT_CHARS) return last;
  const opened: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = opened.length > 0;
    else if (char === "{" || char === "[") opened.push(i);
    else if (char === "}" || char === "]") {
      const start = opened.pop();
      if (start === undefined || text[start] !== (char === "}" ? "{" : "[")) {
        opened.length = 0;
        continue;
      }
      const candidate = text.slice(start, i + 1);
      if (!candidate.includes('"title"') && !candidate.includes('"tasks"')) continue;
      try {
        const value = JSON.parse(candidate);
        if (Value.Check(ShownTasks, value)) last = Array.isArray(value) ? value : value.tasks;
      } catch {
        // Not JSON: prose that merely contains brackets.
      }
    }
  }
  return last;
}

/** True when Pi recorded a nested `todo` call on this `codemode` result. */
function codemodeCalledTodo(message: Message): boolean {
  return (
    message.role === "toolResult" &&
    message.toolName === "codemode" &&
    (message.nestedCalls?.calls ?? []).some((call) => call.name === "todo")
  );
}

/**
 * True when a successful `todo` result's details, or the last list the output of a successful
 * `codemode` script that called `todo` printed, carry exactly the complete resulting list.
 */
function resultRendersList(message: Message | undefined, tasks: TodoStateSnapshot["tasks"]) {
  if (message?.role !== "toolResult" || message.isError) return false;
  if (message.toolName === "todo")
    return (
      Value.Check(ListDetails, message.details) && isDeepStrictEqual(message.details.tasks, tasks)
    );
  if (!codemodeCalledTodo(message)) return false;
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  const shown = lastListInText(text.join("\n"));
  return shown !== undefined && isDeepStrictEqual(shown, tasks);
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
    content: `${SNAPSHOT_HEADER}\n${formatTodoList(state.tasks)}`,
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
    anchor = conversationMessage(checkpoint);
    for (const entry of branch.slice(0, start).toReversed()) {
      const state = todoStateFromEntry(entry);
      if (!state) continue;
      previousContent = formatTodoList(state.tasks);
      insert(snapshotMessage(entry, state, checkpoint.id));
      break;
    }
  }
  const outstanding = new Map<string, number>();
  // A tool group projects only its final state, once its last result has landed. Nested `todo`
  // calls in a `codemode` script leave no results in the journal, so the script's result stands in.
  let lastTodoResult: Message | undefined;
  let pending: { entry: SessionEntry; state: TodoStateSnapshot } | undefined;
  const project = (entry: SessionEntry, state: TodoStateSnapshot, finalResult?: Message): void => {
    const content = formatTodoList(state.tasks);
    // The model already saw this exact list in the group's last result; a Snapshot would repeat it.
    const rendered = resultRendersList(finalResult, state.tasks);
    if (
      !rendered &&
      content !== previousContent &&
      (previousContent !== undefined || state.tasks.length > 0)
    )
      insert(snapshotMessage(entry, state, null));
    previousContent = content;
  };
  for (const entry of branch.slice(start)) {
    if (entry === checkpoint) continue;
    const state = todoStateFromEntry(entry);
    if (state) {
      if (outstanding.size > 0) pending = { entry, state };
      else project(entry, state);
      continue;
    }
    const message = conversationMessage(entry);
    if (!message) continue;
    if (message.role === "assistant") {
      if (outstanding.size > 0 && pending)
        throw new Error("Todo mutation has an incomplete tool group");
      outstanding.clear();
      lastTodoResult = undefined;
      for (const block of message.content)
        if (block.type === "toolCall")
          outstanding.set(block.id, (outstanding.get(block.id) ?? 0) + 1);
    } else if (message.role === "toolResult") {
      // A `codemode` result counts only when it recorded a nested `todo` call.
      if (message.toolName === "todo" || codemodeCalledTodo(message)) lastTodoResult = message;
      const remaining = (outstanding.get(message.toolCallId) ?? 0) - 1;
      if (remaining > 0) outstanding.set(message.toolCallId, remaining);
      else outstanding.delete(message.toolCallId);
    }
    anchor = message;
    if (outstanding.size === 0 && pending) {
      project(pending.entry, pending.state, lastTodoResult);
      pending = undefined;
    }
  }
  if (pending) throw new Error("Todo mutation has an incomplete tool group");
  return [
    ...(insertions.get(-1) ?? []),
    ...messages.flatMap((message, index) => [message, ...(insertions.get(index) ?? [])]),
  ];
}
