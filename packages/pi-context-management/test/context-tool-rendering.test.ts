import { toToolContext } from "./tool-context.js";
import {
  initTheme,
  type AgentToolResult,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, type Component } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "@ian-pascoe/pi-utils/ui-testing";
import { beforeAll, expect, test } from "vitest";
import { expectClickToggles } from "@ian-pascoe/pi-utils/ui-testing";
import contextManagement from "../src/context-management-extension.js";
import type { ContextToolDetails } from "../src/context-tool-rendering.js";
import { createSdkHarness } from "./sdk-harness.js";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

beforeAll(() => {
  initTheme("dark");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

// SAFETY: The renderers consume only fg, bg, and bold, which the escape-tagged test theme implements.
const theme = escapeTaggedTheme as Theme;

async function registeredTool(name: string) {
  const harness = await createSdkHarness([contextManagement]);
  const tool = harness.session.getToolDefinition(name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return {
    tool,
    session: harness.session,
    context: toToolContext(harness.session.extensionRunner.createContext()),
  };
}

function renderContext(
  args: RenderContext["args"],
  overrides: Partial<RenderContext> = {},
): RenderContext {
  return {
    args,
    expanded: false,
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
    durationMs: 1200,
    outputPad: 0,
    ...overrides,
  };
}

/** Render a component at 40 and 120 columns, proving both fit, and return the wide lines. */
function lines(component: Component): string[] {
  expectLinesFitWidth(component.render(40), 40);
  const wide = component.render(120);
  expectLinesFitWidth(wide, 120);
  // Pi's Text pads each row to the full width.
  return wide.map((line) => readableTags(line).trimEnd());
}

function call(tool: ToolDefinition, context: RenderContext): string[] {
  if (!tool.renderCall) throw new Error(`Missing call renderer: ${tool.name}`);
  return lines(tool.renderCall(context.args, theme, context));
}

function result(
  tool: ToolDefinition,
  value: AgentToolResult<unknown>,
  context: RenderContext,
  isPartial = false,
): string[] {
  if (!tool.renderResult) throw new Error(`Missing result renderer: ${tool.name}`);
  return lines(tool.renderResult(value, { expanded: context.expanded, isPartial }, theme, context));
}

function withDetails(details: ContextToolDetails): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

const TOOK = "<muted>Took 1.2s</muted>";
const textOf = (rendered: string[]) => rendered.join("\n");

test("call rows lead with the lowercase registered name, then action and target, and stay after completion", async () => {
  const { tool } = await registeredTool("context_notes");
  const args = { action: "read", name: "plan", window: "context:source:window-a" };
  expect(call(tool, renderContext(args))[0]).toBe(
    "<toolTitle><b>context_notes</b></toolTitle> <accent>read</accent> <muted>“plan” · window-a</muted>",
  );
  const history = await registeredTool("context_history");
  expect(call(history.tool, renderContext({ action: "read", ref: "context:s:entry-a" }))[0]).toBe(
    "<toolTitle><b>context_history</b></toolTitle> <accent>read</accent> <muted>entry-a</muted>",
  );
  const rollover = await registeredTool("context_rollover");
  expect(call(rollover.tool, renderContext({}))[0]).toBe(
    "<toolTitle><b>context_rollover</b></toolTitle>",
  );
});

test("a running call shows the live Elapsed footer and no placeholder text", async () => {
  const { tool } = await registeredTool("context_history");
  const running = renderContext(
    { action: "list" },
    { isPartial: true, durationMs: undefined, executionStarted: true },
  );
  const rendered = call(tool, running);
  expect(rendered[0]).toContain("context_history");
  expect(rendered.at(-1)).toMatch(/^<muted>Elapsed \d+\.\ds<\/muted>$/);
  expect(textOf(rendered)).not.toMatch(/…|preparing|running|streaming/);
});

test("Notes reads show the header only when collapsed and the content with metadata when expanded", async () => {
  const { tool, context } = await registeredTool("context_notes");
  await tool.execute(
    "write",
    { action: "write", name: "plan", content: "# Decisions\n\nUse native tools.\n" },
    undefined,
    undefined,
    context,
  );
  const args = { action: "read", name: "plan", limit: 20 };
  const read = await tool.execute("read", args, undefined, undefined, context);
  expect(result(tool, read, renderContext(args))).toEqual(["", TOOK]);
  const expanded = result(tool, read, renderContext(args, { expanded: true }));
  expect(textOf(expanded)).toContain("<toolOutput># Decisions</toolOutput>");
  expect(textOf(expanded)).toContain("<toolOutput>Use nat</toolOutput>");
  expect(textOf(expanded)).toContain("<muted>Reference: context:");
  expect(textOf(expanded)).toContain("<muted>Range: 0–20 of 31 UTF-16 units</muted>");
  expect(textOf(expanded)).toContain("<muted>Next offset: 20</muted>");
  expect(textOf(expanded)).not.toContain("expand");
  expect(expanded.at(-1)).toBe(TOOK);
  expect(call(tool, renderContext(args, { expanded: true })).slice(1, 4)).toEqual([
    "<muted>action: read</muted>",
    "<muted>name: plan</muted>",
    "<muted>limit: 20</muted>",
  ]);
});

test("History reads keep exact serialized fragments and expand to metadata and content", async () => {
  const { tool } = await registeredTool("context_history");
  const args = { action: "read", ref: "context:source-session:entry-a", offset: 8 };
  const content = '"text":"# Heading\\n**literal**","unfinished';
  const read = withDetails({
    ref: args.ref,
    resolvedInSession: "fork-session",
    format: "recorded-entry-json",
    content,
    offset: 8,
    totalCharacters: 200,
    nextOffset: 51,
    availability: "External spill originals are not read or verified.",
  });
  expect(result(tool, read, renderContext(args))).toEqual(["", TOOK]);
  const expanded = textOf(result(tool, read, renderContext(args, { expanded: true })));
  expect(expanded).toContain(`<toolOutput>${content}</toolOutput>`);
  expect(expanded).toContain("<muted>Resolved in session: fork-session</muted>");
  expect(expanded).toContain("<muted>Format: recorded-entry-json</muted>");
  expect(expanded).toContain("<muted>Next offset: 51</muted>");
  expect(expanded).toContain("<muted>Availability: External spill originals");
});

test("Notes lists copy ls: 20 names, an Expand Hint, and a continuation line", async () => {
  const { tool } = await registeredTool("context_notes");
  const notes = Array.from({ length: 25 }, (_, index) => ({
    name: `note-${index + 1}`,
    ref: `context:s:note-${index + 1}`,
    updatedAt: "2026-09-07T10:00:00Z",
    characters: 5,
  }));
  const list = withDetails({ notes, total: 40, nextOffset: 25 });
  const args = { action: "list", limit: 25 };
  const collapsed = result(tool, list, renderContext(args));
  expect(collapsed.slice(0, 20)).toEqual(
    notes.slice(0, 20).map((note) => `<toolOutput>${note.name}</toolOutput>`),
  );
  expect(collapsed[20]).toBe(
    "<muted>... (5 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
  );
  expect(collapsed[21]).toBe("<muted>25 of 40 · next offset 25</muted>");
  expect(collapsed.at(-1)).toBe(TOOK);
  const expanded = textOf(result(tool, list, renderContext(args, { expanded: true })));
  expect(expanded).toContain("<toolOutput>note-25 · 5 UTF-16 units</toolOutput>");
  expect(expanded).toContain("<muted>Updated: 2026-09-07T10:00:00Z</muted>");
  expect(expanded).not.toContain("to expand");
  const empty = result(
    tool,
    withDetails({ notes: [], total: 0, nextOffset: null }),
    renderContext(args),
  );
  expect(empty).toEqual(["<muted>No Notes</muted>", "", TOOK]);
});

test("History pages show 10 rows collapsed and readable detail when expanded", async () => {
  const { tool } = await registeredTool("context_history");
  const ref = (index: number) => `context:source-session:entry-${index}`;
  const items = Array.from({ length: 12 }, (_, index) => ({
    ref: ref(index),
    type: "message",
    timestamp: "2026-09-07T10:00:00Z",
    preview: `user: hello ${index}`,
  }));
  const args = { action: "list", window: "context:source-session:window-a", role: "user" };
  const page = withDetails({ items, total: 12, nextOffset: null });
  const collapsed = result(tool, page, renderContext(args));
  expect(collapsed[0]).toBe("<toolOutput>entry-0 · message · user: hello 0</toolOutput>");
  expect(collapsed).toHaveLength(13);
  expect(collapsed[10]).toContain("<muted>... (2 more lines,</muted>");
  const expanded = textOf(result(tool, page, renderContext(args, { expanded: true })));
  expect(expanded).toContain("<toolOutput>message · 2026-09-07T10:00:00Z</toolOutput>");
  expect(expanded).toContain(`<muted>Reference: ${ref(11)}</muted>`);
  expect(expanded).toContain("<muted>Next offset: none</muted>");
  expect(expanded).not.toContain("to expand");
  const windows = withDetails({
    windows: [{ ref: ref(1), items: 7 }],
    total: 2,
    nextOffset: 1,
  });
  expect(result(tool, windows, renderContext({ action: "windows" }))).toEqual([
    "<toolOutput>entry-1 · 7 entries</toolOutput>",
    "<muted>1 of 2 · next offset 1</muted>",
    "",
    TOOK,
  ]);
});

test.each(["context_notes", "context_history"])(
  "%s search lists matches and expands references and offsets",
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
    const found = await tool.execute("search", args, undefined, undefined, context);
    const collapsed = textOf(result(tool, found, renderContext(args)));
    expect(collapsed).toContain("Needle and Needle");
    expect(collapsed).toContain("<muted>next offset 1</muted>");
    expect(collapsed).not.toContain("context:");
    const expanded = textOf(result(tool, found, renderContext(args, { expanded: true })));
    expect(expanded).toContain("<muted>Reference: context:");
    expect(expanded).toContain("<muted>Offset:");
    expect(expanded).toContain("<muted>Next offset: 1</muted>");
    const none = await tool.execute(
      "empty",
      { action: "search", query: "no-match" },
      undefined,
      undefined,
      context,
    );
    expect(result(tool, none, renderContext({ action: "search", query: "no-match" }))).toEqual([
      "<muted>No matches</muted>",
      "",
      TOOK,
    ]);
  },
);

test("Collapsed History searches identify their Context Window in the call header", async () => {
  const { tool } = await registeredTool("context_history");
  for (const window of ["window-a", "window-b"]) {
    const args = { action: "search", query: "checkpoint", window: `context:source:${window}` };
    const header = call(tool, renderContext(args))[0];
    expect(header).toContain(window);
    expect(header).not.toContain("context:source:");
  }
});

test("Notes mutations keep the content in the call row and add only the footer to the result", async () => {
  const { tool, context } = await registeredTool("context_notes");
  for (const action of ["write", "append", "delete"]) {
    const args = { action, name: "handoff", content: "Private working content" };
    const done = await tool.execute("note-edit", args, undefined, undefined, context);
    const row = textOf(call(tool, renderContext(args)));
    expect(row).toContain(`<accent>${action}</accent> <muted>“handoff”</muted>`);
    if (action === "delete") expect(row).not.toContain("Private working content");
    else expect(row).toContain("<toolOutput>Private working content</toolOutput>");
    expect(result(tool, done, renderContext(args))).toEqual(["", TOOK]);
    expect(done.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ action, name: "handoff", saved: true }),
    });
  }
});

