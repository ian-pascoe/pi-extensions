import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { acceptNullForOptionalArguments } from "@ian-pascoe/pi-utils/null-optional-arguments";
import { noticeText } from "@ian-pascoe/pi-utils/ui";
import { Type } from "typebox";
import { projectTodoContext, todoStateFromEntry } from "./todo-context.js";
import {
  applyTodoAction,
  createEmptyTodoState,
  formatTaskCount,
  TODO_ACTIONS,
  TODO_STATUSES,
  TodoToolOutputSchema,
  type TodoActionInput,
  type TodoStateSnapshot,
  type TodoTask,
  TodoOperationError,
  type TodoToolDetails,
} from "./todo-list.js";
import { renderTodoCall, renderTodoResult, renderTodoWidget } from "./todo-render.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

const TODO_STATE_ENTRY_TYPE = "pi-todo-state";
const JOURNAL_FAULT = Symbol.for("@ian-pascoe/pi-todo/journal-fault");

function assertTodoJournalReadable(context: ExtensionContext): void {
  const manager = context.sessionManager;
  const marker = Object.getOwnPropertyDescriptor(manager, JOURNAL_FAULT);
  if (marker !== undefined && marker.value === manager.getHeader()) {
    throw new Error(
      "Todo journal write failed; Todo is disabled in this loaded session, including after /reload",
    );
  }
}
const TODO_WIDGET_ID = "pi-todo";

/** Static system prompt lines, so they never move the cache prefix within a session. */
export const TODO_PROMPT_SNIPPET = "Track this session's Tasks in the Todo List";
export const TODO_PROMPT_GUIDELINE =
  "When the Todo List has Tasks, keep it current: mark a Task active when you start it and completed as soon as it is done, and bring it up to date before context is compacted.";

const TodoParameters = Type.Object({
  action: StringEnum(TODO_ACTIONS),
  id: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Task ID for update or remove; not allowed with updates",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "Task title for add or update; not allowed with tasks or updates",
    }),
  ),
  description: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "Optional Task description; null removes it during update; not allowed with tasks or updates",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(
      Type.Object(
        {
          title: Type.String({ description: "Task title" }),
          description: Type.Optional(Type.String({ description: "Optional Task description" })),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description:
          "Tasks to add in one call, all or none, with sequential IDs; use instead of title and description",
      },
    ),
  ),
  updates: Type.Optional(
    Type.Array(
      Type.Object(
        {
          id: Type.Integer({
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            description: "Task ID",
          }),
          status: Type.Optional(StringEnum(TODO_STATUSES, { description: "New Task status" })),
          title: Type.Optional(Type.String({ description: "New Task title" })),
          description: Type.Optional(
            Type.Union([Type.String(), Type.Null()], {
              description: "New Task description; null removes it",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description:
          "Task changes to apply in one call, all or none, one per Task ID; use instead of id, title, description, and status",
      },
    ),
  ),
  status: Type.Optional(
    StringEnum(TODO_STATUSES, {
      description: "Task status; for add, applies to every new Task; not allowed with updates",
    }),
  ),
});

function restoreTodoState(context: ExtensionContext): TodoStateSnapshot {
  for (const entry of context.sessionManager.getBranch().toReversed()) {
    const snapshot = todoStateFromEntry(entry);
    if (snapshot) return snapshot;
  }
  return createEmptyTodoState();
}

class TodoWidget implements Component {
  constructor(
    private readonly tasks: readonly TodoTask[],
    private readonly theme: Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderTodoWidget(this.tasks, this.theme, width);
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
    try {
      pi.appendEntry(TODO_STATE_ENTRY_TYPE, snapshot);
    } catch (cause) {
      // Todo-owned metadata survives /reload; no Pi-owned journal or agent fields are changed.
      Object.defineProperty(context.sessionManager, JOURNAL_FAULT, {
        value: context.sessionManager.getHeader(),
        configurable: true,
      });
      context.abort();
      throw cause;
    }
    state = snapshot;
    updateTodoWidget(context);
  };
  const runTodoAction = (input: TodoActionInput, context: ExtensionContext) => {
    assertTodoJournalReadable(context);
    const result = applyTodoAction(state, input);
    if (!result.ok) throw result.error;
    if (result.state !== state) commitTodoState(result.state, context);
    return result;
  };
  const restoreState = (context: ExtensionContext): void => {
    assertTodoJournalReadable(context);
    state = restoreTodoState(context);
    updateTodoWidget(context);
  };
  pi.on("session_start", (_event, context) => restoreState(context));
  pi.on("session_tree", (_event, context) => restoreState(context));
  pi.on("context", (event, context) => {
    try {
      assertTodoJournalReadable(context);
      return { messages: projectTodoContext(context.sessionManager.getBranch(), event.messages) };
    } catch (cause) {
      // Pi logs context exceptions and continues; abort the active run as well.
      context.abort();
      throw cause;
    }
  });

  const todoTool = defineTool<typeof TodoParameters, TodoToolDetails | undefined>({
    name: "todo",
    label: "Todo",
    description: "Manage the current session branch's Todo List.",
    promptSnippet: TODO_PROMPT_SNIPPET,
    promptGuidelines: [TODO_PROMPT_GUIDELINE],
    parameters: TodoParameters,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: TodoToolOutputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      signal?.throwIfAborted();
      let result: ReturnType<typeof runTodoAction>;
      try {
        result = runTodoAction(params, context);
      } catch (cause) {
        // Task-operation errors are model-fixable input errors; anything else is a journal failure.
        if (cause instanceof TodoOperationError) throw cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${message}\n\n${TROUBLESHOOTING_HINT}`, { cause });
      }
      return {
        content: [{ type: "text", text: result.message }],
        details: result.details,
        // Separate from `details` so the session's render shape and the script-facing value can
        // evolve independently; today both use the same snake_case-compatible field names.
        structuredContent: structuredClone(result.details),
      };
    },
    renderCall: (params, theme, context) => renderTodoCall(params, theme, context),
    renderResult: (result, options, theme, context) =>
      renderTodoResult(result, options, theme, context),
  });
  pi.registerTool(acceptNullForOptionalArguments(todoTool));

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
        context.ui.notify(noticeText("Todo", "/todo clear requires interactive mode"), "error");
        return;
      }
      await context.waitForIdle();
      if (state.tasks.length === 0) {
        context.ui.notify("Todo List is already empty", "info");
        return;
      }
      const confirmed = await context.ui.confirm(
        "Clear Todo List",
        `Remove all ${formatTaskCount(state.tasks.length)}?`,
      );
      if (!confirmed) return;
      const result = runTodoAction({ action: "clear" }, context);
      context.ui.notify(result.message, "info");
    },
  });
}
