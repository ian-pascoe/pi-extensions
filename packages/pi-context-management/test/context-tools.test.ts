import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type JsonValue,
} from "@earendil-works/pi-ai";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, onTestFinished, test } from "vitest";
import { ensureReferenceOrigin } from "../src/context-store.js";
import { registerContextTools } from "../src/context-tools.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";

interface ToolInput {
  action: string;
  name?: string;
  content?: string;
  query?: string;
  ref?: string;
  window?: string;
  type?: string;
  role?: string;
  offset?: number;
  limit?: number;
}
interface RegisteredTool {
  name: string;
  executionMode?: string;
  outputSchema?: TSchema;
  execute(
    id: string,
    params: ToolInput,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: JsonValue;
    structuredContent?: JsonValue;
  }>;
}
/** Independent reference conversion for the camelCase text/details to the script-facing keys. */
function snakeCaseKeys(value: JsonValue | undefined): JsonValue | undefined {
  if (Array.isArray(value)) return value.map((item) => snakeCaseKeys(item) ?? null);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Test input is JSON this suite just parsed; this separates object nodes from primitives.
  if (value === null || typeof value !== "object" || value === undefined) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
      snakeCaseKeys(entry) ?? null,
    ]),
  );
}
function harness(manager = SessionManager.inMemory(), onFailure?: (error: Error) => void) {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data: JsonValue) {
      manager.appendCustomEntry(customType, data);
    },
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This framework boundary supplies all ExtensionAPI members used by these tool registrations; persistence is the real SessionManager.
  registerContextTools(api as unknown as ExtensionAPI, onFailure);
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The tools consume only sessionManager from this framework context; no internal storage collaborator is mocked.
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  return {
    manager,
    tools,
    ensureOrigin() {
      ensureReferenceOrigin(api, manager);
    },
    async run(name: string, input: ToolInput, signal?: AbortSignal) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      const result = await tool.execute("test-call", input, signal, undefined, ctx);
      return result.content.map((item) => item.text ?? "").join("\n");
    },
    /** The value a codemode script receives, checked against the tool's declared schema. */
    async structured(name: string, input: ToolInput) {
      const tool = tools.get(name);
      if (!tool?.outputSchema) throw new Error(`Missing outputSchema for ${name}`);
      const result = await tool.execute("test-call", input, undefined, undefined, ctx);
      const text = result.content.map((item) => item.text ?? "").join("\n");
      expect(Value.Check(tool.outputSchema, result.structuredContent)).toBe(true);
      // The model's text and persisted details keep camelCase; scripts get the snake_case value.
      expect(JSON.parse(text)).toEqual(result.details);
      expect(result.structuredContent).toEqual(snakeCaseKeys(JSON.parse(text)));
      expect(JSON.stringify(result.structuredContent)).not.toMatch(/"[a-z]+[A-Z]\w*":/);
      return result.structuredContent;
    },
  };
}

