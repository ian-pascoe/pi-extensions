import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

/** Agent-visible Todo List operations. */
export const TODO_ACTIONS = ["list", "add", "update", "remove", "clear"] as const;

/** Unconstrained Task lifecycle states. */
export const TODO_STATUSES = ["pending", "active", "completed"] as const;

/** One operation accepted by the Todo List. */
export type TodoAction = (typeof TODO_ACTIONS)[number];

/** One Task lifecycle state. */
export type TodoStatus = (typeof TODO_STATUSES)[number];

declare const todoTaskIdBrand: unique symbol;

/** Stable numeric identity for a Task while it exists. */
export type TodoTaskId = number & { readonly [todoTaskIdBrand]: true };

/** One flat unit of work in the Todo List. */
export type TodoTask = {
  readonly id: TodoTaskId;
  readonly title: string;
  readonly description?: string;
  readonly status: TodoStatus;
};

/** Complete session-persisted Todo List state. */
export type TodoStateSnapshot = {
  readonly nextId: number;
  readonly tasks: readonly TodoTask[];
};

/** One Task to create within a batch `add`. */
export type TodoTaskDraft = {
  readonly title: string;
  readonly description?: string;
};

/** Boundary input shared by the Todo tool's five operations. */
export type TodoActionInput = {
  readonly action: TodoAction;
  readonly id?: number;
  readonly title?: string;
  readonly description?: string | null;
  readonly tasks?: readonly TodoTaskDraft[];
  readonly status?: TodoStatus;
};

/**
 * Render details and the tool's structured result. The action, plus `tasks` versus `task` for
 * `add`, discriminates the list from the Task(s) a mutation added or updated, the ID it removed,
 * and the count it cleared. A batch `add` returns the Tasks it created as `tasks`; a single `add`
 * returns `task`.
 */
export type TodoToolDetails =
  | { readonly action: "list" | "add"; readonly tasks: readonly TodoTask[] }
  | { readonly action: "add" | "update"; readonly task: TodoTask }
  | { readonly action: "remove"; readonly id: TodoTaskId }
  | { readonly action: "clear"; readonly cleared: number };

const PositiveSafeIntegerRecord = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const TodoTaskRecord = Type.Object({
  id: PositiveSafeIntegerRecord,
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ minLength: 1 })),
  status: StringEnum(TODO_STATUSES),
});

/**
 * JSON Schema of the `todo` tool's `structuredContent`, which codemode scripts receive instead of
 * the model-facing text. Flat so Pi's one-line script declaration stays compact; `action` (and, for
 * `add`, whether the request carried `tasks`) says which other field is present.
 */
export const TodoToolOutputSchema = Type.Object(
  {
    action: StringEnum(TODO_ACTIONS, { description: "The operation that ran" }),
    tasks: Type.Optional(
      Type.Array(TodoTaskRecord, {
        description: "list: every Task in ID order; add with tasks: the Tasks created, in ID order",
      }),
    ),
    task: Type.Optional(TodoTaskRecord),
    id: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "remove: ID of the removed Task",
      }),
    ),
    cleared: Type.Optional(
      Type.Integer({ minimum: 0, description: "clear: number of Tasks removed" }),
    ),
  },
  { additionalProperties: false },
);

/** Serialized shape stored in a `pi-todo-state` session entry. */
export const TodoStateRecord = Type.Object({
  nextId: PositiveSafeIntegerRecord,
  tasks: Type.Array(TodoTaskRecord),
});

/** Expected Task-operation failure translated to a Pi tool error at the extension boundary. */
export class TodoOperationError extends Error {
  readonly _tag = "TodoOperationError" as const;

  constructor(
    readonly action: TodoAction,
    message: string,
  ) {
    super(message);
  }
}

/** Pure outcome of applying one Todo List operation. */
export type TodoActionResult =
  | {
      readonly ok: true;
      readonly state: TodoStateSnapshot;
      readonly message: string;
      readonly details: TodoToolDetails;
    }
  | { readonly ok: false; readonly error: TodoOperationError };

function parseTodoTaskId(value: number): TodoTaskId | undefined {
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  // SAFETY: The checks above establish the positive safe-integer Task ID invariant.
  return value as TodoTaskId;
}

