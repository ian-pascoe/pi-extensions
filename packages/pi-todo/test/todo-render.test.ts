import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import type { DurationContext } from "@ian-pascoe/pi-utils/ui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  applyTodoAction,
  createEmptyTodoState,
  type TodoStatus,
  type TodoTask,
  type TodoToolDetails,
} from "../src/todo-list.js";
import { renderTodoCall, renderTodoResult, renderTodoWidget } from "../src/todo-render.js";

beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

afterEach(() => vi.useRealTimers());

interface TaskSpec {
  title: string;
  status?: TodoStatus;
  description?: string;
}

function buildTasks(specs: readonly TaskSpec[]): TodoTask[] {
  let state = createEmptyTodoState();
  for (const spec of specs) {
    const result = applyTodoAction(state, { action: "add", ...spec });
    if (!result.ok) throw result.error;
    state = result.state;
  }
  return [...state.tasks];
}

/** Render at a real width, check the lines fit and carry no hard-coded colour, and decode them. */
function renderLines(component: { render(width: number): string[] }, width = 120): string[] {
  for (const fitWidth of [40, width]) expectLinesFitWidth(component.render(fitWidth), fitWidth);
  return component.render(width).map((line) => readableTags(line).trimEnd());
}

function failTest(message: string): never {
  throw new Error(message);
}

function tasks(count: number, status: TodoStatus = "pending"): TodoTask[] {
  return buildTasks(
    Array.from({ length: count }, (_, index) => ({
      title: `Task ${index + 1}`,
      status,
    })),
  );
}

function durationContext(overrides: Partial<DurationContext> = {}): DurationContext {
  return {
    state: {},
    executionStarted: true,
    isPartial: false,
    durationMs: 1500,
    invalidate: () => undefined,
    ...overrides,
  };
}

function textResult(text: string, details: TodoToolDetails | undefined) {
  return { content: [{ type: "text" as const, text }], details };
}

