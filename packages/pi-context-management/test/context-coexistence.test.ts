import { fileURLToPath } from "node:url";
import { chmodSync } from "node:fs";
import { expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { readNotes } from "../src/context-store.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

it("records non-triggering Todo snapshots but omits them from automatic continuation", async () => {
  const snapshotText = "TODO PUBLICATION PROBE: immutable snapshot";
  const publicationProbe: ExtensionFactory = (pi) => {
    pi.on("tool_result", (event) => {
      if (event.toolName !== "todo") return;
      pi.sendMessage(
        { customType: "todo-publication-probe", content: snapshotText, display: false },
        { triggerTurn: false },
      );
    });
  };
  const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
  const f = await createSdkHarness([contextManagement, publicationProbe], {
    additionalExtensionPaths: [todoPath],
  });
  f.responses.push(
    toolCall("todo", { action: "add", title: "Inspect blue widget" }),
    reply("Todo saved."),
  );
  await f.session.prompt("Record a Task, then continue");
  const branch = f.manager.getBranch();
  const resultIndex = branch.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "toolResult",
  );
  const snapshotIndex = branch.findIndex(
    (entry) => entry.type === "custom_message" && entry.customType === "todo-publication-probe",
  );
  expect(resultIndex).toBeGreaterThan(-1);
  expect(snapshotIndex).toBeGreaterThan(resultIndex);
  expect(f.session.messages).toContainEqual(
    expect.objectContaining({ role: "custom", content: snapshotText }),
  );
  expect(f.requests).toHaveLength(2);
  expect(f.providerRequests).toEqual([]);
  // Plan 001 STOP gate: turn_end persists the message, but the running loop retains
  // its older context snapshot. A new user prompt is required to observe the append.
  expect(JSON.stringify(f.requests[1]?.messages)).not.toContain(snapshotText);
  f.responses.push(reply("Continued."));
  await f.session.prompt("Continue on the next user turn");
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[2]?.messages)).toContain(snapshotText);
  expect(
    f.manager
      .getBranch()
      .filter(
        (entry) => entry.type === "custom_message" && entry.customType === "todo-publication-probe",
      ),
  ).toHaveLength(1);
  expect(f.providerRequests).toEqual([]);
});

