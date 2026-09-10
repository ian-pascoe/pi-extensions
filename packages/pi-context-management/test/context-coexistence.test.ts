import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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
    const f = await createSdkHarness(
      position === "before" ? [companion, contextManagement] : [contextManagement, companion],
    );
    f.responses.push(reply("Ready."));
    await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
    f.manager.appendCustomMessageEntry("fixture-mcp-prompt", "Encoded prompt", false);
    f.session.agent.state.messages = f.manager.buildSessionContext().messages;
    f.responses.push(
      toolCall("context_rollover", { handoff: "Continue with the MCP prompt." }),
      reply("Done."),
    );
    await f.session.prompt("Roll over");
    expect(JSON.stringify(f.requests[2]).includes("MCP REPLAYED PROMPT")).toBe(true);
    expect(f.requests[2]?.systemPrompt).toContain("MCP SERVER INSTRUCTIONS");
    expect(JSON.stringify(f.requests[2]).includes("OLD-ONLY")).toBe(false);
  });
}