describe("Context History tools", () => {
  test("History reads exact recorded JSON ranges and never fetches external spill originals", async () => {
    const f = harness();
    const id = f.manager.appendCustomEntry("external-output", {
      fullOutputPath: "/never-open-this/missing-output.txt",
      partial: "recorded portion",
    });
    const ref = `context:${f.manager.getSessionId()}:${id}`;
    const literal = f.manager.appendMessage({
      role: "user",
      content: 'literal "quote"\\path\nnext',
      timestamp: 0,
    });
    expect(
      await f.run("context_history", { action: "search", query: '"quote"\\path\nnext' }),
    ).toContain(`context:${f.manager.getSessionId()}:${literal}`);
    const escaped = f.manager.appendMessage({
      role: "user",
      content: "literal \\n only",
      timestamp: 1,
    });
    expect(await f.run("context_history", { action: "search", query: "\n" })).not.toContain(
      `context:${f.manager.getSessionId()}:${escaped}`,
    );
    const read = await f.run("context_history", { action: "read", ref });
    expect(read).toContain("recorded portion");
    expect(read).toContain("may be missing");
    const range = await f.run("context_history", { action: "read", ref, offset: 0, limit: 1 });
    expect(range).toContain('"content":"{"');
    expect(range).toContain('"nextOffset":1');
    expect(
      await f.run("context_history", { action: "search", query: "recorded", limit: 1 }),
    ).toContain(ref);
    await expect(f.run("context_history", { action: "read", ref: "/etc/passwd" })).rejects.toThrow(
      /source-qualified/,
    );
  });
  test("malformed references explain the format, an example, and where valid refs come from", async () => {
    const f = harness();
    const id = f.manager.appendMessage({ role: "user", content: "recent", timestamp: 0 });
    const message = await f.run("context_history", { action: "read", ref: "bogus" }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toContain('Invalid reference "bogus"');
    expect(message).toContain("context:<session>:<entry>");
    expect(message).toContain(`context:${f.manager.getSessionId()}:${id}`);
    expect(message).toMatch(/windows.*list.*search/);
    await expect(f.run("context_history", { action: "list", window: "bogus" })).rejects.toThrow(
      /Invalid reference "bogus"/,
    );
  });
  test("rejects forged source qualifiers even when the entry exists locally", async () => {
    const f = harness();
    f.manager.appendMessage({ role: "user", content: "local", timestamp: 0 });
    f.ensureOrigin();
    const ref = /"ref":"([^"]+)"/.exec(await f.run("context_history", { action: "list" }))?.[1];
    const window = /"ref":"([^"]+)"/.exec(
      await f.run("context_history", { action: "windows" }),
    )?.[1];
    if (!ref || !window) throw new Error("Missing local references");
    const forgedRef = ref.replace(/^context:[^:]+:/, "context:unrelated-session:");
    const forgedWindow = window.replace(/^context:[^:]+:/, "context:unrelated-session:");
    await expect(f.run("context_history", { action: "read", ref: forgedRef })).rejects.toThrow(
      /source session/i,
    );
    await expect(
      f.run("context_history", { action: "list", window: forgedWindow }),
    ).rejects.toThrow(/source session/i);
  });
  test("origin records preserve references through multiple native forks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-multifork-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const original = SessionManager.create(dir, dir);
    original.appendMessage(fauxAssistantMessage("Original task"));
    const parent = harness(original);
    parent.ensureOrigin();
    const firstFile = original.getSessionFile();
    if (!firstFile) throw new Error("Missing original journal");
    const childManager = SessionManager.forkFrom(firstFile, dir, dir);
    const child = harness(childManager);
    child.ensureOrigin();
    const inheritedRef = /"ref":"([^"]+)"/.exec(
      await child.run("context_history", { action: "list" }),
    )?.[1];
    const childFile = childManager.getSessionFile();
    if (!inheritedRef || !childFile) throw new Error("Missing child provenance");
    const grandchild = harness(SessionManager.forkFrom(childFile, dir, dir));
    grandchild.ensureOrigin();
    expect(
      await grandchild.run("context_history", { action: "read", ref: inheritedRef }),
    ).toContain("Original task");
    const childOnly = childManager.appendMessage(fauxAssistantMessage("Child-only content"));
    const forged = `context:${original.getSessionId()}:${childOnly}`;
    await expect(child.run("context_history", { action: "read", ref: forged })).rejects.toThrow(
      /source session/i,
    );
    await expect(child.run("context_history", { action: "list", window: forged })).rejects.toThrow(
      /source session/i,
    );
  });
  test("forks resolve inherited references and Notes while plain children do not inherit the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-fork-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage(fauxAssistantMessage("Original task"));
    const f = harness(manager);
    f.ensureOrigin();
    await f.run("context_notes", { action: "write", name: "task", content: "PARENT NOTE" });
    const listed = await f.run("context_history", { action: "list" });
    const ref = /"ref":"([^"]+)"/.exec(listed)?.[1];
    const window = /"ref":"([^"]+)"/.exec(
      await f.run("context_history", { action: "windows" }),
    )?.[1];
    const file = manager.getSessionFile();
    if (!ref || !window || !file) throw new Error("Missing reference or scratch journal");
    const fork = harness(SessionManager.forkFrom(file, dir, dir));
    expect(await fork.run("context_history", { action: "read", ref })).toContain("Original task");
    expect(await fork.run("context_history", { action: "list", window })).toContain("items");
    expect(await fork.run("context_notes", { action: "read", name: "task" })).toContain(
      "PARENT NOTE",
    );
    await fork.run("context_notes", { action: "write", name: "task", content: "FORK NOTE" });
    expect(await f.run("context_notes", { action: "read", name: "task" })).toContain("PARENT NOTE");
    const child = harness();
    expect(await child.run("context_notes", { action: "list" })).toContain('"notes":[]');
    await expect(child.run("context_history", { action: "read", ref })).rejects.toThrow(
      /selected branch/,
    );
    await expect(child.run("context_history", { action: "list", window })).rejects.toThrow(
      /selected branch/,
    );
  });
  test("browses native windows and reads archived items without exposing siblings", async () => {
    const f = harness();
    const old = f.manager.appendMessage({
      role: "user",
      content: "ARCHIVED original",
      timestamp: 0,
    });
    const later = f.manager.appendMessage({ role: "user", content: "Recent task", timestamp: 1 });
    f.manager.appendCompaction("Handoff", later, 100);
    const windows = await f.run("context_history", { action: "windows" });
    expect(windows).toContain('"total":2');
    const ref = `context:${f.manager.getSessionId()}:${old}`;
    expect(await f.run("context_history", { action: "read", ref })).toContain("ARCHIVED original");
    expect(await f.run("context_history", { action: "search", query: "ARCHIVED" })).toContain(ref);
    f.manager.branch(old);
    const sibling = f.manager.appendMessage({
      role: "user",
      content: "ABANDONED sibling",
      timestamp: 2,
    });
    f.manager.branch(old);
    expect(await f.run("context_history", { action: "search", query: "ABANDONED" })).toContain(
      '"matches":[]',
    );
    await expect(
      f.run("context_history", {
        action: "read",
        ref: `context:${f.manager.getSessionId()}:${sibling}`,
      }),
    ).rejects.toThrow(/selected branch/);
    await expect(harness().run("context_history", { action: "read", ref })).rejects.toThrow(
      /selected branch/,
    );
  });
});

