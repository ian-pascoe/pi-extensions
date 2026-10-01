import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT_NOTIFICATION_TYPE } from "../src/exit-notification.js";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";
import { createSdkFixture, disposeSdkFixtures, settle } from "./sdk-fixture.js";

const available = { kind: "available", path: "/fake/termctrl" } as const;

function toolNames(fixture: Awaited<ReturnType<typeof createSdkFixture>>): string[] {
  return fixture.session.getActiveToolNames();
}

function toolResultText(messages: readonly Message[], toolName: string): string {
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolName === toolName,
  );
  if (result?.role !== "toolResult") return "";
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

afterEach(async () => {
  await disposeSdkFixtures();
  await TermctrlRegistry.teardownForTests();
});

describe("tool registration", () => {
  test("registers all four Terminal tools and the bash replacement when the binary resolves", async () => {
    const drivers = new FakeDriverFactory();
    const fixture = await createSdkFixture({ binary: available, createDriver: drivers.create });
    expect(toolNames(fixture)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "terminal_start",
      "terminal_send",
      "terminal_stop",
      "terminal_list",
    ]);
    const bash = fixture.session.getToolDefinition("bash");
    expect(Object.keys(JSON.parse(JSON.stringify(bash?.parameters)).properties)).toEqual([
      "command",
      "timeout",
      "background",
    ]);
    expect(fixture.notifications).toEqual([]);
    expect(drivers.drivers).toEqual([]);
  });

  test("without a binary registers no Terminal tools and reports one diagnostic", async () => {
    const fixture = await createSdkFixture();
    expect(toolNames(fixture)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "terminal_stop",
      "terminal_list",
    ]);
    expect(fixture.notifications).toEqual([
      "Pi Termctrl: Terminal tools are unavailable: test has no binary",
    ]);
  });

  test("replaceBash: false leaves Pi's bash registered untouched", async () => {
    const fixture = await createSdkFixture({ settings: { termctrl: { replaceBash: false } } });
    expect(toolNames(fixture)).toEqual(["read", "bash", "edit", "write"]);
    const bash = fixture.session.getToolDefinition("bash");
    const builtin = createBashToolDefinition(fixture.cwd);
    expect(JSON.stringify(bash?.parameters)).toBe(JSON.stringify(builtin.parameters));
    expect(JSON.stringify(bash?.outputSchema)).toBe(JSON.stringify(builtin.outputSchema));
    expect(bash?.description).toBe(builtin.description);
    expect(
      fixture.session.extensionRunner
        .getAllRegisteredTools()
        .map(({ definition }) => definition.name),
    ).toEqual([]);
  });
});

describe("Background jobs through Pi", () => {
  test("a codemode script's bash({background: true}) gets the typed background result", async () => {
    const fixture = await createSdkFixture({ codemode: true });
    const bashDeclaration = fixture.session.getToolDefinition("bash");
    expect(JSON.stringify(bashDeclaration?.outputSchema)).toContain('"background"');
    fixture.responses.push(
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'const result = await tools.bash({ command: "echo early; sleep 3; echo late", background: true });\nreturn { id: result.background.id, log: result.background.log_path, exit: result.exit_code ?? "none", output: result.output };',
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Started."),
      fauxAssistantMessage("Noted the exit."),
    );
    await fixture.session.prompt("Run it in the background");
    await settle(fixture.session);

    const firstTurnTools = fixture.turns[0]?.tools ?? [];
    const codemode = firstTurnTools.find((tool) => tool.name === "codemode");
    const declared = `${codemode?.description ?? ""}\n${firstTurnTools.find((tool) => tool.name === "bash")?.description ?? ""}`;
    expect(declared).toContain("background?:");
    expect(declared).toMatch(/exit_code\?: number/u);

    const text = toolResultText(fixture.turns[1]?.messages ?? [], "codemode");
    expect(text).toContain('"id":"b1"');
    expect(text).toContain('"exit":"none"');
    expect(text).toContain('"output":"early\\n"');
    expect(text).toContain(`pi-termctrl/${process.pid}-b1.log`);
  });

  test("an Exit notification starts a turn while the agent is idle", async () => {
    const fixture = await createSdkFixture();
    fixture.responses.push(
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: "echo working; sleep 2.3; echo all done",
          background: true,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("It is running."),
      fauxAssistantMessage("The job finished."),
    );
    await fixture.session.prompt("Start the job");
    await settle(fixture.session);
    expect(fixture.turns).toHaveLength(2);
    expect(toolResultText(fixture.turns[1]?.messages ?? [], "bash")).toContain(
      "Command moved to the background as b1.",
    );

    const deadline = Date.now() + 5_000;
    while (fixture.turns.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await settle(fixture.session);
    expect(fixture.turns).toHaveLength(3);
    const notification = fixture.turns[2]?.messages.at(-1);
    expect(notification).toMatchObject({ role: "user" });
    const custom = fixture.session.messages.find(
      (message) => message.role === "custom" && message.customType === EXIT_NOTIFICATION_TYPE,
    );
    expect(custom).toMatchObject({
      role: "custom",
      display: true,
      details: { exits: [{ id: "b1", kind: "background_job", exit_code: 0, signal: null }] },
    });
    expect(JSON.stringify(notification)).toContain("Background job b1 exited with code 0");
    expect(JSON.stringify(notification)).toContain("all done");
  });
});

describe("lifecycle", () => {
  test("reload keeps live entries and their notifications; quit stops them", async () => {
    const drivers = new FakeDriverFactory();
    const fixture = await createSdkFixture({ binary: available, createDriver: drivers.create });
    fixture.responses.push(
      fauxAssistantMessage(fauxToolCall("terminal_start", { command: "python3", wait_ms: 0 }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Started."),
    );
    await fixture.session.prompt("Start a REPL");
    await settle(fixture.session);
    const registry = TermctrlRegistry.current();
    expect(registry?.entries().map(({ id, state }) => [id, state])).toEqual([["t1", "running"]]);
    expect(fixture.statuses.at(-1)).toBe("1 running");

    await fixture.session.reload();
    expect(
      TermctrlRegistry.current()
        ?.entries()
        .map(({ id, state }) => [id, state]),
    ).toEqual([["t1", "running"]]);
    expect(toolNames(fixture)).toContain("terminal_send");
    expect(fixture.statuses.at(-1)).toBe("1 running");

    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(drivers.terminal(0).stopCalls).toBe(1);
    expect(TermctrlRegistry.current()?.entries()).toEqual([]);
    expect(fixture.statuses.at(-1)).toBeUndefined();
  });
});
