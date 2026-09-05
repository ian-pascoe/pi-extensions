import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  applyTodoAction,
  createEmptyTodoState,
  formatTodoList,
  parseTodoStateSnapshot,
  TODO_ACTIONS,
  TODO_STATUSES,
  TodoStateRecord,
  todoStatusMarker,
  type TodoActionInput,
  type TodoStateSnapshot,
  type TodoStatus,
  type TodoTask,
  type TodoToolDetails,
} from "./todo-list.js";

const TODO_STATE_ENTRY_TYPE = "pi-todo-state";
const TODO_WIDGET_ID = "pi-todo";
const TODO_WIDGET_STATUS_ORDER: readonly TodoStatus[] = ["active", "pending", "completed"];
const TODO_COLLAPSED_TASK_LIMIT = 5;

const TodoParameters = Type.Object({
  action: StringEnum(TODO_ACTIONS),
  id: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Task ID for update or remove",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Task title for add or update" })),
  description: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Optional Task description; null removes it during update",
    }),
  ),
  status: Type.Optional(StringEnum(TODO_STATUSES)),
});

function restoreTodoState(context: ExtensionContext): TodoStateSnapshot {
  for (const entry of context.sessionManager.getBranch().toReversed()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== TODO_STATE_ENTRY_TYPE ||
      !Value.Check(TodoStateRecord, entry.data)
    ) {
      continue;
    }
    const snapshot = parseTodoStateSnapshot(entry.data);
    if (snapshot) return snapshot;
  }
  return createEmptyTodoState();
}

function renderTodoTaskLine(task: TodoTask, theme: Theme): string {
  const markerColor =
    task.status === "active" ? "accent" : task.status === "completed" ? "success" : "muted";
  const title =
    task.status === "active"
      ? theme.bold(task.title)
      : task.status === "completed"
        ? theme.strikethrough(task.title)
        : task.title;
  const titleColor = task.status === "completed" ? "dim" : "text";
  return `${theme.fg(markerColor, todoStatusMarker(task.status))} ${theme.fg("accent", `#${task.id}`)} ${theme.fg(titleColor, title)}`;
}

class TodoWidget implements Component {
  constructor(
    private readonly tasks: readonly TodoTask[],
    private readonly theme: Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const active = this.tasks.filter((task) => task.status === "active").length;
    const pending = this.tasks.filter((task) => task.status === "pending").length;
    const completed = this.tasks.length - active - pending;
    const header =
      this.theme.fg("toolTitle", this.theme.bold("TODO")) +
      this.theme.fg("muted", `  ${active} active · ${pending} pending · ${completed} completed`);
    const orderedTasks = this.tasks.toSorted((left, right) => {
      const statusDifference =
        TODO_WIDGET_STATUS_ORDER.indexOf(left.status) -
        TODO_WIDGET_STATUS_ORDER.indexOf(right.status);
      return statusDifference === 0 ? left.id - right.id : statusDifference;
    });
    const lines = [header];
    for (const task of orderedTasks.slice(0, TODO_COLLAPSED_TASK_LIMIT)) {
      lines.push(renderTodoTaskLine(task, this.theme));
    }
    const remaining = orderedTasks.length - TODO_COLLAPSED_TASK_LIMIT;
    if (remaining > 0) lines.push(this.theme.fg("dim", `… ${remaining} more`));
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }
}