describe("Context Notes tools", () => {
  test("bounds pages and exact reads, rejects oversized Notes, and restores the selected branch", async () => {
    const f = harness();
    for (let i = 0; i < 21; i++)
      await f.run("context_notes", {
        action: "write",
        name: `note-${String(i).padStart(2, "0")}`,
        content: "x".repeat(2500),
      });
    expect(await f.run("context_notes", { action: "list", limit: 2000 })).toContain(
      '"nextOffset":20',
    );
    expect(await f.run("context_notes", { action: "list", offset: 20 })).toContain(
      '"name":"note-20"',
    );
    const read = await f.run("context_notes", { action: "read", name: "note-00" });
    expect(read).toContain('"nextOffset":2000');
    expect(read).not.toContain("x".repeat(2001));
    await expect(
      f.run("context_notes", { action: "write", name: "large", content: "x".repeat(64001) }),
    ).rejects.toThrow(/Invalid/);
    const leaf = f.manager.getLeafId();
    if (!leaf) throw new Error("Expected a Note entry");
    await f.run("context_notes", { action: "delete", name: "note-00" });
    await expect(f.run("context_notes", { action: "read", name: "note-00" })).rejects.toThrow(
      /not found/,
    );
    f.manager.branch(leaf);
    expect(
      await f.run("context_notes", { action: "read", name: "note-00", offset: 2499 }),
    ).toContain('"content":"x"');
    f.manager.appendCustomEntry("pi-context-note", {
      version: 99,
      name: "note-00",
      content: "UNSUPPORTED DATA",
      sourceSession: f.manager.getSessionId(),
    });
    expect(await f.run("context_notes", { action: "read", name: "note-00" })).not.toContain(
      "UNSUPPORTED DATA",
    );
  });
  test("rejects unsafe names and aborted mutations without creating a Note", async () => {
    const f = harness();
    for (const name of ["../outside", "task\n"]) {
      await expect(
        f.run("context_notes", { action: "write", name, content: "unsafe" }),
      ).rejects.toThrow(/Invalid/);
    }
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      f.run(
        "context_notes",
        { action: "write", name: "task", content: "cancelled" },
        cancellation.signal,
      ),
    ).rejects.toThrow();
    expect(await f.run("context_notes", { action: "list" })).toContain('"notes":[]');
  });
  test("acknowledged Notes survive failed writes and the failed manager is quarantined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-notes-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage(fauxAssistantMessage("Ready"));
    const failures: Error[] = [];
    const f = harness(manager, (error) => failures.push(error));
    await f.run("context_notes", { action: "write", name: "task", content: "ACKNOWLEDGED" });
    const file = manager.getSessionFile();
    if (!file) throw new Error("Scratch journal was not created");
    chmodSync(file, 0o400);
    try {
      await expect(
        f.run("context_notes", { action: "write", name: "task", content: "UNCOMMITTED" }),
      ).rejects.toThrow(/EACCES[\s\S]*troubleshooting Skill/);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).not.toContain(TROUBLESHOOTING_HINT);
    await expect(f.run("context_notes", { action: "read", name: "task" })).rejects.toThrow(
      TROUBLESHOOTING_HINT,
    );
    const reloadedTools = harness(manager);
    await expect(reloadedTools.run("context_notes", { action: "list" })).rejects.toThrow(
      /not just \/reload[\s\S]*troubleshooting Skill/,
    );
    await expect(reloadedTools.run("context_history", { action: "windows" })).rejects.toThrow(
      TROUBLESHOOTING_HINT,
    );
    manager.setSessionFile(file);
    const resumedManager = harness(manager);
    expect(await resumedManager.run("context_notes", { action: "read", name: "task" })).toContain(
      "ACKNOWLEDGED",
    );
    const reopened = harness(SessionManager.open(file));
    expect(await reopened.run("context_notes", { action: "read", name: "task" })).toContain(
      "ACKNOWLEDGED",
    );
    expect(await reopened.run("context_notes", { action: "read", name: "task" })).not.toContain(
      "UNCOMMITTED",
    );
  });
  test("literal search finds case-sensitive occurrences and supports bounded pagination", async () => {
    const f = harness();
    await f.run("context_notes", { action: "write", name: "task", content: "Blue. blue. Blue." });
    const first = await f.run("context_notes", { action: "search", query: "Blue.", limit: 1 });
    expect(first).toContain('"offset":0');
    expect(first).toContain('"nextOffset":1');
    expect(
      await f.run("context_notes", { action: "search", query: "Blue.", offset: 1, limit: 1 }),
    ).toContain('"offset":12');
    expect(await f.run("context_notes", { action: "search", query: "B.*" })).toContain(
      '"matches":[]',
    );
  });
  test("agent can write, append, and read exact ranges of named Markdown Notes", async () => {
    const f = harness();
    await f.run("context_notes", { action: "write", name: "task", content: "# Task\nBlue" });
    await f.run("context_notes", { action: "append", name: "task", content: " widget" });
    expect(
      await f.run("context_notes", { action: "read", name: "task", offset: 7, limit: 4 }),
    ).toContain('"content":"Blue"');
    expect(await f.run("context_notes", { action: "list" })).toContain('"name":"task"');
    expect(f.tools.get("context_notes")?.executionMode).toBe("sequential");
  });
});