/** Creates an empty Todo List whose first Task receives ID 1. */
export function createEmptyTodoState(): TodoStateSnapshot {
  return { nextId: 1, tasks: [] };
}

/** Parses a structurally checked session record into ordered, immutable Todo List state. */
export function parseTodoStateSnapshot(
  input: Static<typeof TodoStateRecord>,
): TodoStateSnapshot | undefined {
  let previousId = 0;
  const tasks: TodoTask[] = [];
  for (const task of input.tasks) {
    const id = parseTodoTaskId(task.id);
    if (
      id === undefined ||
      id <= previousId ||
      task.title.trim() !== task.title ||
      (task.description !== undefined && task.description.trim() !== task.description)
    ) {
      return undefined;
    }
    tasks.push(
      task.description === undefined
        ? { id, title: task.title, status: task.status }
        : { id, title: task.title, description: task.description, status: task.status },
    );
    previousId = id;
  }
  return input.nextId > previousId ? { nextId: input.nextId, tasks } : undefined;
}

function todoOperationFailure(action: TodoAction, message: string): TodoActionResult {
  return { ok: false, error: new TodoOperationError(action, message) };
}

function newTodoTask(
  id: TodoTaskId,
  title: string,
  description: string | undefined,
  status: TodoStatus,
): TodoTask {
  return description ? { id, title, description, status } : { id, title, status };
}

/** Counts Tasks in model-facing text: "1 Task", "3 Tasks". */
export function formatTaskCount(count: number): string {
  return `${count} ${count === 1 ? "Task" : "Tasks"}`;
}

type ParsedTodoDraft = { readonly title: string; readonly description: string | undefined };

/** Trims and validates one Task to add; `field` prefixes the field name in the failure message. */
function parseTodoDraft(
  title: string | undefined,
  description: string | null | undefined,
  field: string,
): ParsedTodoDraft | TodoActionResult {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) {
    return todoOperationFailure("add", `Todo add failed: ${field}title must not be empty`);
  }
  const trimmedDescription = description?.trim();
  if (description !== undefined && description !== null && !trimmedDescription) {
    return todoOperationFailure("add", `Todo add failed: ${field}description must not be empty`);
  }
  return { title: trimmedTitle, description: trimmedDescription };
}

function isTodoActionResult(value: ParsedTodoDraft | TodoActionResult): value is TodoActionResult {
  return "ok" in value;
}

function addTask(state: TodoStateSnapshot, input: TodoActionInput): TodoActionResult {
  const draft = parseTodoDraft(input.title, input.description, "");
  if (isTodoActionResult(draft)) return draft;
  const id = parseTodoTaskId(state.nextId);
  if (id === undefined || state.nextId === Number.MAX_SAFE_INTEGER) {
    return todoOperationFailure("add", "Todo add failed: Task ID limit reached");
  }
  const task = newTodoTask(id, draft.title, draft.description, input.status ?? "pending");
  return {
    ok: true,
    state: { nextId: state.nextId + 1, tasks: [...state.tasks, task] },
    message: `Added Task #${task.id}`,
    details: { action: "add", task },
  };
}

/** Validates every draft before creating any Task, so a batch is all-or-nothing. */
function addTasks(
  state: TodoStateSnapshot,
  input: TodoActionInput & { readonly tasks: readonly TodoTaskDraft[] },
): TodoActionResult {
  // A null description is "absent" for add, as it is for a single Task.
  if (input.title !== undefined || (input.description ?? undefined) !== undefined) {
    return todoOperationFailure("add", "Todo add failed: provide either title or tasks, not both");
  }
  if (input.tasks.length === 0) {
    return todoOperationFailure("add", "Todo add failed: tasks must not be empty");
  }
  const drafts: ParsedTodoDraft[] = [];
  for (const [index, task] of input.tasks.entries()) {
    const draft = parseTodoDraft(task.title, task.description, `tasks[${index}].`);
    if (isTodoActionResult(draft)) return draft;
    drafts.push(draft);
  }
  // The last Task's successor ID must stay a safe integer so the saved state restores.
  const exceedsIdLimit = state.nextId + drafts.length > Number.MAX_SAFE_INTEGER;
  const status = input.status ?? "pending";
  const added: TodoTask[] = [];
  for (const [index, { title, description }] of drafts.entries()) {
    const id = parseTodoTaskId(state.nextId + index);
    if (id === undefined || exceedsIdLimit) {
      return todoOperationFailure("add", "Todo add failed: Task ID limit reached");
    }
    added.push(newTodoTask(id, title, description, status));
  }
  return {
    ok: true,
    state: { nextId: state.nextId + added.length, tasks: [...state.tasks, ...added] },
    message: `Added ${formatTaskCount(added.length)}\n${formatTodoList(added)}`,
    details: { action: "add", tasks: added },
  };
}