it("projects real Todo mutations after every sibling result without an extra request", async () => {
  const sibling: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "sibling",
      label: "Sibling",
      description: "Unrelated sibling tool",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "Sibling result" }], details: {} };
      },
    });
  };
  const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
  const f = await createSdkHarness([contextManagement, sibling], {
    additionalExtensionPaths: [todoPath],
  });
  const calls = toolCall("todo", { action: "add", title: "Fixed journal state" });
  calls.content.push(
    {
      type: "toolCall",
      name: "todo",
      arguments: { action: "add", title: "Second Task" },
      id: "second-todo",
    },
    { type: "toolCall", name: "sibling", arguments: {}, id: "sibling-call" },
  );
  f.responses.push(calls, reply("Done."));
  await f.session.prompt("Run sibling tools");
  expect(f.requests).toHaveLength(2);
  const projected = f.requests[1]!.messages;
  const snapshotIndex = projected.findIndex(
    (message) => message.role === "user" && JSON.stringify(message.content).includes("Todo List:"),
  );
  expect(snapshotIndex).toBeGreaterThan(-1);
  expect(projected[snapshotIndex - 1]).toMatchObject({ role: "toolResult", toolName: "sibling" });
  expect(
    projected.slice(0, snapshotIndex).filter((message) => message.role === "toolResult"),
  ).toHaveLength(3);
  expect(JSON.stringify(projected[snapshotIndex])).toContain("Fixed journal state");
  expect(JSON.stringify(projected[snapshotIndex])).not.toContain("Second Task");
  expect(JSON.stringify(projected[snapshotIndex + 1])).toContain("Second Task");
  f.responses.push(reply("Still done."));
  await f.session.prompt("Unchanged next user turn");
  expect(f.requests[2]?.messages.slice(0, snapshotIndex + 2)).toEqual(
    projected.slice(0, snapshotIndex + 2),
  );
  expect(f.requests).toHaveLength(3);
  expect(f.providerRequests).toEqual([]);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "quarantines a failed Todo write but upstream disk reopen loses selected acknowledged history",
  async () => {
    const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
    const f = await createSdkHarness([], { additionalExtensionPaths: [todoPath] });
    f.responses.push(
      toolCall("todo", { action: "add", title: "Acknowledged Task A" }),
      reply("Saved."),
    );
    await f.session.prompt("Start a durable session with an acknowledged Task");
    const acknowledged = f.manager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === "pi-todo-state");
    if (!acknowledged) throw new Error("Missing acknowledged Todo state");
    const file = f.manager.getSessionFile();
    if (!file) throw new Error("Missing scratch session file");
    const append = f.manager.appendCustomEntry.bind(f.manager);
    let appendFailure: unknown;
    f.manager.appendCustomEntry = (customType, data) => {
      if (customType !== "pi-todo-state") return append(customType, data);
      chmodSync(file, 0o400);
      try {
        return append(customType, data);
      } catch (error) {
        appendFailure = error;
        throw error;
      } finally {
        chmodSync(file, 0o600);
      }
    };
    f.responses.push(toolCall("todo", { action: "add", title: "Unacknowledged Task" }));
    await f.session.prompt("Attempt a failing Todo write");
    expect(appendFailure).toMatchObject({ code: "EACCES" });
    expect(f.requests).toHaveLength(3);
    expect(
      f.manager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-todo-state"),
    ).toBe(true);
    expect(
      SessionManager.open(file)
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-todo-state"),
    ).toBe(false);
    f.manager.appendCustomEntry = append;
    await f.session.prompt("Do not send poisoned state");
    expect(f.requests).toHaveLength(3);
    await f.session.reload();
    await f.session.prompt("Still do not send poisoned state after extension reload");
    expect(f.requests).toHaveLength(3);
    expect(f.extensionErrors).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        error: expect.stringContaining("Todo is disabled in this loaded session"),
      }),
    );
    const reopenedManager = SessionManager.open(file);
    const persisted = reopenedManager.getEntries();
    const branch = reopenedManager.getBranch();
    // Existing host limitation: the error result references the unwritten state entry.
    // Earlier acknowledged history survives on disk but is disconnected from this leaf.
    expect(persisted.some((entry) => entry.id === acknowledged.id)).toBe(true);
    expect(branch.some((entry) => entry.id === acknowledged.id)).toBe(false);
    expect(branch[0]).toMatchObject({ type: "message", message: { role: "toolResult" } });
    expect(branch[0]!.parentId).not.toBeNull();
    expect(persisted.some((entry) => entry.id === branch[0]!.parentId)).toBe(false);
    const reopened = await createSdkHarness([], {
      manager: reopenedManager,
      additionalExtensionPaths: [todoPath],
    });
    reopened.responses.push(reply("Acknowledged history is missing."));
    await reopened.session.prompt("Continue from the persisted session");
    expect(reopened.requests).toHaveLength(1);
    expect(
      reopened.requests[0]!.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Todo List:"),
      ),
    ).toBe(false);
    expect(f.providerRequests).toEqual([]);
    expect(reopened.providerRequests).toEqual([]);
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "native append failures disconnect persisted history without Todo or its context projection",
  async () => {
    const nativeWriter: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "native_write",
        label: "Native write",
        description: "Exercise native journal persistence without Todo",
        parameters: Type.Object({}),
        async execute() {
          pi.appendEntry("native-write-probe", {});
          return { content: [{ type: "text", text: "Saved" }], details: {} };
        },
      });
    };
    const f = await createSdkHarness([nativeWriter]);
    f.responses.push(toolCall("native_write", {}), reply("Acknowledged."));
    await f.session.prompt("Persist acknowledged history");
    const acknowledged = f.manager.getLeafId();
    const file = f.manager.getSessionFile();
    if (!acknowledged || !file) throw new Error("Missing persisted history");
    const append = f.manager.appendCustomEntry.bind(f.manager);
    let appendFailure: unknown;
    f.manager.appendCustomEntry = (customType, data) => {
      chmodSync(file, 0o400);
      try {
        return append(customType, data);
      } catch (error) {
        appendFailure = error;
        throw error;
      } finally {
        chmodSync(file, 0o600);
      }
    };
    f.responses.push(toolCall("native_write", {}), reply("Write failed."));
    await f.session.prompt("Attempt a failing native append");
    expect(appendFailure).toMatchObject({ code: "EACCES" });
    const reopened = SessionManager.open(file);
    const persisted = reopened.getEntries();
    const branch = reopened.getBranch();
    expect(persisted.some((entry) => entry.id === acknowledged)).toBe(true);
    expect(branch.some((entry) => entry.id === acknowledged)).toBe(false);
    expect(branch[0]).toMatchObject({ type: "message", message: { role: "toolResult" } });
    expect(branch[0]!.parentId).not.toBeNull();
    expect(persisted.some((entry) => entry.id === branch[0]!.parentId)).toBe(false);
    expect(f.providerRequests).toEqual([]);
  },
);