function renderResult(
  details: TodoToolDetails | undefined,
  options: {
    expanded?: boolean;
    isPartial?: boolean;
    text?: string;
    durationMs?: number | undefined;
  } = {},
): string[] {
  const component = renderTodoResult(
    textResult(options.text ?? "ignored", details),
    { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
    escapeTaggedTheme,
    durationContext({
      durationMs: options.isPartial ? undefined : (options.durationMs ?? 1500),
      isPartial: options.isPartial ?? false,
    }),
  );
  return renderLines(component);
}

describe("todo call row", () => {
  test("leads with the bold todo name, the action in accent, and arguments in muted", () => {
    const lines = renderLines(
      renderTodoCall(
        { action: "update", id: 4, status: "completed" },
        escapeTaggedTheme,
        durationContext({ executionStarted: false }),
      ),
    );
    expect(lines).toEqual([
      "<toolTitle><b>todo</b></toolTitle> <accent>update</accent> <muted>#4</muted>",
    ]);
  });

  test("summarises batches and titles after the action", () => {
    const render = (params: Parameters<typeof renderTodoCall>[0]) =>
      renderLines(
        renderTodoCall(params, escapeTaggedTheme, durationContext({ executionStarted: false })),
      );
    expect(render({ action: "add", tasks: [{ title: "A" }, { title: "B" }] })).toEqual([
      "<toolTitle><b>todo</b></toolTitle> <accent>add</accent> <muted>2 Tasks</muted>",
    ]);
    expect(render({ action: "add", title: "Write docs" })).toEqual([
      '<toolTitle><b>todo</b></toolTitle> <accent>add</accent> <muted>"Write docs"</muted>',
    ]);
    expect(render({ action: "list" })).toEqual([
      "<toolTitle><b>todo</b></toolTitle> <accent>list</accent>",
    ]);
  });

  test("shows a live Elapsed footer under the header while the call runs, and fits narrow widths", () => {
    vi.useFakeTimers({ now: 0 });
    const component = renderTodoCall(
      { action: "add", title: "A title that is much longer than a forty column terminal" },
      escapeTaggedTheme,
      durationContext({ isPartial: true, durationMs: undefined }),
    );
    vi.advanceTimersByTime(2000);
    expect(renderLines(component).at(-1)).toBe("<muted>Elapsed 2.0s</muted>");
  });
});

describe("todo result row", () => {
  test("collapses a long Task list to ls's 20 rows with Pi's Expand Hint and a Took footer", () => {
    const lines = renderResult({ action: "list", tasks: tasks(23) });
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("<muted>23 Tasks:</muted>");
    expect(lines[2]).toContain("<dim>[</dim><muted> </muted><dim>]</dim> <accent>#1</accent>");
    expect(lines[21]).toContain("<accent>#20</accent>");
    expect(lines[22]).toBe(
      "<muted>... (3 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
    expect(lines.at(-1)).toBe("<muted>Took 1.5s</muted>");
    expect(lines.join("\n")).not.toContain("#21");
  });

  test("shows every Task and its description, with no hint, when expanded", () => {
    const list = buildTasks([
      { title: "Documented", description: "First line\nSecond line" },
      ...Array.from({ length: 20 }, (_, index) => ({ title: `Filler ${index}` })),
    ]);
    const lines = renderResult({ action: "list", tasks: list }, { expanded: true });
    const text = lines.join("\n");
    expect(text).toContain("<accent>#21</accent>");
    expect(lines).toContain("<dim>    First line</dim>");
    expect(lines).toContain("<dim>    Second line</dim>");
    expect(text).not.toContain("to expand");
  });

  test("keeps checkboxes with dim brackets, state colours, and struck-through done titles", () => {
    const lines = renderResult({
      action: "list",
      tasks: buildTasks([
        { title: "Pending" },
        { title: "Active", status: "active" },
        { title: "Done", status: "completed" },
      ]),
    });
    expect(lines).toContain(
      "<dim>[</dim><muted> </muted><dim>]</dim> <accent>#1</accent> <text>Pending</text>",
    );
    expect(lines).toContain(
      "<dim>[</dim><accent>></accent><dim>]</dim> <accent>#2</accent> <text><b>Active</b></text>",
    );
    expect(lines).toContain(
      "<dim>[</dim><success>x</success><dim>]</dim> <accent>#3</accent> <dim><s>Done</s></dim>",
    );
  });

  test("labels batch mutations with the verb", () => {
    expect(renderResult({ action: "add", tasks: tasks(2) })[1]).toBe(
      "<muted>Added 2 Tasks:</muted>",
    );
    expect(renderResult({ action: "update", tasks: tasks(2) })[1]).toBe(
      "<muted>Updated 2 Tasks:</muted>",
    );
  });

  test("shows single-Task results as plain tool output without a status glyph", () => {
    const lines = renderResult(
      { action: "add", task: tasks(1)[0] ?? failTest("no Task built") },
      { text: "Added Task #1" },
    );
    expect(lines).toContain("<toolOutput>Added Task #1</toolOutput>");
    expect(lines.join("\n")).not.toMatch(/[✓✗]/u);
  });

  test("reports an empty list", () => {
    expect(renderResult({ action: "list", tasks: [] })).toContain(
      "<toolOutput>Todo List is empty</toolOutput>",
    );
  });

  test("shows failures in the error colour and still ends with the duration", () => {
    const lines = renderResult(undefined, {
      text: "Todo update failed: Task #99 was not found",
      durationMs: 800,
    });
    expect(lines).toContain("<error>Todo update failed: Task #99 was not found</error>");
    expect(lines.at(-1)).toBe("<muted>Took 0.8s</muted>");
  });

  test("shows a partial result's Elapsed footer", () => {
    vi.useFakeTimers({ now: 0 });
    const lines = renderResult(
      { action: "list", tasks: tasks(1) },
      { isPartial: true, durationMs: undefined },
    );
    expect(lines.at(-1)).toBe("<muted>Elapsed 0.0s</muted>");
  });
});

describe("todo widget", () => {
  test("leads with a bold Todo title and muted counts, Active Tasks first", () => {
    const list = buildTasks([
      { title: "Later" },
      { title: "Now", status: "active" },
      { title: "Over", status: "completed" },
    ]);
    const lines = renderTodoWidget(list, escapeTaggedTheme, 120).map(readableTags);
    expect(lines[0]).toBe(
      "<toolTitle><b>Todo</b></toolTitle> <muted>1 active · 1 pending · 1 completed</muted>",
    );
    expect(lines[1]).toContain("<accent>#2</accent>");
    expect(lines[2]).toContain("<accent>#1</accent>");
    expect(lines[3]).toContain("<accent>#3</accent>");
  });

  test("stays within ten lines with a '... N more' line and fits real widths", () => {
    const list = buildTasks(
      Array.from({ length: 14 }, (_, index) => ({
        title: `Task ${index + 1} has a title long enough to need truncating on a narrow terminal`,
      })),
    );
    for (const width of [40, 120]) {
      const lines = renderTodoWidget(list, escapeTaggedTheme, width);
      expect(lines).toHaveLength(10);
      expect(readableTags(lines.at(-1) ?? "")).toBe("<muted>... 6 more</muted>");
      expectLinesFitWidth(lines, width);
    }
  });
});
