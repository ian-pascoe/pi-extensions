import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type JsonValue } from "@earendil-works/pi-ai";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { ensureReferenceOrigin } from "../src/context-store.js";
import { registerContextTools } from "../src/context-tools.js";

interface ToolInput {
  action: string;
  name?: string;
  content?: string;
  query?: string;
  ref?: string;
  window?: string;
  offset?: number;
  limit?: number;
}
interface RegisteredTool {
  name: string;
  executionMode?: string;
  execute(
    id: string,
    params: ToolInput,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
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
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-widen-then-assert -- SAFETY: This framework boundary supplies all ExtensionAPI members used by these tool registrations; persistence is the real SessionManager.
  registerContextTools(api as unknown as ExtensionAPI, onFailure);
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-widen-then-assert -- SAFETY: The tools consume only sessionManager from this framework context; no internal storage collaborator is mocked.
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
      ).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(failures).toHaveLength(1);
    await expect(f.run("context_notes", { action: "read", name: "task" })).rejects.toThrow(
      /reload/,
    );
    const reloadedTools = harness(manager);
    await expect(reloadedTools.run("context_notes", { action: "list" })).rejects.toThrow(
      /not just \/reload/,
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