/** Installs the session-native Todo List tool into Pi. */
export default function piTodoExtension(pi: ExtensionAPI): void {
  let state = createEmptyTodoState();

  const updateTodoWidget = (context: ExtensionContext): void => {
    if (context.mode !== "tui") return;
    context.ui.setWidget(
      TODO_WIDGET_ID,
      state.tasks.length === 0 ? undefined : (_tui, theme) => new TodoWidget(state.tasks, theme),
    );
  };
  const commitTodoState = (snapshot: TodoStateSnapshot, context: ExtensionContext): void => {
    state = snapshot;
    pi.appendEntry(TODO_STATE_ENTRY_TYPE, state);
    updateTodoWidget(context);
  };
  const runTodoAction = (input: TodoActionInput, context: ExtensionContext) => {
    const result = applyTodoAction(state, input);
    if (!result.ok) throw result.error;
    if (result.changed) commitTodoState(result.state, context);
    return result;
  };
  const restoreState = (context: ExtensionContext): void => {
    state = restoreTodoState(context);
    updateTodoWidget(context);
  };
  pi.on("session_start", (_event, context) => restoreState(context));
  pi.on("session_tree", (_event, context) => restoreState(context));
  pi.on("context", (event) => {
    if (state.tasks.length === 0) return;
    const todoListMessage = {
      role: "custom",
      customType: "pi-todo-context",
      content: `Todo List:\n${formatTodoList(state.tasks)}`,
      display: false,
      timestamp: 0,
    } as const;
    return { messages: [...event.messages, todoListMessage] };
  });

  pi.registerTool<typeof TodoParameters, TodoToolDetails | undefined>({
    name: "todo",
    label: "Todo",
    description: "Manage the current session branch's Todo List.",
    parameters: TodoParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const result = runTodoAction(params, context);
      return {
        content: [{ type: "text", text: result.message }],
        details: result.details,
      };
    },
    renderCall: (params, theme) => {
      let text = theme.fg("toolTitle", theme.bold("todo")) + theme.fg("muted", ` ${params.action}`);
      if (params.id !== undefined) text += theme.fg("accent", ` #${params.id}`);
      if (params.action === "add" && params.title) text += theme.fg("dim", ` "${params.title}"`);
      return new Text(text, 0, 0);
    },
    renderResult: (result, { expanded }, theme) => {
      const text = result.content.find((item) => item.type === "text");
      if (!result.details) {
        return new Text(
          theme.fg("error", text?.type === "text" ? text.text : "Todo operation failed"),
          0,
          0,
        );
      }
      if (result.details.action === "list") {
        const tasks = result.details.tasks;
        if (tasks.length === 0) return new Text(theme.fg("dim", "Todo List is empty"), 0, 0);
        const visibleTasks = expanded ? tasks : tasks.slice(0, TODO_COLLAPSED_TASK_LIMIT);
        const lines = [
          theme.fg("muted", `${tasks.length} ${tasks.length === 1 ? "Task" : "Tasks"}:`),
        ];
        for (const task of visibleTasks) {
          lines.push(renderTodoTaskLine(task, theme));
          if (expanded && task.description) {
            lines.push(
              ...task.description.split("\n").map((line) => theme.fg("dim", `    ${line}`)),
            );
          }
        }
        const remaining = tasks.length - visibleTasks.length;
        if (remaining > 0) lines.push(theme.fg("dim", `… ${remaining} more`));
        return new Text(lines.join("\n"), 0, 0);
      }
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : "Done"),
        0,
        0,
      );
    },
  });

  pi.registerCommand("todo", {
    description: "Manage the Todo List",
    getArgumentCompletions: (argumentPrefix) =>
      "clear".startsWith(argumentPrefix.trim())
        ? [{ value: "clear", label: "clear", description: "Clear the Todo List" }]
        : null,
    handler: async (args, context) => {
      if (args.trim() !== "clear") {
        context.ui.notify("Usage: /todo clear", "info");
        return;
      }
      if (context.mode !== "tui") {
        context.ui.notify("/todo clear requires interactive mode", "error");
        return;
      }
      await context.waitForIdle();
      if (state.tasks.length === 0) {
        context.ui.notify("Todo List is already empty", "info");
        return;
      }
      const confirmed = await context.ui.confirm(
        "Clear Todo List",
        `Remove all ${state.tasks.length} ${state.tasks.length === 1 ? "Task" : "Tasks"}?`,
      );
      if (!confirmed) return;
      const result = runTodoAction({ action: "clear" }, context);
      context.ui.notify(result.message, "info");
    },
  });
}