it("restores selected-branch Tasks through tree navigation, reload, resume, and fork without duplicate snapshots", async () => {
  const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
  const f = await createSdkHarness([], { additionalExtensionPaths: [todoPath] });
  const snapshots = (messages: (typeof f.requests)[number]["messages"]) =>
    messages.filter(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Todo List:"),
    );
  f.responses.push(toolCall("todo", { action: "add", title: "Selected Task" }), reply("Added."));
  await f.session.prompt("Remember the selected Task");
  const firstLeaf = f.manager.getLeafId();
  if (!firstLeaf) throw new Error("Missing original branch leaf");
  const original = snapshots(f.requests[1]!.messages);
  expect(original).toHaveLength(1);
  f.responses.push(
    toolCall("todo", { action: "update", id: 1, title: "Abandoned sibling Task" }),
    reply("Updated."),
  );
  await f.session.prompt("Change on the sibling branch");
  expect(snapshots(f.requests[3]!.messages)).toHaveLength(2);
  await f.session.navigateTree(firstLeaf, { summarize: false });
  for (const reload of [false, true]) {
    if (reload) await f.session.reload();
    f.responses.push(toolCall("todo", { action: "list" }), reply("Selected branch restored."));
    await f.session.prompt("List the selected Tasks");
    const current = f.requests.at(-1)!.messages;
    expect(snapshots(current)).toEqual(original);
    expect(JSON.stringify(current.at(-1)), `after reload=${reload}`).toContain("Selected Task");
    expect(JSON.stringify(current)).not.toContain("Abandoned sibling Task");
  }
  const file = f.manager.getSessionFile();
  if (!file) throw new Error("Missing scratch session file");
  for (const manager of [SessionManager.open(file), SessionManager.forkFrom(file, f.dir, f.dir)]) {
    const restored = await createSdkHarness([], { manager, additionalExtensionPaths: [todoPath] });
    restored.responses.push(
      toolCall("todo", { action: "list" }),
      reply("Inherited selected branch."),
    );
    await restored.session.prompt("List inherited Tasks");
    expect(restored.requests).toHaveLength(2);
    const current = restored.requests[1]!.messages;
    expect(snapshots(current)).toEqual(original);
    expect(JSON.stringify(current.at(-1))).toContain("Selected Task");
    expect(JSON.stringify(current)).not.toContain("Abandoned sibling Task");
    expect(restored.providerRequests).toEqual([]);
    expect(restored.extensionErrors).toEqual([]);
  }
  expect(f.providerRequests).toEqual([]);
  expect(f.extensionErrors).toEqual([]);
});

for (const transition of ["native", "rollover"] as const) {
  for (const tailTokens of [0, 500]) {
    it(`maps ${transition} checkpoint to its immutable cutoff with Tail ${tailTokens}`, async () => {
      const anchors: Array<{ baseline: unknown; cutoff: string; summaryIndex: number }> = [];
      const inspect: ExtensionFactory = (pi) => {
        pi.on("context", (event, context) => {
          const branch = context.sessionManager.getBranch();
          const checkpoint = branch.findLast((entry) => entry.type === "compaction");
          if (!checkpoint) return;
          const cutoff = branch.findIndex((entry) => entry.id === checkpoint.firstKeptEntryId);
          expect(cutoff).toBeGreaterThan(-1);
          const baseline = branch
            .slice(0, cutoff)
            .findLast((entry) => entry.type === "custom" && entry.customType === "pi-todo-state");
          const summaryIndex = event.messages.findIndex(
            (message) =>
              message.role === "compactionSummary" &&
              message.summary === checkpoint.summary &&
              message.tokensBefore === checkpoint.tokensBefore &&
              message.timestamp === Date.parse(checkpoint.timestamp),
          );
          anchors.push({
            baseline: baseline?.type === "custom" ? baseline.data : undefined,
            cutoff: checkpoint.firstKeptEntryId,
            summaryIndex,
          });
        });
      };
      const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
      const f = await createSdkHarness([contextManagement, inspect], {
        additionalExtensionPaths: [todoPath],
        contextSettings: { tailTokens },
      });
      f.responses.push(
        toolCall("todo", { action: "add", title: "Before cutoff" }),
        reply("Saved."),
      );
      await f.session.prompt("Initial Task");
      f.responses.push(reply("Separator."));
      await f.session.prompt("discard ".repeat(4000));
      f.responses.push(
        toolCall("todo", { action: "update", id: 1, title: "After cutoff" }),
        reply("Updated."),
      );
      await f.session.prompt("Update retained Task");
      if (transition === "native") {
        await f.session.compact();
        f.responses.push(reply("Resumed."));
      } else {
        f.responses.push(
          toolCall("context_rollover", { handoff: "Continue the Task." }),
          reply("Resumed."),
        );
      }
      await f.session.prompt("Continue after checkpoint");
      expect(anchors.length).toBeGreaterThan(0);
      expect(anchors.every((anchor) => anchor.summaryIndex === 0)).toBe(true);
      expect(anchors.at(-1)?.baseline).toMatchObject({
        tasks: [{ title: tailTokens === 0 ? "After cutoff" : "Before cutoff" }],
      });
      expect(f.providerRequests).toEqual([]);
    });
  }
}

