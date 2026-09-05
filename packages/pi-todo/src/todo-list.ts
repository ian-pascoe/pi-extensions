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

/** Boundary input shared by the Todo tool's five operations. */
export type TodoActionInput = {
  readonly action: TodoAction;
  readonly id?: number;
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TodoStatus;
};

/** Render details whose action discriminates list data from mutation acknowledgements. */
export type TodoToolDetails =
  | { readonly action: "list"; readonly tasks: readonly TodoTask[] }
  | { readonly action: Exclude<TodoAction, "list"> };

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
      readonly changed: boolean;
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

/** Applies one validated-by-schema tool request without performing session or UI effects. */
export function applyTodoAction(
  state: TodoStateSnapshot,
  input: TodoActionInput,
): TodoActionResult {
  switch (input.action) {
    case "list":
      return {
        ok: true,
        changed: false,
        state,
        message: formatTodoList(state.tasks),
        details: { action: "list", tasks: state.tasks },
      };

    case "add": {
      const title = input.title?.trim();
      if (!title) return todoOperationFailure("add", "Todo add failed: title must not be empty");
      const description = input.description?.trim();
      if (input.description !== undefined && input.description !== null && !description) {
        return todoOperationFailure("add", "Todo add failed: description must not be empty");
      }
      const id = parseTodoTaskId(state.nextId);
      if (id === undefined || state.nextId === Number.MAX_SAFE_INTEGER) {
        return todoOperationFailure("add", "Todo add failed: Task ID limit reached");
      }
      const task: TodoTask = description
        ? { id, title, description, status: input.status ?? "pending" }
        : { id, title, status: input.status ?? "pending" };
      return {
        ok: true,
        changed: true,
        state: { nextId: state.nextId + 1, tasks: [...state.tasks, task] },
        message: `Added Task #${task.id}`,
        details: { action: "add" },
      };
    }

    case "update": {
      if (input.id === undefined) {
        return todoOperationFailure("update", "Todo update failed: id is required");
      }
      const id = parseTodoTaskId(input.id);
      if (id === undefined) {
        return todoOperationFailure(
          "update",
          "Todo update failed: id must be a positive safe integer",
        );
      }
      const task = state.tasks.find((candidate) => candidate.id === id);
      if (!task) {
        return todoOperationFailure(
          "update",
          `Todo update failed: Task #${input.id} was not found`,
        );
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
        input.description === undefined
          ? task.description
          : input.description === null
            ? undefined
            : input.description.trim();
      if (input.description !== undefined && input.description !== null && !description) {
        return todoOperationFailure("update", "Todo update failed: description must not be empty");
      }
      const updatedTask: TodoTask = description
        ? { id: task.id, title, description, status: input.status ?? task.status }
        : { id: task.id, title, status: input.status ?? task.status };
      return {
        ok: true,
        changed: true,
        state: {
          nextId: state.nextId,
          tasks: state.tasks.map((candidate) =>
            candidate.id === updatedTask.id ? updatedTask : candidate,
          ),
        },
        message: `Updated Task #${task.id}`,
        details: { action: "update" },
      };
    }

    case "remove": {
      if (input.id === undefined) {
        return todoOperationFailure("remove", "Todo remove failed: id is required");
      }
      const id = parseTodoTaskId(input.id);
      if (id === undefined) {
        return todoOperationFailure(
          "remove",
          "Todo remove failed: id must be a positive safe integer",
        );
      }
      const task = state.tasks.find((candidate) => candidate.id === id);
      if (!task) {
        return todoOperationFailure(
          "remove",
          `Todo remove failed: Task #${input.id} was not found`,
        );
      }
      return {
        ok: true,
        changed: true,
        state: {
          nextId: state.nextId,
          tasks: state.tasks.filter((candidate) => candidate.id !== task.id),
        },
        message: `Removed Task #${task.id}`,
        details: { action: "remove" },
      };
    }

    case "clear": {
      const count = state.tasks.length;
      return {
        ok: true,
        changed: count > 0 || state.nextId !== 1,
        state: createEmptyTodoState(),
        message: `Cleared ${count} ${count === 1 ? "Task" : "Tasks"}`,
        details: { action: "clear" },
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
  return description
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
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
