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
import { existsSync } from "node:fs";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import todoExtension from "../src/index.js";
import type { TodoActionInput, TodoTaskChange, TodoToolDetails } from "../src/todo-list.js";
import { TROUBLESHOOTING_HINT, TROUBLESHOOTING_SKILL_PATH } from "../src/troubleshooting-skill.js";

type TodoToolResult = {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: TodoToolDetails;
  readonly structuredContent?: JsonValue;
};
type TodoWidgetFactory = (tui: TUI, theme: Theme) => Component;
type ContextEventResult = { readonly messages?: ContextEvent["messages"] };
type ExtensionMode = ExtensionContext["mode"];
type RegisteredTodoTool = {
  readonly name: string;
  readonly outputSchema?: TSchema;
  readonly parameters: TSchema;
  execute(
    toolCallId: string,
    params: TodoActionInput,
    signal: AbortSignal | undefined,
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
  failAppend = false;
  aborted = false;
  widget: string[] | TodoWidgetFactory | undefined;
  private registeredCommand: RegisteredTodoCommand | undefined;
  private registeredTool: RegisteredTodoTool | undefined;

  constructor() {
    const api = {
      appendEntry: (customType: string, data: JsonValue) => {
        if (this.failAppend) throw new Error("disk full");
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
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The extension exercises only the recorded ExtensionAPI methods in this boundary harness.
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
      sessionManager: { getBranch: () => branch, getHeader: () => branch },
      abort: () => {
        this.aborted = true;
      },
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
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Tests provide every ExtensionCommandContext member read by the extension paths under test.
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
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Render tests exercise only the three Theme methods supplied above.
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
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The Todo Widget does not read the TUI object during rendering.
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

  test("every action returns schema-valid structured content for scripts", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    const outputSchema = harness.tool.outputSchema;
    if (outputSchema === undefined) throw new Error("todo declares no outputSchema");
    const run = async (params: TodoActionInput) => {
      const result = await harness.execute(params, context);
      expect(Value.Check(outputSchema, result.structuredContent)).toBe(true);
      expect(result.structuredContent).toEqual(result.details);
      expect(result.structuredContent).not.toBe(result.details);
      return result.structuredContent;
    };

    expect(await run({ action: "add", title: "First", description: "Details" })).toEqual({
      action: "add",
      task: { id: 1, title: "First", description: "Details", status: "pending" },
    });
    await run({ action: "add", title: "Second", status: "active" });
    expect(await run({ action: "update", id: 1, description: null, status: "completed" })).toEqual({
      action: "update",
      task: { id: 1, title: "First", status: "completed" },
    });
    expect(await run({ action: "list" })).toEqual({
      action: "list",
      tasks: [
        { id: 1, title: "First", status: "completed" },
        { id: 2, title: "Second", status: "active" },
      ],
    });
    expect(await run({ action: "remove", id: 2 })).toEqual({ action: "remove", id: 2 });
    expect(await run({ action: "clear" })).toEqual({ action: "clear", cleared: 1 });
    expect(await run({ action: "list" })).toEqual({ action: "list", tasks: [] });
    // Model-facing text is unchanged.
    expect(resultText(await harness.execute({ action: "add", title: "Again" }, context))).toBe(
      "Added Task #1",
    );
  });

  test("batch add creates every Task atomically with sequential IDs and one state entry", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    const outputSchema = harness.tool.outputSchema;
    if (outputSchema === undefined) throw new Error("todo declares no outputSchema");
    await harness.execute({ action: "add", title: "Existing" }, context);

    const added = await harness.execute(
      {
        action: "add",
        tasks: [
          { title: "  First  ", description: "  Details  " },
          { title: "Second" },
          { title: "Third" },
        ],
        status: "active",
      },
      context,
    );

    expect(resultText(added)).toBe(
      "Added 3 Tasks\n[>] #2 First\n    Details\n[>] #3 Second\n[>] #4 Third",
    );
    const batch = [
      { id: 2, title: "First", description: "Details", status: "active" },
      { id: 3, title: "Second", status: "active" },
      { id: 4, title: "Third", status: "active" },
    ];
    expect(added.details).toEqual({ action: "add", tasks: batch });
    expect(added.structuredContent).toEqual({ action: "add", tasks: batch });
    expect(Value.Check(outputSchema, added.structuredContent)).toBe(true);
    expect(harness.entries).toHaveLength(2);
    expect(harness.entries.at(-1)?.data).toEqual({
      nextId: 5,
      tasks: [{ id: 1, title: "Existing", status: "pending" }, ...batch],
    });
  });

  test("tool schema accepts batch add and the transcript labels it", async () => {
    const harness = new TodoExtensionHarness();
    const { parameters } = harness.tool;
    expect(
      Value.Check(parameters, { action: "add", tasks: [{ title: "A", description: "B" }] }),
    ).toBe(true);
    expect(Value.Check(parameters, { action: "add", tasks: [] })).toBe(false);
    expect(Value.Check(parameters, { action: "add", tasks: [{ description: "No title" }] })).toBe(
      false,
    );
    expect(Value.Check(parameters, { action: "add", tasks: ["A"] })).toBe(false);
    // A per-Task status is rejected rather than silently dropped.
    expect(
      Value.Check(parameters, { action: "add", tasks: [{ title: "A", status: "active" }] }),
    ).toBe(false);
    const batch = await harness.execute(
      {
        action: "add",
        tasks: [
          { title: "B1", description: "Only expanded." },
          ...[2, 3, 4, 5, 6].map((n) => ({ title: `B${n}` })),
        ],
      },
      harness.context(),
    );
    expect(batch.details).toMatchObject({ action: "add" });
  });

  test("batch add creates nothing when any Task is invalid", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    await harness.execute({ action: "add", title: "Existing" }, context);

    await expect(
      harness.execute(
        { action: "add", tasks: [{ title: "Valid" }, { title: "   " }, { title: "Also valid" }] },
        context,
      ),
    ).rejects.toThrow("Todo add failed: tasks[1].title must not be empty");
    await expect(
      harness.execute(
        { action: "add", tasks: [{ title: "Valid" }, { title: "Bad", description: " " }] },
        context,
      ),
    ).rejects.toThrow("Todo add failed: tasks[1].description must not be empty");
    await expect(harness.execute({ action: "add", tasks: [] }, context)).rejects.toThrow(
      "Todo add failed: tasks must not be empty",
    );

    expect(harness.entries).toHaveLength(1);
    expect(resultText(await harness.execute({ action: "list" }, context))).toBe("[ ] #1 Existing");
    expect(resultText(await harness.execute({ action: "add", title: "Next" }, context))).toBe(
      "Added Task #2",
    );
  });

  test("add rejects a request that combines tasks with title or description", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();

    await expect(
      harness.execute({ action: "add", title: "Single", tasks: [{ title: "Batch" }] }, context),
    ).rejects.toThrow("Todo add failed: provide either title or tasks, not both");
    await expect(
      harness.execute(
        { action: "add", description: "Loose", tasks: [{ title: "Batch" }] },
        context,
      ),
    ).rejects.toThrow("Todo add failed: provide either title or tasks, not both");
    expect(harness.entries).toHaveLength(0);

    // A null description means "absent", as it does for a single Task.
    expect(
      resultText(
        await harness.execute(
          { action: "add", description: null, tasks: [{ title: "Batch" }] },
          context,
        ),
      ),
    ).toBe("Added 1 Task\n[ ] #1 Batch");
  });

  test("batch add rejects exhausting the Task ID space without persisting", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context([
      {
        type: "custom",
        id: "limit",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "pi-todo-state",
        data: { nextId: Number.MAX_SAFE_INTEGER - 1, tasks: [] },
      },
    ]);
    await harness.emit("session_start", { type: "session_start", reason: "resume" }, context);
    await expect(
      harness.execute({ action: "add", tasks: [{ title: "Fits" }, { title: "Too far" }] }, context),
    ).rejects.toThrow("Task ID limit reached");
    expect(harness.entries).toHaveLength(0);
    expect(
      resultText(await harness.execute({ action: "add", tasks: [{ title: "Fits" }] }, context)),
    ).toBe("Added 1 Task\n[ ] #9007199254740990 Fits");
  });

  test("batch update changes several Tasks atomically with one state entry", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    const outputSchema = harness.tool.outputSchema;
    if (outputSchema === undefined) throw new Error("todo declares no outputSchema");
    await harness.execute(
      {
        action: "add",
        tasks: [{ title: "One", description: "Old" }, { title: "Two" }, { title: "Three" }],
      },
      context,
    );

    const updated = await harness.execute(
      {
        action: "update",
        updates: [
          { id: 2, status: "active" },
          { id: 1, status: "completed", title: "  Uno  ", description: null },
        ],
      },
      context,
    );

    expect(resultText(updated)).toBe("Updated 2 Tasks\n[>] #2 Two\n[x] #1 Uno");
    const changed = [
      { id: 2, title: "Two", status: "active" },
      { id: 1, title: "Uno", status: "completed" },
    ];
    expect(updated.details).toEqual({ action: "update", tasks: changed });
    expect(updated.structuredContent).toEqual({ action: "update", tasks: changed });
    expect(Value.Check(outputSchema, updated.structuredContent)).toBe(true);
    expect(harness.entries).toHaveLength(2);
    expect(harness.entries.at(-1)?.data).toEqual({
      nextId: 4,
      tasks: [
        { id: 1, title: "Uno", status: "completed" },
        { id: 2, title: "Two", status: "active" },
        { id: 3, title: "Three", status: "pending" },
      ],
    });
  });

  test("batch update rejects the whole call without changing any Task", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    await harness.execute({ action: "add", tasks: [{ title: "One" }, { title: "Two" }] }, context);
    const before = resultText(await harness.execute({ action: "list" }, context));

    const expectRejected = (updates: TodoTaskChange[], message: string) =>
      expect(harness.execute({ action: "update", updates }, context)).rejects.toThrow(message);
    await expectRejected(
      [
        { id: 1, status: "completed" },
        { id: 9, status: "active" },
      ],
      "Todo update failed: updates[1].id #9 was not found",
    );
    await expectRejected(
      [
        { id: 1, status: "completed" },
        { id: 2, title: "   " },
      ],
      "Todo update failed: updates[1].title must not be empty",
    );
    await expectRejected(
      [
        { id: 1, status: "completed" },
        { id: 2, description: " " },
      ],
      "Todo update failed: updates[1].description must not be empty",
    );
    await expectRejected(
      [{ id: 1, status: "completed" }, { id: 2 }],
      "Todo update failed: updates[1] must provide a title, description, or status",
    );
    await expectRejected(
      [
        { id: 1, status: "completed" },
        { id: 2, status: "active" },
        { id: 1, title: "Again" },
      ],
      "Todo update failed: updates[2].id #1 duplicates updates[0].id",
    );
    await expectRejected([], "Todo update failed: updates must not be empty");

    expect(harness.entries).toHaveLength(1);
    expect(resultText(await harness.execute({ action: "list" }, context))).toBe(before);
  });

  test("update rejects a request that combines updates with single-task fields", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    await harness.execute({ action: "add", title: "One" }, context);
    const updates = [{ id: 1, status: "active" as const }];

    for (const single of [
      { id: 1 },
      { title: "Loose" },
      { description: "Loose" },
      { status: "completed" as const },
    ]) {
      await expect(
        harness.execute({ action: "update", ...single, updates }, context),
      ).rejects.toThrow("Todo update failed: provide either id and fields or updates, not both");
    }
    expect(harness.entries).toHaveLength(1);
    // A null description means "absent", as it does for batch add.
    expect(
      resultText(await harness.execute({ action: "update", description: null, updates }, context)),
    ).toBe("Updated 1 Task\n[>] #1 One");
  });

  test("tool schema accepts batch update and the transcript labels it", async () => {
    const harness = new TodoExtensionHarness();
    const { parameters } = harness.tool;
    expect(
      Value.Check(parameters, {
        action: "update",
        updates: [{ id: 1, status: "active", title: "A", description: null }],
      }),
    ).toBe(true);
    expect(Value.Check(parameters, { action: "update", updates: [] })).toBe(false);
    expect(Value.Check(parameters, { action: "update", updates: [{ status: "active" }] })).toBe(
      false,
    );
    expect(Value.Check(parameters, { action: "update", updates: [{ id: 0 }] })).toBe(false);
    expect(Value.Check(parameters, { action: "update", updates: [{ id: 1, extra: 1 }] })).toBe(
      false,
    );
    const context = harness.context();
    await harness.execute(
      { action: "add", tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `T${n}` })) },
      context,
    );
    const batch = await harness.execute(
      {
        action: "update",
        updates: [1, 2, 3, 4, 5, 6].map((id) => ({ id, status: "completed" as const })),
      },
      context,
    );
    expect(batch.details).toMatchObject({ action: "update" });
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

  test("restores the latest valid branch snapshot at its immutable journal position", async () => {
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
            "Todo List state from the pi-todo extension (not a user message):\n[ ] #2 Pending work\n[>] #4 Current work\n    Keep the cache warm.\n    Then continue.",
          display: false,
          timestamp: Date.parse(validStateEntry.timestamp),
          details: { version: 1, stateEntryId: "state-1", checkpointId: null },
        },
      ],
    });
  });

  test("troubleshooting Skill exists and is hinted only on extension failures", async () => {
    expect(existsSync(TROUBLESHOOTING_SKILL_PATH)).toBe(true);
    const harness = new TodoExtensionHarness();
    const context = harness.context();
    await expect(harness.execute({ action: "remove", id: 99 }, context)).rejects.not.toThrow(
      TROUBLESHOOTING_HINT,
    );
    harness.failAppend = true;
    await expect(harness.execute({ action: "add", title: "Not saved" }, context)).rejects.toThrow(
      `disk full\n\n${TROUBLESHOOTING_HINT}`,
    );
  });

  test("canceled execution does not acknowledge or persist a mutation", async () => {
    const harness = new TodoExtensionHarness();
    await expect(
      harness.tool.execute(
        "canceled",
        { action: "add", title: "Not started" },
        AbortSignal.abort(),
        undefined,
        harness.context(),
      ),
    ).rejects.toThrow();
    expect(harness.entries).toEqual([]);
    expect(resultText(await harness.execute({ action: "list" }, harness.context()))).toBe(
      "Todo List is empty",
    );
  });

  test("failed writes preserve acknowledged widget state and quarantine restoration", async () => {
    const harness = new TodoExtensionHarness();
    const context = harness.context([], "tui");
    await harness.execute({ action: "add", title: "Acknowledged" }, context);
    const before = renderTodoWidget(harness, 80);
    harness.failAppend = true;
    await expect(harness.execute({ action: "add", title: "Not saved" }, context)).rejects.toThrow(
      "disk full",
    );
    expect(harness.entries).toHaveLength(1);
    expect(renderTodoWidget(harness, 80)).toEqual(before);
    expect(harness.aborted).toBe(true);
    await expect(
      harness.emit("session_start", { type: "session_start", reason: "reload" }, context),
    ).rejects.toThrow("Todo is disabled in this loaded session");
    await expect(
      harness.emit("context", { type: "context", messages: [] }, context),
    ).rejects.toThrow("Todo is disabled in this loaded session");
    await expect(harness.execute({ action: "list" }, context)).rejects.toThrow(
      "Todo is disabled in this loaded session",
    );
    await expect(harness.execute({ action: "list" }, context)).rejects.toThrow(
      TROUBLESHOOTING_HINT,
    );
    const reopened = new TodoExtensionHarness();
    const cleanContext = reopened.context();
    await reopened.emit("session_start", { type: "session_start", reason: "resume" }, cleanContext);
    expect(resultText(await reopened.execute({ action: "list" }, cleanContext))).toBe(
      "Todo List is empty",
    );
  });

  test("reports a non-interactive clear as a prefixed error", async () => {
    const harness = new TodoExtensionHarness();
    await harness.command.handler("clear", harness.context([], "print"));
    expect(harness.notifications).toEqual([
      { message: "Todo: /todo clear requires interactive mode", type: "error" },
    ]);
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
      "Todo 2 active · 2 pending · 2 com...",
      "[>] #1 Active one with a title th...",
      "[>] #4 Active two",
      "[ ] #2 Pending one",
      "[ ] #5 Pending two",
      "[x] #3 ~Completed one~",
      "[x] #6 ~Completed two~",
    ]);
    expect(renderTodoWidget(harness, 36).every((line) => visibleWidth(line) <= 36)).toBe(true);

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