test("Rollover shows its Handoff in the call row and only the footer for the request", async () => {
  const { tool } = await registeredTool("context_rollover");
  const args = { handoff: "# Continue\n\nFinish the renderer." };
  const requested = {
    content: [
      {
        type: "text" as const,
        text: "Handoff saved. Rollover requested; commit follows the complete tool batch.",
      },
    ],
    details: { requested: true },
  };
  const row = textOf(call(tool, renderContext(args)));
  expect(row).toContain("<toolOutput>Finish the renderer.</toolOutput>");
  expect(result(tool, requested, renderContext(args))).toEqual(["", TOOK]);
});

test.each([
  ["context_notes", "write"],
  ["context_notes", "append"],
  ["context_rollover", undefined],
] as const)(
  "%s %s keeps the head of long text collapsed and shows all of it expanded",
  async (name, action) => {
    const { tool } = await registeredTool(name);
    const text = Array.from(
      { length: 20 },
      (_, index) => `Line ${index + 1}: 界😀 native context`,
    ).join("\n");
    const args = action ? { action, name: "plan", content: text } : { handoff: text };
    const original = structuredClone(args);
    const streaming = renderContext(args, {
      argsComplete: false,
      executionStarted: false,
      isPartial: true,
      durationMs: undefined,
    });
    const collapsed = textOf(call(tool, streaming));
    expect(collapsed).toContain("Line 1:");
    expect(collapsed).toContain("Line 10:");
    expect(collapsed).not.toContain("Line 11:");
    expect(collapsed).toContain("<muted>... (10 more lines,</muted> <dim>ctrl+o</dim>");
    const expanded = textOf(call(tool, { ...streaming, expanded: true }));
    expect(expanded).toContain("Line 20:");
    expect(expanded).not.toContain("to expand");
    const settled = textOf(call(tool, renderContext(args)));
    expect(settled).toContain("Line 10:");
    expect(settled).toContain("... (10 more lines,");
    const hostileArgs = action
      ? { ...args, content: "Safe\u001b[2J text" }
      : { handoff: "Safe\u001b[2J text" };
    expect(textOf(call(tool, renderContext(hostileArgs)))).toContain("Safe");
    expect(args).toEqual(original);
  },
);