describe("History previews and filters", () => {
  function seeded() {
    const f = harness();
    f.manager.appendMessage({
      role: "user",
      content: "Where is the\nconfig?",
      timestamp: 0,
    });
    f.manager.appendMessage(
      fauxAssistantMessage([
        fauxText("Checking the file."),
        fauxToolCall("bash", { command: "cat config.json" }, { id: "call-a" }),
      ]),
    );
    f.manager.appendMessage(
      fauxAssistantMessage([fauxToolCall("read", { path: "src/a.ts" }, { id: "call-b" })]),
    );
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "read",
      content: [{ type: "text", text: "export const a = 1;" }],
      isError: false,
      timestamp: 1,
    });
    f.manager.appendThinkingLevelChange("high");
    f.manager.appendCustomEntry("pi-todo-state", { tasks: [] });
    return f;
  }
  async function previews(
    f: ReturnType<typeof harness>,
    input: Partial<ToolInput> = {},
  ): Promise<string[]> {
    const listed: { items: Array<{ preview: string }> } = JSON.parse(
      await f.run("context_history", { action: "list", ...input }),
    );
    return listed.items.map((item) => item.preview);
  }

  test("list previews describe each entry's content instead of JSON boilerplate", async () => {
    expect(await previews(seeded())).toEqual([
      "user: Where is the config?",
      "assistant: Checking the file. → bash(cat config.json)",
      "assistant → read(src/a.ts)",
      "toolResult(read): export const a = 1;",
      "thinking_level_change(high)",
      "custom(pi-todo-state)",
    ]);
  });

  test("previews are bounded and stay on one line", async () => {
    const f = harness();
    f.manager.appendMessage({
      role: "user",
      content: `${"long text\n".repeat(100)}`,
      timestamp: 0,
    });
    const [preview] = await previews(f);
    expect(preview?.length).toBeLessThanOrEqual(120);
    expect(preview).toMatch(/^user: long text long text/);
    expect(preview).toMatch(/…$/);
    expect(preview).not.toContain("\n");
  });

  test("previews separate thinking-only, failed, and error entries and never split a character", async () => {
    const f = harness();
    f.manager.appendMessage(fauxAssistantMessage([fauxThinking("pondering")]));
    f.manager.appendMessage({
      ...fauxAssistantMessage([]),
      stopReason: "error",
      errorMessage: "rate limited",
    });
    f.manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-c",
      toolName: "edit",
      content: [],
      isError: true,
      timestamp: 1,
    });
    f.manager.appendMessage({ role: "user", content: "😀".repeat(200), timestamp: 2 });
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Simulates a recorded entry from another Pi version whose message lacks its content field.
    f.manager.appendMessage({ role: "user", timestamp: 3 } as unknown as Parameters<
      SessionManager["appendMessage"]
    >[0]);
    const [thinking, errored, failed, emoji, malformed] = await previews(f);
    expect(thinking).toBe("assistant: [thinking]");
    expect(errored).toBe("assistant: rate limited");
    expect(failed).toBe("toolResult(edit, error)");
    expect(emoji).toBe(`user: ${"😀".repeat(29)}…`);
    expect(malformed).toBe("message");
  });

  test("an earlier call that reused the running call's ID is still searchable", async () => {
    const f = harness();
    f.manager.appendMessage(
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "grep needle src" }, { id: "test-call" }),
      ]),
    );
    f.manager.appendMessage(
      fauxAssistantMessage([
        fauxToolCall("context_history", { action: "search", query: "needle" }, { id: "test-call" }),
      ]),
    );
    const found = JSON.parse(await f.run("context_history", { action: "search", query: "needle" }));
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0].preview).toBe("grep needle src");
  });

  test("type and role filters narrow list; the default returns every entry", async () => {
    const f = seeded();
    expect(await previews(f, { type: "message" })).toHaveLength(4);
    expect(await previews(f, { type: "custom" })).toEqual(["custom(pi-todo-state)"]);
    expect(await previews(f, { role: "assistant" })).toEqual([
      "assistant: Checking the file. → bash(cat config.json)",
      "assistant → read(src/a.ts)",
    ]);
    expect(await previews(f, { role: "toolResult" })).toEqual([
      "toolResult(read): export const a = 1;",
    ]);
    expect(await previews(f, { type: "custom", role: "user" })).toEqual([]);
    expect(await previews(f)).toHaveLength(6);
    const filtered = await f.structured("context_history", {
      action: "list",
      type: "message",
    });
    expect(filtered).toMatchObject({ total: 4, next_offset: null });
    const paged = await f.structured("context_history", {
      action: "list",
      type: "message",
      limit: 3,
    });
    expect(paged).toMatchObject({ total: 4, next_offset: 3 });
  });

  test("filtered list refs and search offsets still address read", async () => {
    const f = seeded();
    const listed = JSON.parse(
      await f.run("context_history", { action: "list", role: "toolResult" }),
    );
    const ref: string = listed.items[0].ref;
    const read = JSON.parse(await f.run("context_history", { action: "read", ref }));
    expect(read.content).toContain('"toolName":"read"');
    const found = JSON.parse(
      await f.run("context_history", {
        action: "search",
        query: "config.json",
        type: "message",
      }),
    );
    expect(found.matches.length).toBeGreaterThan(0);
    for (const match of found.matches) {
      const chunk = JSON.parse(
        await f.run("context_history", {
          action: "read",
          ref: match.ref,
          offset: match.offset,
          limit: 11,
        }),
      );
      expect(chunk.content).toBe("config.json");
    }
  });

  test("search honours the filters", async () => {
    const f = seeded();
    f.manager.appendCustomEntry("note-keeper", {
      text: "config.json lives here",
    });
    const refs = async (input: Partial<ToolInput>) =>
      JSON.parse(
        await f.run("context_history", {
          action: "search",
          query: "config",
          ...input,
        }),
      ).matches.length;
    const all = await refs({});
    expect(await refs({ type: "message" })).toBeLessThan(all);
    expect(await refs({ type: "custom" })).toBe(1);
    expect(await refs({ role: "user" })).toBe(1);
  });

  test("search previews are readable text, not escaped JSON", async () => {
    const f = harness();
    f.manager.appendMessage({
      role: "user",
      content: '"hi"\nC:\\temp needle done',
      timestamp: 0,
    });
    const found = JSON.parse(await f.run("context_history", { action: "search", query: "needle" }));
    expect(found.matches[0].preview).toBe('"hi"\nC:\\temp needle done');
  });

  test("search skips the in-flight call that ran it but finds the same text elsewhere", async () => {
    const f = harness();
    f.manager.appendMessage({
      role: "user",
      content: "needle earlier",
      timestamp: 0,
    });
    f.manager.appendMessage(
      fauxAssistantMessage([
        fauxText("Looking up needle"),
        fauxToolCall("context_history", { action: "search", query: "needle" }, { id: "test-call" }),
        fauxToolCall(
          "context_history",
          { action: "search", query: "needle" },
          { id: "other-call" },
        ),
      ]),
    );
    const found = JSON.parse(await f.run("context_history", { action: "search", query: "needle" }));
    // The earlier user text, the assistant prose, and the other call's query; not test-call's.
    expect(found.matches).toHaveLength(3);
    const own = JSON.parse(
      await f.run("context_history", {
        action: "search",
        query: "test-call",
      }),
    );
    expect(own.matches).toEqual([]);
  });
});

