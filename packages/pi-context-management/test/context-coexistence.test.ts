import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { readNotes } from "../src/context-store.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

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