test.each(["context_notes", "context_history", "context_rollover"])(
  "%s shows failures as error text with 10 head lines and an Expand Hint",
  async (name) => {
    const { tool } = await registeredTool(name);
    const body = Array.from({ length: 12 }, (_, index) => `Problem ${index + 1}`).join("\n");
    const failure = { content: [{ type: "text" as const, text: body }], details: undefined };
    const failed = renderContext(
      { action: "read", ref: "context:source:entry-a" },
      { isError: true },
    );
    const collapsed = result(tool, failure, failed);
    expect(collapsed[0]).toBe("<error>Problem 1</error>");
    expect(collapsed[9]).toBe("<error>Problem 10</error>");
    expect(collapsed[10]).toContain("<muted>... (2 more lines,</muted>");
    expect(collapsed.at(-1)).toBe(TOOK);
    const expanded = textOf(result(tool, failure, { ...failed, expanded: true }));
    expect(expanded).toContain("<error>Problem 12</error>");
    expect(expanded).not.toContain("to expand");
    const blank = { content: [], details: undefined };
    expect(result(tool, blank, failed)[0]).toBe(`<error>${name} failed</error>`);
    expect(result(tool, blank, renderContext({}))[0]).toBe(
      "<muted>Result details unavailable</muted>",
    );
    const hostile = {
      content: [{ type: "text" as const, text: "bad\u001b[2J output" }],
      details: undefined,
    };
    expect(textOf(result(tool, hostile, failed))).toContain("output");
  },
);

