import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createCodemodeExtension,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { readNotes } from "../src/context-store.js";
import { createSdkHarness, overflow, reply, toolCall } from "./sdk-harness.js";

/** Pi's built-in codemode registers inactive; SDK sessions add and activate it explicitly. */
function activateCodemode(session: {
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
}) {
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
}

const scriptOutput = (message: AgentMessage | undefined) =>
  message?.role === "toolResult" && message.toolName === "codemode"
    ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    : "";

it("hands codemode scripts typed todo, context_notes and context_history values and keeps tool definitions stable", async () => {
  const todoPath = fileURLToPath(new URL("../../pi-todo/src/index.ts", import.meta.url));
  const f = await createSdkHarness([contextManagement, createCodemodeExtension()], {
    additionalExtensionPaths: [todoPath],
  });
  expect(f.session.resourceLoader.getExtensions().errors).toEqual([]);
  activateCodemode(f.session);
  const script = `
    const added = await tools.todo({ action: "add", title: "Typed Task", status: "active" });
    const listed = await tools.todo({ action: "list" });
    const saved = await tools.context_notes({ action: "write", name: "n", content: "hello" });
    const read = await tools.context_notes({ action: "read", name: "n" });
    const windows = await tools.context_history({ action: "windows" });
    return {
      taskId: added.task.id,
      listedTitles: listed.tasks.map((task) => task.title),
      saved: saved.saved,
      note: read.content,
      windowCount: windows.total,
      windowRef: typeof windows.windows[0].ref,
      noteLength: read.total_characters,
      windowsNext: windows.next_offset,
      camelCase: [read.totalCharacters, windows.nextOffset],
    };`;
  f.responses.push(toolCall("codemode", { code: script }), reply("Typed."));
  await f.session.prompt("Use typed results");
  // The Todo projection follows the script's result as a hidden user message.
  const output = scriptOutput(f.requests[1]?.messages.findLast((m) => m.role === "toolResult"));
  expect(output).toMatch(/^Script completed/);
  expect(output).toContain(
    '{"taskId":1,"listedTitles":["Typed Task"],"saved":true,"note":"hello","windowCount":1,"windowRef":"string","noteLength":5,"windowsNext":null,"camelCase":[null,null]}',
  );

  // The model still reads the unchanged JSON text of a direct call.
  f.responses.push(
    toolCall("context_notes", { action: "read", name: "n" }, "direct"),
    reply("Done."),
  );
  await f.session.prompt("Read it directly");
  const direct = f.requests[3]?.messages.at(-1);
  expect(JSON.stringify(direct)).toContain(
    JSON.stringify(
      JSON.stringify({
        name: "n",
        ref: readNotes(f.manager)[0]?.ref,
        content: "hello",
        offset: 0,
        totalCharacters: 5,
        nextOffset: null,
      }),
    ),
  );

  // Ordered declarations (name, description with the Codemode result line, parameters) never move.
  const declared = (index: number) => f.requests[index]?.toolDefinitions;
  expect(f.requests[0]?.tools).toEqual(
    expect.arrayContaining(["todo", "context_notes", "context_history"]),
  );
  const todoDescription = declared(0)?.find((tool) => tool.name === "todo")?.description ?? "";
  expect(todoDescription).toMatch(
    /Codemode: `tools\.todo\(args\)` resolves to `\{ action, tasks\?, task\?: \{ id, title, description\?, status \}, id\?, cleared\? \}`/,
  );
  f.responses.push(reply("After reload."));
  await f.session.reload();
  await f.session.prompt("Turn after reload");
  const last = f.requests.length - 1;
  for (let index = 1; index <= last; index++) expect(declared(index)).toEqual(declared(0));
  expect(f.providerRequests).toEqual([]);
}, 30_000);

