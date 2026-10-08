import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  appendDurationFooter,
  callDurationFooter,
  COLLAPSED_LINES,
  type DurationContext,
  expandHint,
  previewBody,
  SEPARATOR,
  toolHeader,
  type UiTheme,
  widgetLines,
} from "@ian-pascoe/pi-utils/ui";
import {
  formatTaskCount,
  type TodoActionInput,
  type TodoTask,
  type TodoToolDetails,
} from "./todo-list.js";

/** The theme methods the Todo renderers draw with. */
export type TodoRenderTheme = Pick<UiTheme, "fg" | "bold" | "strikethrough">;

const TODO_WIDGET_STATUS_ORDER: readonly TodoTask["status"][] = ["active", "pending", "completed"];

const CHECKBOX_FILL = { pending: " ", active: ">", completed: "x" } as const;
const CHECKBOX_COLOR = { pending: "muted", active: "accent", completed: "success" } as const;

/**
 * One Task row. The `[ ]`/`[>]`/`[x]` checkbox is the documented exception to the no-marks rule
 * for tool rows: it shows the Task's state, not the tool's outcome.
 */
export function renderTodoTaskLine(task: TodoTask, theme: TodoRenderTheme): string {
  const box =
    theme.fg("dim", "[") +
    theme.fg(CHECKBOX_COLOR[task.status], CHECKBOX_FILL[task.status]) +
    theme.fg("dim", "]");
  const title =
    task.status === "active"
      ? theme.bold(task.title)
      : task.status === "completed"
        ? theme.strikethrough(task.title)
        : task.title;
  const titleColor = task.status === "completed" ? "dim" : "text";
  return `${box} ${theme.fg("accent", `#${task.id}`)} ${theme.fg(titleColor, title)}`;
}

/** The Todo Widget lines: Active Tasks first, then pending, then completed, in at most 10 lines. */
export function renderTodoWidget(
  tasks: readonly TodoTask[],
  theme: TodoRenderTheme,
  width: number,
): string[] {
  const active = tasks.filter((task) => task.status === "active").length;
  const pending = tasks.filter((task) => task.status === "pending").length;
  const completed = tasks.length - active - pending;
  const orderedTasks = tasks.toSorted((left, right) => {
    const statusDifference =
      TODO_WIDGET_STATUS_ORDER.indexOf(left.status) -
      TODO_WIDGET_STATUS_ORDER.indexOf(right.status);
    return statusDifference === 0 ? left.id - right.id : statusDifference;
  });
  return widgetLines(theme, {
    title: "Todo",
    counts: [`${active} active`, `${pending} pending`, `${completed} completed`].join(SEPARATOR),
    rows: orderedTasks.map((task) => renderTodoTaskLine(task, theme)),
  }).map((line) => truncateToWidth(line, width, "..."));
}

function callArguments(params: TodoActionInput): string | undefined {
  const parts: string[] = [];
  if (params.id !== undefined) parts.push(`#${params.id}`);
  if (params.action === "add" && params.title) parts.push(`"${params.title}"`);
  if (params.action === "add" && params.tasks) parts.push(formatTaskCount(params.tasks.length));
  if (params.action === "update" && params.updates) {
    parts.push(formatTaskCount(params.updates.length));
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** The `todo` call row: bold `todo`, the action in `accent`, arguments in `muted`, then `Elapsed`. */
export function renderTodoCall(
  params: TodoActionInput,
  theme: TodoRenderTheme,
  context: DurationContext,
): Component {
  const container = new Container();
  container.addChild(
    new Text(toolHeader(theme, "todo", params.action, callArguments(params)), 0, 0),
  );
  container.addChild(callDurationFooter(theme, context));
  return container;
}

function taskListLines(
  action: "list" | "add" | "update",
  tasks: readonly TodoTask[],
  theme: TodoRenderTheme,
  expanded: boolean,
): string[] {
  const verb = action === "add" ? "Added " : action === "update" ? "Updated " : "";
  const lines = [theme.fg("muted", `${verb}${formatTaskCount(tasks.length)}:`)];
  if (expanded) {
    for (const task of tasks) {
      lines.push(renderTodoTaskLine(task, theme));
      if (task.description) {
        lines.push(...task.description.split("\n").map((line) => theme.fg("dim", `    ${line}`)));
      }
    }
    return lines;
  }
  lines.push(
    ...tasks.slice(0, COLLAPSED_LINES.list).map((task) => renderTodoTaskLine(task, theme)),
  );
  const hidden = tasks.length - COLLAPSED_LINES.list;
  if (hidden > 0) lines.push(expandHint(theme, hidden));
  return lines;
}

/**
 * The `todo` result row. A Task list is the Nearest Built-in `ls` (20 rows collapsed, Pi's Expand
 * Hint beyond that); a failure shows its text in `error`. Every result ends with `Took`.
 */
export function renderTodoResult(
  result: AgentToolResult<TodoToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: TodoRenderTheme,
  context: DurationContext,
): Component {
  const text = result.content.find((item) => item.type === "text")?.text;
  let body: string[];
  if (!result.details) {
    body = previewBody(theme, (text ?? "Todo operation failed").split("\n"), {
      limit: COLLAPSED_LINES.fallback,
      expanded: options.expanded,
      color: "error",
    });
  } else if ("tasks" in result.details && result.details.tasks.length > 0) {
    body = taskListLines(result.details.action, result.details.tasks, theme, options.expanded);
  } else {
    const message = "tasks" in result.details ? "Todo List is empty" : (text ?? "Done");
    body = previewBody(theme, message.split("\n"), {
      limit: COLLAPSED_LINES.fallback,
      expanded: options.expanded,
    });
  }
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(body.join("\n"), 0, 0));
  appendDurationFooter(container, theme, context, { isPartial: options.isPartial });
  return container;
}
