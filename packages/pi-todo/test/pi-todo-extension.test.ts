import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  SessionEntry,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import todoExtension from "../src/index.js";
import type { TodoActionInput, TodoToolDetails } from "../src/todo-list.js";

type TodoToolResult = {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: TodoToolDetails;
};
type TodoWidgetFactory = (tui: TUI, theme: Theme) => Component;
type ContextEventResult = { readonly messages?: ContextEvent["messages"] };
type ExtensionMode = ExtensionContext["mode"];
type RegisteredTodoTool = {
  readonly name: string;
  execute(
    toolCallId: string,
    params: TodoActionInput,
    signal: undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<TodoToolResult>;
  renderCall?(params: TodoActionInput, theme: Theme): Component;
  renderResult?(
    result: TodoToolResult,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
    theme: Theme,
  ): Component;
};
type RegisteredTodoCommand = {
  readonly getArgumentCompletions?: (
    argumentPrefix: string,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler(args: string, context: ExtensionCommandContext): Promise<void>;
};
type ExtensionEvent = ContextEvent | SessionStartEvent | SessionTreeEvent;
type ExtensionEventHandler = (
  event: ExtensionEvent,
  context: ExtensionContext,
) => ContextEventResult | void | Promise<ContextEventResult | void>;

type RecordedTodoEntry = { readonly customType: string; readonly data: JsonValue };

class TodoExtensionHarness {
  readonly entries: RecordedTodoEntry[] = [];
  readonly handlers = new Map<string, ExtensionEventHandler>();
  readonly notifications: Array<{ readonly message: string; readonly type?: string }> = [];
  confirmResult = true;
  widget: string[] | TodoWidgetFactory | undefined;
  private registeredCommand: RegisteredTodoCommand | undefined;
  private registeredTool: RegisteredTodoTool | undefined;

  constructor() {
    const api = {
      appendEntry: (customType: string, data: JsonValue) => {
        this.entries.push({ customType, data });
      },
      on: (event: string, handler: ExtensionEventHandler) => {
        this.handlers.set(event, handler);
      },
      registerCommand: (_name: string, command: RegisteredTodoCommand) => {
        this.registeredCommand = command;
      },
      registerTool: (tool: RegisteredTodoTool) => {
        this.registeredTool = tool;
      },
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-widen-then-assert -- SAFETY: The extension exercises only the recorded ExtensionAPI methods in this boundary harness.
    todoExtension(api as unknown as ExtensionAPI);
  }

  get command(): RegisteredTodoCommand {
    if (!this.registeredCommand) {
      throw new Error("Todo extension test harness did not receive the todo command");
    }
    return this.registeredCommand;
  }

  get tool(): RegisteredTodoTool {
    if (!this.registeredTool) {
      throw new Error("Todo extension test harness did not receive the todo tool");
    }
    return this.registeredTool;
  }

  async emit(
    eventName: string,
    event: ExtensionEvent,
    context: ExtensionContext,
  ): Promise<ContextEventResult | void> {
    const handler = this.handlers.get(eventName);
    if (!handler) throw new Error(`Todo extension test harness did not receive ${eventName}`);
    return handler(event, context);
  }

  execute(params: TodoActionInput, context: ExtensionContext): Promise<TodoToolResult> {
    return this.tool.execute("call-todo", params, undefined, undefined, context);
  }

  context(
    branch: readonly SessionEntry[] = [],
    mode: ExtensionMode = "print",
  ): ExtensionCommandContext {
    const context = {
      hasUI: mode === "tui",
      mode,
      sessionManager: { getBranch: () => branch },
      ui: {
        confirm: async () => this.confirmResult,
        notify: (message: string, type?: string) => {
          this.notifications.push(type === undefined ? { message } : { message, type });
        },
        setWidget: (_key: string, content: string[] | TodoWidgetFactory | undefined) => {
          this.widget = content;
        },
      },
      waitForIdle: async () => undefined,
    };
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-widen-then-assert -- SAFETY: Tests provide every ExtensionCommandContext member read by the extension paths under test.
    return context as unknown as ExtensionCommandContext;
  }
}

function resultText(result: TodoToolResult): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

function createTodoTestTheme(): Theme {
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    strikethrough: (text: string) => `~${text}~`,
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-widen-then-assert -- SAFETY: Render tests exercise only the three Theme methods supplied above.
  return theme as unknown as Theme;
}

function renderTodoComponent(component: Component, width: number): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

function renderTodoWidget(harness: TodoExtensionHarness, width: number): string[] {
  const widget = harness.widget;
  if (widget === undefined || Array.isArray(widget)) {
    throw new Error("Todo extension test harness did not receive the Todo Widget component");
  }
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-widen-then-assert -- SAFETY: The Todo Widget does not read the TUI object during rendering.
  const tui = {} as unknown as TUI;
  return renderTodoComponent(widget(tui, createTodoTestTheme()), width);
}

describe("Pi Todo extension", () => {
  test("agent can add and list session Tasks", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();

    const added = await harness.execute(
      {
        action: "add",
        title: "  Ship the extension  ",
        description: "  Run the focused checks.  ",
        status: "active",
      },
      context,
    );
    const listed = await harness.execute({ action: "list" }, context);

    expect(harness.tool.name).toBe("todo");
    expect(resultText(added)).toBe("Added Task #1");
    expect(resultText(listed)).toBe("[>] #1 Ship the extension\n    Run the focused checks.");
    expect(harness.entries).toEqual([
      {
        customType: "pi-todo-state",
        data: {
          nextId: 2,
          tasks: [
            {
              id: 1,
              title: "Ship the extension",
              description: "Run the focused checks.",
              status: "active",
            },
          ],
        },
      },
    ]);
  });

  test("agent can update, remove, and clear Tasks without accidental ID reuse", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();

    await harness.execute({ action: "add", title: "First", description: "Details" }, context);
    await harness.execute({ action: "add", title: "Second" }, context);
    expect(
      resultText(
        await harness.execute(
          { action: "update", id: 1, description: null, status: "completed" },
          context,
        ),
      ),
    ).toBe("Updated Task #1");
    expect(resultText(await harness.execute({ action: "remove", id: 2 }, context))).toBe(
      "Removed Task #2",
    );
    expect(resultText(await harness.execute({ action: "add", title: "Third" }, context))).toBe(
      "Added Task #3",
    );
    expect(resultText(await harness.execute({ action: "list" }, context))).toBe(
      "[x] #1 First\n[ ] #3 Third",
    );

    expect(resultText(await harness.execute({ action: "clear" }, context))).toBe("Cleared 2 Tasks");
    expect(
      resultText(await harness.execute({ action: "add", title: "After clear" }, context)),
    ).toBe("Added Task #1");
    await expect(
      harness.execute({ action: "update", id: 99, status: "active" }, context),
    ).rejects.toThrow("Todo update failed: Task #99 was not found");
    await expect(harness.execute({ action: "remove", id: 99 }, context)).rejects.toThrow(
      "Todo remove failed: Task #99 was not found",
    );
    for (const action of ["update", "remove"] as const) {
      await expect(harness.execute({ action }, context)).rejects.toThrow(
        `Todo ${action} failed: id is required`,
      );
      await expect(harness.execute({ action, id: 0 }, context)).rejects.toThrow(
        `Todo ${action} failed: id must be a positive safe integer`,
      );
    }
    await expect(harness.execute({ action: "update", id: 1 }, context)).rejects.toThrow(
      "Todo update failed: provide a title, description, or status",
    );
    await expect(harness.execute({ action: "add", title: "   " }, context)).rejects.toThrow(
      "Todo add failed: title must not be empty",
    );

    expect(harness.entries.at(0)?.data).toEqual({
      nextId: 2,
      tasks: [{ id: 1, title: "First", description: "Details", status: "pending" }],
    });
    expect(harness.entries.at(-1)?.data).toEqual({
      nextId: 2,
      tasks: [{ id: 1, title: "After clear", status: "pending" }],
    });
  });

  test("clear resets IDs after every Task was individually removed", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    await harness.execute({ action: "add", title: "Temporary" }, context);
    await harness.execute({ action: "remove", id: 1 }, context);
    await harness.execute({ action: "clear" }, context);
    expect(resultText(await harness.execute({ action: "add", title: "Fresh" }, context))).toBe(
      "Added Task #1",
    );
  });

  test("list and repeated empty clear append only the required reset snapshot", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();

    await harness.execute({ action: "add", title: "Temporary" }, context);
    await harness.execute({ action: "remove", id: 1 }, context);
    await harness.execute({ action: "list" }, context);
    expect(harness.entries).toHaveLength(2);

    await harness.execute({ action: "clear" }, context);
    expect(harness.entries).toHaveLength(3);
    expect(harness.entries.at(-1)?.data).toEqual({ nextId: 1, tasks: [] });

    await harness.execute({ action: "clear" }, context);
    expect(harness.entries).toHaveLength(3);
  });

  test("rejects ID exhaustion without persisting an unrestorable snapshot", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context([
      {
        type: "custom",
        id: "limit",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "pi-todo-state",
        data: { nextId: Number.MAX_SAFE_INTEGER, tasks: [] },
      },
    ]);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, context);
    await expect(harness.execute({ action: "add", title: "Too far" }, context)).rejects.toThrow(
      "Task ID limit reached",
    );
    expect(harness.entries).toHaveLength(0);
  });

  test("restores the latest valid branch snapshot and appends cache-friendly model context", async () => {
    const validStateEntry = {
      type: "custom",
      id: "state-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "pi-todo-state",
      data: {
        nextId: 5,
        tasks: [
          { id: 2, title: "Pending work", status: "pending" },
          {
            id: 4,
            title: "Current work",
            description: "Keep the cache warm.\nThen continue.",
            status: "active",
          },
        ],
      },
    } satisfies SessionEntry;
    const malformedStateEntry = {
      type: "custom",
      id: "state-2",
      parentId: "state-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "pi-todo-state",
      data: { nextId: 1, tasks: [{ id: 7, title: "Broken", status: "unknown" }] },
    } satisfies SessionEntry;
    const harness = new TodoExtensionHarness();
    const context = harness.context([validStateEntry, malformedStateEntry]);

    await harness.emit("session_start", { type: "session_start", reason: "resume" }, context);
    const listed = await harness.execute({ action: "list" }, context);
    const contextResult = await harness.emit("context", { type: "context", messages: [] }, context);

    expect(resultText(listed)).toBe(
      "[ ] #2 Pending work\n[>] #4 Current work\n    Keep the cache warm.\n    Then continue.",
    );
    expect(contextResult).toEqual({
      messages: [
        {
          role: "custom",
          customType: "pi-todo-context",
          content:
            "Todo List:\n[ ] #2 Pending work\n[>] #4 Current work\n    Keep the cache warm.\n    Then continue.",
          display: false,
          timestamp: 0,
        },
      ],
    });
  });

  test("renders a compact Todo Widget and confirms manual clearing", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context([], "tui");

    await harness.execute(
      {
        action: "add",
        title: "Active one with a title that must truncate",
        status: "active",
      },
      context,
    );
    await harness.execute({ action: "add", title: "Pending one" }, context);
    await harness.execute({ action: "add", title: "Completed one", status: "completed" }, context);
    await harness.execute({ action: "add", title: "Active two", status: "active" }, context);
    await harness.execute({ action: "add", title: "Pending two" }, context);
    const listed = await harness.execute(
      {
        action: "add",
        title: "Completed two",
        description: "Only expanded transcript output shows this.",
        status: "completed",
      },
      context,
    );

    expect(renderTodoWidget(harness, 36)).toEqual([
      "TODO  2 active · 2 pending · 2 comp…",
      "[>] #1 Active one with a title that…",
      "[>] #4 Active two",
      "[ ] #2 Pending one",
      "[ ] #5 Pending two",
      "[x] #3 ~Completed one~",
      "… 1 more",
    ]);
    expect(renderTodoWidget(harness, 36).every((line) => visibleWidth(line) <= 36)).toBe(true);

    const listResult = await harness.execute({ action: "list" }, context);
    const transcriptTool = harness.tool;
    if (!transcriptTool.renderCall || !transcriptTool.renderResult) {
      throw new Error("Todo extension test harness did not receive custom transcript renderers");
    }
    const renderResult = transcriptTool.renderResult.bind(transcriptTool);
    const renderResultText = (result: TodoToolResult, expanded = false, width = 80) =>
      renderTodoComponent(
        renderResult(result, { expanded, isPartial: false }, createTodoTestTheme()),
        width,
      ).join("\n");
    expect(
      renderTodoComponent(
        transcriptTool.renderCall(
          { action: "update", id: 4, status: "completed" },
          createTodoTestTheme(),
        ),
        80,
      ),
    ).toEqual(["todo update #4"]);
    expect(renderResultText(listResult)).toBe(
      "6 Tasks:\n[>] #1 Active one with a title that must truncate\n[ ] #2 Pending one\n[x] #3 ~Completed one~\n[>] #4 Active two\n[ ] #5 Pending two\n… 1 more",
    );
    expect(renderResultText(listResult, true, 100)).toContain(
      "[x] #6 ~Completed two~\n    Only expanded transcript output shows this.",
    );
    expect(renderResultText(listed)).toBe("✓ Added Task #6");
    expect(
      renderResultText({
        content: [{ type: "text", text: "Todo update failed: Task #99 was not found" }],
      }),
    ).toBe("Todo update failed: Task #99 was not found");

    const completions = await harness.command.getArgumentCompletions?.("cl");
    expect(completions).toEqual([
      { value: "clear", label: "clear", description: "Clear the Todo List" },
    ]);

    harness.confirmResult = false;
    await harness.command.handler("clear", context);
    expect(resultText(await harness.execute({ action: "list" }, context))).toContain(
      "#1 Active one",
    );

    harness.confirmResult = true;
    await harness.command.handler("clear", context);
    expect(resultText(await harness.execute({ action: "list" }, context))).toBe(
      "Todo List is empty",
    );
    expect(harness.widget).toBeUndefined();
    expect(harness.notifications.at(-1)).toEqual({ message: "Cleared 6 Tasks", type: "info" });

    expect(listed.details?.action).toBe("add");
  });
});
