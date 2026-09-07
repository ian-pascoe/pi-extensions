import {
  initTheme,
  type AgentToolResult,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { beforeAll, expect, test } from "vitest";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness } from "./sdk-harness.js";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

beforeAll(() => initTheme("dark"));

// SAFETY: The registered renderers consume only Theme.bold and Theme.fg; Markdown uses Pi's initialized theme.
const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text } as Theme;

async function registeredTool(name: string) {
  const harness = await createSdkHarness([contextManagement]);
  const tool = harness.session.getToolDefinition(name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return {
    tool,
    session: harness.session,
    context: harness.session.extensionRunner.createContext(),
  };
}

function renderText(component: Component, width = 120): string {
  return component
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

function renderContext(args: RenderContext["args"], expanded = false): RenderContext {
  return {
    args,
    expanded,
    toolCallId: "context-render-test",
    state: {},
    cwd: "/workspace",
    invalidate: () => undefined,
    lastComponent: undefined,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    showImages: false,
    isError: false,
  };
}

function present(
  tool: ToolDefinition,
  result: AgentToolResult<unknown>,
  context: RenderContext,
  width = 120,
) {
  if (!tool.renderCall || !tool.renderResult) throw new Error(`Missing renderers: ${tool.name}`);
  return [
    renderText(tool.renderCall(context.args, theme, context), width),
    renderText(tool.renderResult(result, context, theme, context), width),
  ]
    .filter(Boolean)
    .join("\n");
}

test("Notes reads expand Markdown and preserve reference and UTF-16 pagination metadata", async () => {
  const { tool, context } = await registeredTool("context_notes");
  await tool.execute(
    "write",
    { action: "write", name: "plan", content: "# Decisions\n\nUse native tools.\n" },
    undefined,
    undefined,
    context,
  );
  const args = { action: "read", name: "plan", limit: 20 };
  const result = await tool.execute("read", args, undefined, undefined, context);
  const collapsed = present(tool, result, renderContext(args));
  expect(collapsed).toContain("Notes · read “plan” · 20 UTF-16 units · more");
  expect(collapsed).not.toContain("Decisions");
  const expanded = present(tool, result, renderContext(args, true));
  expect(expanded).toContain("Decisions");
  expect(expanded).not.toContain("# Decisions");
  expect(expanded).toContain("Reference: context:");
  expect(expanded).toContain("Range: 0–20 of 31 UTF-16 units");
  expect(expanded).toContain("Next offset: 20");
  expect(expanded).not.toContain('"totalCharacters":');
});

test("Notes lists show page counts and expandable named rows, including empty lists", async () => {
  const { tool, context } = await registeredTool("context_notes");
  const args = { action: "list", limit: 1 };
  const empty = await tool.execute("list", args, undefined, undefined, context);
  expect(present(tool, empty, renderContext(args))).toContain("Notes · list · 0 of 0 Notes");
  for (const name of ["alpha", "beta"])
    await tool.execute(
      "write",
      { action: "write", name, content: "Hello" },
      undefined,
      undefined,
      context,
    );
  const page = await tool.execute("list", args, undefined, undefined, context);
  expect(present(tool, page, renderContext(args))).toContain("Notes · list · 1 of 2 Notes · more");
  const expanded = present(tool, page, renderContext(args, true));
  expect(expanded).toContain("alpha · 5 UTF-16 units");
  expect(expanded).toContain("Updated:");
  expect(expanded).toContain("Reference: context:");
  expect(expanded).toContain("Next offset: 1");
  expect(expanded).not.toContain("beta");
});

test.each(["context_notes", "context_history"])(
  "%s search shows literal matches, references, offsets, and continuation",
  async (name) => {
    const { tool, session, context } = await registeredTool(name);
    const notes = session.getToolDefinition("context_notes");
    if (!notes) throw new Error("Missing Notes");
    await notes.execute(
      "write",
      { action: "write", name: "clues", content: "Needle and Needle" },
      undefined,
      undefined,
      context,
    );
    const args = { action: "search", query: "Needle", limit: 1 };
    const result = await tool.execute("search", args, undefined, undefined, context);
    const collapsed = present(tool, result, renderContext(args));
    expect(collapsed).toContain("search “Needle” · 1 match · more");
    expect(collapsed).not.toContain("context:");
    const expanded = present(tool, result, renderContext(args, true));
    expect(expanded).toContain("Needle and Needle");
    expect(expanded).toContain("Reference: context:");
    expect(expanded).toContain("Offset:");
    expect(expanded).toContain("Next offset: 1");
    const missingArgs = { action: "search", query: "no-match" };
    const empty = await tool.execute("empty", missingArgs, undefined, undefined, context);
    expect(present(tool, empty, renderContext(missingArgs))).toContain("0 matches");
  },
);

test("History pages expand readable Context Window and recorded-entry rows", async () => {
  const { tool } = await registeredTool("context_history");
  const ref = "context:source-session:entry-a";
  for (const [action, details, heading, row] of [
    [
      "windows",
      { windows: [{ ref, items: 7 }], total: 2, nextOffset: 1 },
      "1 of 2 Context Windows",
      "7 entries",
    ],
    [
      "list",
      {
        items: [
          { ref, type: "message", timestamp: "2026-09-07T10:00:00Z", preview: '"role":"user"' },
        ],
        total: 7,
        nextOffset: 1,
      },
      "1 of 7 entries",
      "message · 2026-09-07T10:00:00Z",
    ],
  ] as const) {
    const result = { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    const args = { action, window: "context:source-session:window-a" };
    const collapsed = present(tool, result, renderContext(args));
    expect(collapsed).toContain(
      `History · ${action}${action === "list" ? " · window-a" : ""} · ${heading} · more`,
    );
    expect(collapsed).not.toContain(ref);
    if (action === "list") expect(collapsed).toContain("window-a");
    const expanded = present(tool, result, renderContext(args, true));
    expect(expanded).toContain(row);
    expect(expanded).toContain(`Reference: ${ref}`);
    expect(expanded).toContain("Next offset: 1");
  }
});

test("History reads preserve exact serialized fragments rather than interpreting Markdown or JSON", async () => {
  const { tool } = await registeredTool("context_history");
  const args = { action: "read", ref: "context:source-session:entry-a", offset: 8 };
  const content = '"text":"# Heading\\n**literal**","unfinished';
  const details = {
    ref: args.ref,
    resolvedInSession: "fork-session",
    format: "recorded-entry-json",
    content,
    offset: 8,
    totalCharacters: 200,
    nextOffset: 51,
    availability: "External spill originals are not read or verified.",
  };
  const result = { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
  const collapsed = present(tool, result, renderContext(args));
  expect(collapsed).toContain("History · read entry-a");
  expect(collapsed).not.toContain(content);
  const expanded = present(tool, result, renderContext(args, true));
  expect(expanded).toContain(content);
  expect(expanded).toContain(`Reference: ${args.ref}`);
  expect(expanded).toContain("Resolved in session: fork-session");
  expect(expanded).toContain("Format: recorded-entry-json");
  expect(expanded).toContain("Next offset: 51");
  expect(expanded).toContain(details.availability);
});

test("Rollover acknowledges a request, not a completed checkpoint, and expands the Handoff", async () => {
  const { tool } = await registeredTool("context_rollover");
  const args = { handoff: "# Continue\n\nFinish the renderer." };
  const result = {
    content: [
      {
        type: "text" as const,
        text: "Handoff saved. Rollover requested; commit follows the complete tool batch.",
      },
    ],
    details: { requested: true },
  };
  const collapsed = present(tool, result, renderContext(args));
  expect(collapsed).toContain("Rollover · requested · Handoff saved");
  expect(collapsed).not.toContain("completed");
  expect(collapsed).toContain("Finish the renderer");
  const expanded = present(tool, result, renderContext(args, true));
  expect(expanded).toContain("commit follows the complete tool batch");
  expect(expanded).toContain("Continue");
  expect(expanded).toContain("Finish the renderer.");
  expect(expanded).not.toContain("# Continue");
});

test.each(["context_notes", "context_history", "context_rollover"])(
  "%s distinguishes incomplete, running, and failed output",
  async (name) => {
    const { tool } = await registeredTool(name);
    const pending = {
      ...renderContext({}),
      argsComplete: false,
      executionStarted: false,
      isPartial: true,
    };
    const empty = { content: [], details: undefined };
    expect(present(tool, empty, pending)).toContain("preparing…");
    const running = {
      ...pending,
      args: { action: "read", name: "plan" },
      argsComplete: true,
      executionStarted: true,
    };
    const progress = present(tool, empty, running);
    expect(progress).toContain("running…");
    expect(progress.split("\n")).toHaveLength(1);
    const failure = {
      content: [
        {
          type: "text" as const,
          text: "Reference unavailable\nBrowse the selected branch for a fresh reference.",
        },
      ],
      details: undefined,
    };
    const failed = {
      ...renderContext({ action: "read", ref: "context:source:entry-a" }),
      isError: true,
    };
    expect(present(tool, failure, failed)).toContain("failed · Reference unavailable");
    expect(present(tool, failure, { ...failed, expanded: true })).toContain(
      "Browse the selected branch for a fresh reference.",
    );
    expect(present(tool, empty, renderContext({}))).toContain("result details unavailable");
    const hostileArgs = { action: "\u001b[2Jread", ref: "context:source:entry-a" };
    const pendingCall = tool.renderCall?.(hostileArgs, theme, { ...pending, args: hostileArgs });
    expect(pendingCall?.render(120).join("\n")).not.toContain("\u001b[2J");
    for (const expanded of [false, true]) {
      const context = { ...failed, args: hostileArgs, expanded };
      const failureResult = tool.renderResult?.(failure, context, theme, context);
      expect(failureResult?.render(120).join("\n")).not.toContain("\u001b[2J");
    }
  },
);

test.each([
  ["context_notes", "write"],
  ["context_notes", "append"],
  ["context_rollover", undefined],
] as const)("%s %s streams a bounded preview and expands the full text", async (name, action) => {
  const { tool } = await registeredTool(name);
  const text = Array.from(
    { length: 20 },
    (_, index) => `Line ${index + 1}: 界😀 native context`,
  ).join("\n");
  const args = action ? { action, name: "plan", content: text } : { handoff: text };
  const original = structuredClone(args);
  const pending = {
    ...renderContext(args),
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
  };
  const empty = { content: [], details: undefined };
  const firstArgs = action ? { ...args, content: "First fragment" } : { handoff: "First fragment" };
  expect(present(tool, empty, { ...pending, args: firstArgs })).toContain("First fragment");
  const finalResult = {
    content: [],
    details: action ? { action, name: "plan", saved: true } : { requested: true },
  };
  for (const executionStarted of [false, true]) {
    const output = present(tool, empty, { ...pending, executionStarted });
    expect(output).toContain("Line 20:");
    expect(output).not.toContain("Line 1:");
    expect(output).not.toContain("preparing…");
    expect(output).not.toContain("Handoff saved");
    expect(output).toContain("…");
  }
  const expanded = present(tool, empty, { ...pending, expanded: true });
  expect(expanded).toContain("Line 1:");
  expect(expanded).toContain("Line 20:");
  expect(expanded.split("\n").length).toBeGreaterThan(8);
  for (const width of [12, 40, 120]) {
    for (const [result, context] of [
      [empty, pending],
      [finalResult, renderContext(args)],
    ] as const) {
      const output = present(tool, result, context, width);
      expect(output.split("\n").length).toBeLessThanOrEqual(8);
      expect(output.split("\n").every((row) => visibleWidth(row) <= width)).toBe(true);
    }
  }
  const hostileArgs = action
    ? { ...args, content: "Safe\u001b[2J text" }
    : { handoff: "Safe\u001b[2J text" };
  const component = tool.renderCall?.(hostileArgs, theme, { ...pending, args: hostileArgs });
  expect(component?.render(120).join("\n")).not.toContain("\u001b[2J");
  expect(args).toEqual(original);
});

test("Expanded Notes edits show Markdown input, while scoped searches retain their controls", async () => {
  const { tool, context } = await registeredTool("context_notes");
  const args = { action: "write", name: "plan", content: "# Decision\n\n**Native** tools." };
  const result = await tool.execute("write", args, undefined, undefined, context);
  const expanded = present(tool, result, renderContext(args, true));
  expect(expanded).toContain("Decision");
  expect(expanded).toContain("Native tools.");
  expect(expanded).not.toContain("**Native**");
  const searchArgs = { action: "search", name: "plan", query: "Native", offset: 0, limit: 1 };
  const search = await tool.execute("search", searchArgs, undefined, undefined, context);
  const page = present(tool, search, renderContext(searchArgs, true));
  expect(page).toContain("Note: plan");
  expect(page).toContain("Query: Native");
  expect(page).toContain("Offset: 0");
  expect(page).toContain("Limit: 1");
});

test("Collapsed History searches identify their selected Context Window", async () => {
  const { tool } = await registeredTool("context_history");
  const result = { content: [], details: { matches: [], nextOffset: null } };
  for (const window of ["window-a", "window-b"]) {
    const args = { action: "search", query: "checkpoint", window: `context:source:${window}` };
    const collapsed = present(tool, result, renderContext(args));
    expect(collapsed).toContain(window);
    expect(collapsed).toContain("0 matches");
    expect(collapsed).not.toContain("context:source:");
  }
});

test("Long multiline queries stay compact and terminal-safe without changing result data", async () => {
  const { tool } = await registeredTool("context_history");
  const query = `界😀${"long query ".repeat(30)}\nsecond line\u001b[2J`;
  const args = { action: "search", query };
  const details = {
    matches: [{ ref: "context:source:entry-a", offset: 8, preview: "literal\u001b[2Jcontent" }],
    nextOffset: null,
  };
  const result = { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
  const original = structuredClone(result);
  expect(present(tool, result, renderContext(args), 80)).toContain("1 match");
  for (const width of [12, 40, 80]) {
    for (const expanded of [false, true]) {
      const context = renderContext(args, expanded);
      const component = tool.renderResult?.(result, context, theme, context);
      if (!component) throw new Error("Missing result renderer");
      const rows = component.render(width);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(rows.join("\n")).not.toContain("\u001b[2J");
      if (!expanded) expect(rows).toHaveLength(1);
    }
  }
  expect(result).toEqual(original);
});

test("Notes mutations show one compact action, target, and acknowledged outcome", async () => {
  const { tool, context } = await registeredTool("context_notes");
  for (const [action, outcome] of [
    ["write", "saved"],
    ["append", "appended"],
    ["delete", "deleted"],
  ]) {
    const args = { action, name: "handoff", content: "Private working content" };
    const result = await tool.execute("note-edit", args, undefined, undefined, context);
    const output = present(tool, result, renderContext(args));
    expect(output).toContain(`Notes · ${outcome} “handoff”`);
    if (action === "delete") expect(output).not.toContain("Private working content");
    else expect(output).toContain("Private working content");
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ action, name: "handoff", saved: true }),
    });
  }
});