it("preserves the real Todo extension's live projection across a native Rollover", async () => {
  const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
  const f = await createSdkHarness([contextManagement], { additionalExtensionPaths: [todoPath] });
  expect(f.session.resourceLoader.getExtensions().errors).toEqual([]);
  expect(f.session.getAllTools().map((tool) => tool.name)).toContain("todo");
  f.responses.push(
    toolCall("todo", { action: "add", title: "Inspect blue widget" }),
    reply("Todo saved."),
  );
  await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
  f.responses.push(
    toolCall("context_rollover", { handoff: "Continue the widget task." }),
    reply("Done."),
  );
  await f.session.prompt("Roll over");
  expect(f.requests).toHaveLength(4);
  expect(JSON.stringify(f.requests[3]).includes("Inspect blue widget")).toBe(true);
  expect(JSON.stringify(f.requests[3]).includes("OLD-ONLY")).toBe(false);
  expect(
    f.manager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "pi-todo-state"),
  ).toBe(true);
  expect(
    f.manager
      .getBranch()
      .some((entry) => entry.type === "custom_message" && entry.customType === "pi-todo-context"),
  ).toBe(false);
});

for (const outcome of ["success", "throw", "cancel"] as const) {
  it(`retains nested Todo mutations after a CodeMode Cell ${outcome}`, async () => {
    const codeModePath = fileURLToPath(new URL("../../pi-codemode/src/index.ts", import.meta.url));
    const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
    let enteredGate: (() => void) | undefined;
    const atGate = new Promise<void>((resolve) => {
      enteredGate = resolve;
    });
    const gate: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "cancel_gate",
        label: "Cancel gate",
        description: "Wait for cancellation",
        parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          enteredGate?.();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("Cancelled"));
            else
              signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
                once: true,
              });
          });
          return { content: [{ type: "text", text: "Unreachable" }], details: {} };
        },
      });
    };
    const f = await createSdkHarness([gate], {
      additionalExtensionPaths: [todoPath, codeModePath],
    });
    expect(f.session.resourceLoader.getExtensions().errors).toEqual([]);
    const ending =
      outcome === "throw"
        ? 'throw new Error("Failure after mutation");'
        : outcome === "cancel"
          ? "await tools.cancel_gate({});"
          : "return 42;";
    f.responses.push(
      toolCall("codemode_execute", {
        script: 'await tools.todo({ action: "add", title: "Nested acknowledged Task" }); ' + ending,
        sessionId: "todo-cell",
        wait: true,
      }),
    );
    if (outcome !== "cancel") f.responses.push(reply("Cell finished."));
    const running = f.session.prompt("Mutate Todo within a Cell");
    if (outcome === "cancel") {
      await atGate;
      await f.session.abort();
    }
    await running;
    if (outcome === "cancel") {
      f.responses.push(reply("Continued after cancellation."));
      await f.session.prompt("Continue with the acknowledged Task");
    }
    expect(f.requests).toHaveLength(2);
    const messages = f.requests[1]!.messages;
    const snapshotIndex = messages.findIndex(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Todo List:"),
    );
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(messages[snapshotIndex - 1]).toMatchObject({
      role: "toolResult",
      toolName: "codemode_execute",
    });
    expect(JSON.stringify(messages[snapshotIndex])).toContain("Nested acknowledged Task");
    if (outcome === "throw")
      expect(JSON.stringify(messages[snapshotIndex - 1])).toContain("Failure after mutation");
    const prefix = messages.slice(0, snapshotIndex + 1);
    f.responses.push(reply("Still remembered."));
    await f.session.prompt("Continue without changing Todo");
    expect(f.requests[2]!.messages.slice(0, snapshotIndex + 1)).toEqual(prefix);
    expect(f.providerRequests).toEqual([]);
  }, 30_000);
}

