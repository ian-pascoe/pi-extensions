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

    const added = await harness.tool.execute(
      "call-add",
      {
        action: "add",
        title: "  Ship the extension  ",
        description: "  Run the focused checks.  ",
        status: "active",
      },
      undefined,
      undefined,
      context,
    );
    const listed = await harness.tool.execute(
      "call-list",
      { action: "list" },
      undefined,
      undefined,
      context,
    );

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
    const execute = (params: TodoActionInput) =>
      harness.tool.execute("call-mutate", params, undefined, undefined, context);

    await execute({ action: "add", title: "First", description: "Details" });
    await execute({ action: "add", title: "Second" });
    expect(
      resultText(
        await execute({ action: "update", id: 1, description: null, status: "completed" }),
      ),
    ).toBe("Updated Task #1");
    expect(resultText(await execute({ action: "remove", id: 2 }))).toBe("Removed Task #2");
    expect(resultText(await execute({ action: "add", title: "Third" }))).toBe("Added Task #3");
    expect(resultText(await execute({ action: "list" }))).toBe("[x] #1 First\n[ ] #3 Third");

    expect(resultText(await execute({ action: "clear" }))).toBe("Cleared 2 Tasks");
    expect(resultText(await execute({ action: "add", title: "After clear" }))).toBe(
      "Added Task #1",
    );
    await expect(execute({ action: "update", id: 99, status: "active" })).rejects.toThrow(
      "Todo update failed: Task #99 was not found",
    );
    await expect(execute({ action: "remove", id: 99 })).rejects.toThrow(
      "Todo remove failed: Task #99 was not found",
    );
    await expect(execute({ action: "update", id: 1 })).rejects.toThrow(
      "Todo update failed: provide a title, description, or status",
    );
    await expect(execute({ action: "add", title: "   " })).rejects.toThrow(
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
    const execute = (params: TodoActionInput) =>
      harness.tool.execute("call-reset", params, undefined, undefined, context);
    await execute({ action: "add", title: "Temporary" });
    await execute({ action: "remove", id: 1 });
    await execute({ action: "clear" });
    expect(resultText(await execute({ action: "add", title: "Fresh" }))).toBe("Added Task #1");
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
    await expect(
      harness.tool.execute(
        "call-limit",
        { action: "add", title: "Too far" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("Task ID limit reached");
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
    const listed = await harness.tool.execute(
      "call-list-restored",
      { action: "list" },
      undefined,
      undefined,
      context,
    );
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
    const execute = (params: TodoActionInput) =>
      harness.tool.execute("call-widget", params, undefined, undefined, context);

    await execute({
      action: "add",
      title: "Active one with a title that must truncate",
      status: "active",
    });
    await execute({ action: "add", title: "Pending one" });
    await execute({ action: "add", title: "Completed one", status: "completed" });
    await execute({ action: "add", title: "Active two", status: "active" });
    await execute({ action: "add", title: "Pending two" });
    const listed = await execute({
      action: "add",
      title: "Completed two",
      description: "Only expanded transcript output shows this.",
      status: "completed",
    });

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

    const listResult = await execute({ action: "list" });
    const transcriptTool = harness.tool;
    if (!transcriptTool.renderCall || !transcriptTool.renderResult) {
      throw new Error("Todo extension test harness did not receive custom transcript renderers");
    }
    expect(
      renderTodoComponent(
        transcriptTool.renderCall(
          { action: "update", id: 4, status: "completed" },
          createTodoTestTheme(),
        ),
        80,
      ),
    ).toEqual(["todo update #4"]);
    expect(
      renderTodoComponent(
        transcriptTool.renderResult(
          listResult,
          { expanded: false, isPartial: false },
          createTodoTestTheme(),
        ),
        80,
      ).join("\n"),
    ).toBe(
      "6 Tasks:\n[>] #1 Active one with a title that must truncate\n[ ] #2 Pending one\n[x] #3 ~Completed one~\n[>] #4 Active two\n[ ] #5 Pending two\n… 1 more",
    );
    expect(
      renderTodoComponent(
        transcriptTool.renderResult(
          listResult,
          { expanded: true, isPartial: false },
          createTodoTestTheme(),
        ),
        100,
      ).join("\n"),
    ).toContain("[x] #6 ~Completed two~\n    Only expanded transcript output shows this.");
    expect(
      renderTodoComponent(
        transcriptTool.renderResult(
          listed,
          { expanded: false, isPartial: false },
          createTodoTestTheme(),
        ),
        80,
      ),
    ).toEqual(["✓ Added Task #6"]);
    expect(
      renderTodoComponent(
        transcriptTool.renderResult(
          { content: [{ type: "text", text: "Todo update failed: Task #99 was not found" }] },
          { expanded: false, isPartial: false },
          createTodoTestTheme(),
        ),
        80,
      ),
    ).toEqual(["Todo update failed: Task #99 was not found"]);

    const completions = await harness.command.getArgumentCompletions?.("cl");
    expect(completions).toEqual([
      { value: "clear", label: "clear", description: "Clear the Todo List" },
    ]);

    harness.confirmResult = false;
    await harness.command.handler("clear", context);
    expect(resultText(await execute({ action: "list" }))).toContain("#1 Active one");

    harness.confirmResult = true;
    await harness.command.handler("clear", context);
    expect(resultText(await execute({ action: "list" }))).toBe("Todo List is empty");
    expect(harness.widget).toBeUndefined();
    expect(harness.notifications.at(-1)).toEqual({ message: "Cleared 6 Tasks", type: "info" });

    expect(listed.details?.action).toBe("add");
  });
});