/** Applies one validated-by-schema tool request without performing session or UI effects. */
export function applyTodoAction(
  state: TodoStateSnapshot,
  input: TodoActionInput,
): TodoActionResult {
  switch (input.action) {
    case "list":
      return {
        ok: true,
        state,
        message: formatTodoList(state.tasks),
        details: { action: "list", tasks: state.tasks },
      };

    case "add":
      return input.tasks === undefined
        ? addTask(state, input)
        : addTasks(state, { ...input, tasks: input.tasks });

    case "update":
    case "remove": {
      const action = input.action;
      if (input.id === undefined) {
        return todoOperationFailure(action, `Todo ${action} failed: id is required`);
      }
      const id = parseTodoTaskId(input.id);
      if (id === undefined) {
        return todoOperationFailure(
          action,
          `Todo ${action} failed: id must be a positive safe integer`,
        );
      }
      const task = state.tasks.find((candidate) => candidate.id === id);
      if (!task) {
        return todoOperationFailure(
          action,
          `Todo ${action} failed: Task #${input.id} was not found`,
        );
      }
      if (action === "remove") {
        return {
          ok: true,
          state: {
            nextId: state.nextId,
            tasks: state.tasks.filter((candidate) => candidate.id !== task.id),
          },
          message: `Removed Task #${task.id}`,
          details: { action: "remove", id: task.id },
        };
      }
      if (
        input.title === undefined &&
        input.description === undefined &&
        input.status === undefined
      ) {
        return todoOperationFailure(
          "update",
          "Todo update failed: provide a title, description, or status",
        );
      }
      const title = input.title === undefined ? task.title : input.title.trim();
      if (!title) {
        return todoOperationFailure("update", "Todo update failed: title must not be empty");
      }
      const description =
        input.description === undefined ? task.description : input.description?.trim();
      if (input.description !== undefined && input.description !== null && !description) {
        return todoOperationFailure("update", "Todo update failed: description must not be empty");
      }
      const updatedTask: TodoTask = description
        ? { id: task.id, title, description, status: input.status ?? task.status }
        : { id: task.id, title, status: input.status ?? task.status };
      return {
        ok: true,
        state: {
          nextId: state.nextId,
          tasks: state.tasks.map((candidate) =>
            candidate.id === updatedTask.id ? updatedTask : candidate,
          ),
        },
        message: `Updated Task #${task.id}`,
        details: { action: "update", task: updatedTask },
      };
    }

    case "clear": {
      const count = state.tasks.length;
      return {
        ok: true,
        state: count > 0 || state.nextId !== 1 ? createEmptyTodoState() : state,
        message: `Cleared ${formatTaskCount(count)}`,
        details: { action: "clear", cleared: count },
      };
    }
  }
}

/** Returns the status marker shared by model context, transcript, and widget output. */
export function todoStatusMarker(status: TodoStatus): "[ ]" | "[>]" | "[x]" {
  if (status === "pending") return "[ ]";
  return status === "active" ? "[>]" : "[x]";
}

function formatTodoDescription(description: string): string {
  return "    " + description.replaceAll("\n", "\n    ");
}

/** Formats the complete numeric-ID-ordered Todo List for tools and model context. */
export function formatTodoList(tasks: readonly TodoTask[]): string {
  if (tasks.length === 0) return "Todo List is empty";
  return tasks
    .map((task) => {
      const description = task.description ? `\n${formatTodoDescription(task.description)}` : "";
      return `${todoStatusMarker(task.status)} #${task.id} ${task.title}${description}`;
    })
    .join("\n");
}