// Includes Deno startup and three Cell/tool round trips on shared CI runners.
it("keeps a real CodeMode Deno binding alive through native compaction", async () => {
  const codeModePath = fileURLToPath(new URL("../../pi-codemode/src/index.ts", import.meta.url));
  const f = await createSdkHarness([contextManagement], {
    additionalExtensionPaths: [codeModePath],
  });
  expect(f.session.resourceLoader.getExtensions().errors).toEqual([]);
  expect(f.session.getAllTools().map((tool) => tool.name)).toContain("codemode_execute");
  f.responses.push(
    toolCall("codemode_execute", {
      script: "let retainedBinding = 41; return retainedBinding;",
      sessionId: "retained",
      wait: true,
    }),
    reply("Binding saved."),
  );
  await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
  expect(JSON.stringify(f.requests[1]).includes('"data":41')).toBe(true);
  await f.session.compact();
  f.responses.push(
    toolCall("codemode_execute", {
      script: "retainedBinding += 1; return retainedBinding;",
      sessionId: "retained",
      wait: true,
    }),
    reply("Binding survived."),
  );
  await f.session.prompt("Continue the existing Cell session");
  expect(JSON.stringify(f.requests[3]).includes('"data":42')).toBe(true);
  f.responses.push(
    toolCall("codemode_execute", {
      script:
        'await tools.context_notes({ action: "write", name: "cell-note", content: "Saved before Cell failure" }); await tools.context_rollover({ handoff: "Unsafe nested Handoff" });',
      sessionId: "retained",
      wait: true,
    }),
    reply("Nested rollover refused."),
  );
  await f.session.prompt("Attempt the unsafe nested operation");
  expect(readNotes(f.manager).map((note) => note.content)).toContain("Saved before Cell failure");
  expect(
    f.manager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "pi-context-handoff"),
  ).toBe(false);
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  expect(
    JSON.stringify(f.requests[5]).includes('"result":"failed"'),
    JSON.stringify(f.requests[5]).slice(-1800),
  ).toBe(true);
}, 30_000);

for (const position of ["before", "after"]) {
  it(`preserves MCP-style replay/instructions under ${position} hook order (contract fixture, no server)`, async () => {
    const companion: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt + "\nMCP SERVER INSTRUCTIONS",
      }));
      pi.on("context", (event) => ({
        messages: event.messages.map((message): AgentMessage =>
          message.role === "custom" && message.customType === "fixture-mcp-prompt"
            ? { role: "user", content: "MCP REPLAYED PROMPT", timestamp: message.timestamp }
            : message,
        ),
      }));
    };
    const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
    const { default: todo }: { default: ExtensionFactory } = await import(todoPath);
    const f = await createSdkHarness(
      position === "before"
        ? [companion, todo, contextManagement]
        : [contextManagement, todo, companion],
    );
    f.responses.push(
      toolCall("todo", { action: "add", title: "Task alongside MCP" }),
      reply("Ready."),
    );
    await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
    f.manager.appendCustomMessageEntry("fixture-mcp-prompt", "Encoded prompt", false);
    f.session.agent.state.messages = f.manager.buildSessionContext().messages;
    f.responses.push(
      toolCall("context_rollover", { handoff: "Continue with the MCP prompt." }),
      reply("Done."),
    );
    await f.session.prompt("Roll over");
    expect(f.requests).toHaveLength(4);
    expect(JSON.stringify(f.requests[3]).includes("MCP REPLAYED PROMPT")).toBe(true);
    expect(f.requests[3]?.systemPrompt).toContain("MCP SERVER INSTRUCTIONS");
    expect(JSON.stringify(f.requests[3]).includes("OLD-ONLY")).toBe(false);
    expect(JSON.stringify(f.requests[3])).toContain("Task alongside MCP");
  });
}