describe("structured results for codemode scripts", () => {
  test("context_notes returns schema-valid structuredContent matching its text for every action", async () => {
    const f = harness();
    expect(
      await f.structured("context_notes", {
        action: "write",
        name: "task",
        content: "# Task\nBlue",
      }),
    ).toEqual({ action: "write", name: "task", saved: true });
    await f.structured("context_notes", { action: "append", name: "task", content: " widget" });
    expect(await f.structured("context_notes", { action: "list" })).toMatchObject({
      notes: [{ name: "task", characters: 18 }],
      total: 1,
      next_offset: null,
    });
    expect(
      await f.structured("context_notes", { action: "read", name: "task", offset: 7, limit: 4 }),
    ).toMatchObject({ name: "task", content: "Blue", offset: 7, total_characters: 18 });
    expect(
      await f.structured("context_notes", { action: "search", query: "Blue", name: "task" }),
    ).toMatchObject({ matches: [{ name: "task", offset: 7 }], next_offset: null });
    expect(await f.structured("context_notes", { action: "delete", name: "task" })).toEqual({
      action: "delete",
      name: "task",
      saved: true,
    });
  });

  test("context_history returns schema-valid structuredContent matching its text for every action", async () => {
    const f = harness();
    const messageId = f.manager.appendMessage({
      role: "user",
      content: "needle in a haystack",
      timestamp: 0,
    });
    f.ensureOrigin();
    const windows = await f.structured("context_history", { action: "windows" });
    expect(windows).toMatchObject({ total: 1, next_offset: null });
    const listed = await f.structured("context_history", { action: "list" });
    expect(listed).toMatchObject({ next_offset: null });
    const ref = `context:${f.manager.getSessionId()}:${messageId}`;
    expect(listed).toMatchObject({
      total: 2,
      items: [{ ref, type: "message" }, { type: "custom" }],
    });
    expect(await f.structured("context_history", { action: "read", ref, limit: 40 })).toMatchObject(
      { ref, format: "recorded-entry-json", offset: 0 },
    );
    expect(
      await f.structured("context_history", { action: "search", query: "needle" }),
    ).toMatchObject({ matches: [{ ref }], next_offset: null });
  });
});