it("keeps codemode store() values and script-saved Notes through native compaction", async () => {
  const f = await createSdkHarness([contextManagement, createCodemodeExtension()]);
  expect(f.session.resourceLoader.getExtensions().errors).toEqual([]);
  activateCodemode(f.session);
  f.responses.push(
    toolCall("codemode", { code: 'store("retained", 41); return load("retained");' }),
    reply("Value saved."),
  );
  await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
  expect(scriptOutput(f.requests[1]?.messages.at(-1))).toMatch(/^Script completed[\s\S]*\b41\b/);
  f.responses.push(
    overflow(),
    toolCall("codemode", {
      code: 'const value = load("retained") + 1; store("retained", value); return value;',
    }),
    reply("Value survived."),
  );
  await f.session.prompt("Continue with the stored value");
  expect(f.requests).toHaveLength(5);
  expect(JSON.stringify(f.requests[3])).not.toContain("OLD-ONLY");
  expect(scriptOutput(f.requests[4]?.messages.at(-1))).toMatch(/^Script completed[\s\S]*\b42\b/);
  f.responses.push(
    toolCall("codemode", {
      code: 'await tools.context_notes({ action: "write", name: "script-note", content: "Saved before script failure" }); throw new Error("Failure after the Note write");',
    }),
    reply("Script failure reported."),
  );
  await f.session.prompt("Fail a script after saving a Note");
  expect(readNotes(f.manager).map((note) => note.content)).toContain("Saved before script failure");
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
  const failed = scriptOutput(f.requests[6]?.messages.at(-1));
  expect(failed, failed).toMatch(/^Script failed[\s\S]*Failure after the Note write/);
}, 30_000);

for (const mode of ["on", "only"] as const) {
  it(`declares model-only context_rollover but never offers it to scripts or nested calls under codemode ${mode}`, async () => {
    let nested: unknown;
    const probe: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "nested_probe",
        label: "Nested probe",
        description: "Try to run Rollover through ctx.executeTool",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          nested = await ctx.executeTool("context_rollover", { handoff: "Unsafe nested Handoff" });
          return { content: [{ type: "text", text: "Probed." }], details: {} };
        },
      });
    };
    const f = await createSdkHarness([contextManagement, createCodemodeExtension(), probe], {
      settings: SettingsManager.inMemory({
        codemode: { mode },
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 512 },
        retry: { enabled: false },
      }),
    });
    expect(f.session.resourceLoader.getExtensions().errors).toEqual([]);
    activateCodemode(f.session);
    expect(f.session.getAllTools().find((tool) => tool.name === "context_rollover")).toMatchObject({
      exposure: "model-only",
    });
    expect(f.session.getActiveToolNames()).toContain("context_rollover");
    expect(f.session.getCallableToolNames()).not.toContain("context_rollover");
    const attempt =
      'try { await tools.context_rollover({ handoff: "Unsafe script Handoff" }); return "called"; } catch (error) { return String(error.message); }';
    f.responses.push(
      toolCall("codemode", { code: attempt }),
      toolCall("nested_probe", {}, "probe-1"),
      reply("Both refused."),
    );
    await f.session.prompt("Try to roll over from a script and a nested call");
    const scripted = scriptOutput(f.requests[1]?.messages.at(-1));
    expect(scripted, scripted).toContain("tools.context_rollover does not exist");
    expect(scripted).not.toContain("called");
    expect(nested).toMatchObject({ isError: true });
    expect(JSON.stringify(nested)).toContain("context_rollover");
    const handoffs = () =>
      f.manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "pi-context-handoff");
    expect(handoffs()).toHaveLength(0);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
    // Model-only tools stay declared in both modes, including when `only` hides direct tools.
    const declared = f.requests[0]!.tools;
    expect(declared).toContain("context_rollover");
    expect(declared.includes("context_notes")).toBe(mode === "on");
    const codemodeDescription = f.requests[0]!.toolDefinitions?.find(
      (tool) => tool.name === "codemode",
    )?.description;
    expect(codemodeDescription).toBeDefined();
    expect(codemodeDescription).not.toContain("context_rollover");
    expect(codemodeDescription?.includes("context_notes")).toBe(mode === "only");
    // The direct call still checkpoints.
    f.responses.push(
      toolCall("context_rollover", { handoff: "Continue after the direct call." }),
      reply("Checkpointed."),
    );
    await f.session.prompt("Now roll over directly");
    expect(handoffs()).toHaveLength(1);
    expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    const first = f.requests[0]!;
    for (const request of f.requests) {
      expect(request.toolDefinitions).toEqual(first.toolDefinitions);
      expect(request.systemPrompt).toBe(first.systemPrompt);
    }
    expect(f.providerRequests).toEqual([]);
  }, 30_000);
}

for (const position of ["before"]) {
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
      { keepRecentTokens: 500, contextSettings: { tailTokens: 500 } },
    );
    f.responses.push(
      toolCall("todo", { action: "add", title: "Task alongside MCP" }),
      reply("Ready."),
    );
    await f.session.prompt("OLD-ONLY " + "discard ".repeat(12_000));
    f.manager.appendCustomMessageEntry(
      "fixture-mcp-prompt",
      "Encoded prompt " + "recent ".repeat(400),
      false,
    );
    f.session.refreshContext();
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