test("a partial result renders only the Elapsed footer", async () => {
  const { tool } = await registeredTool("context_history");
  const running = renderContext({ action: "list" }, { isPartial: true, durationMs: undefined });
  const rendered = result(tool, { content: [], details: undefined }, running, true);
  expect(rendered).toHaveLength(2);
  expect(rendered[1]).toMatch(/^<muted>Elapsed \d+\.\ds<\/muted>$/);
});

test("long multiline queries stay compact and terminal-safe without changing result data", async () => {
  const { tool } = await registeredTool("context_history");
  const query = `界😀${"long query ".repeat(30)}\nsecond line\u001b[2J`;
  const args = { action: "search", query };
  const details = {
    matches: [{ ref: "context:source:entry-a", offset: 8, preview: "literal\u001b[2Jcontent" }],
    nextOffset: null,
  };
  const found = withDetails(details);
  const original = structuredClone(found);
  for (const expanded of [false, true]) {
    const context = renderContext(args, { expanded });
    expect(textOf(call(tool, context))).toContain("long query");
    expect(textOf(result(tool, found, context))).toContain("literalcontent");
  }
  expect(found).toEqual(original);
});

test.each([
  ["pi-context-prepare", ""],
  ["pi-context-manual-prepare", "<dim> \u00b7 </dim><customMessageText>manual</customMessageText>"],
  [
    "pi-context-prepare-cancelled",
    "<dim> \u00b7 </dim><customMessageText>cancelled</customMessageText>",
  ],
])(
  "%s renders in Pi's custom-message box with a 10-line Collapsed View",
  async (customType, heading) => {
    const { session } = await registeredTool("context_notes");
    const renderer = session.extensionRunner.getMessageRenderer(customType);
    if (!renderer) throw new Error(`Missing message renderer: ${customType}`);
    const content = Array.from({ length: 14 }, (_, index) => `Instruction ${index + 1}`).join("\n");
    const message = { role: "custom" as const, customType, content, display: true, timestamp: 0 };
    const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme);
    if (!collapsed) throw new Error("Renderer returned nothing");
    const rows = lines(collapsed);
    const text = textOf(rows);
    expect(rows[1]?.replaceAll(/<\/?bg:customMessageBg>/gu, "").trim()).toBe(
      `<customMessageLabel><b>[context]</b></customMessageLabel> <customMessageText>rollover</customMessageText>${heading}`,
    );
    expect(text).toContain("<customMessageText>Instruction 10</customMessageText>");
    expect(text).not.toContain("Instruction 11");
    expect(text).toContain("<muted>... (4 more lines,</muted> <dim>ctrl+o</dim>");
    expect(rows.every((row) => row.includes("<bg:customMessageBg>"))).toBe(true);
    const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme);
    if (!expanded) throw new Error("Renderer returned nothing");
    const full = textOf(lines(expanded));
    expect(full).toContain("Instruction 14");
    expect(full).not.toContain("to expand");
    expectClickToggles(renderer, { ...message }, { expanded: false, outputPad: 1 }, theme);
  },
);
