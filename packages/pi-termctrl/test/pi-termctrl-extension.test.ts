import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { EXIT_NOTIFICATION_TYPE } from "../src/exit-notification.js";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";
import { createSdkFixture, disposeSdkFixtures, settle } from "./sdk-fixture.js";

const available = { kind: "available", path: "/fake/termctrl" } as const;

function toolNames(fixture: Awaited<ReturnType<typeof createSdkFixture>>): string[] {
  return fixture.session.getActiveToolNames();
}

function plain(text: string | undefined): string | undefined {
  return text === undefined ? undefined : stripVTControlCharacters(text);
}

function toolResultText(messages: readonly Message[], toolName: string): string {
  const result = messages.find(
    (message) => message.role === "toolResult" && message.toolName === toolName,
  );
  if (result?.role !== "toolResult") return "";
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

beforeAll(() => {
  // The footer status draws with Pi's global theme.
  initTheme("dark");
});

afterEach(async () => {
  await disposeSdkFixtures();
  await TermctrlRegistry.teardownForTests();
});

describe("tool registration", () => {
  test("without a binary registers no Terminal tools and reports one diagnostic", async () => {
    const fixture = await createSdkFixture();
    expect(toolNames(fixture)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "terminal_stop",
      "terminal_list",
      "terminal_wait",
    ]);
    expect(fixture.notifications).toEqual([
      "Termctrl: Terminal tools are unavailable: test has no binary\nRun /skill:pi-termctrl to diagnose.",
    ]);
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
    // Scripts get the typed background result: `exit_code` optional, `background` added.
    expect(declared).toMatch(
      /resolves to `\{ [^`]*\bexit_code\?, [^`]*\bbackground\?: \{ id, log_path \} \}`/u,
    );

    const text = toolResultText(fixture.turns[1]?.messages ?? [], "codemode");
    expect(text).toContain('"id":"b1"');
    expect(text).toContain('"exit":"none"');
    expect(text).toContain('"output":"early\\n"');
    expect(text).toContain(`pi-termctrl/${process.pid}-b1.log`);
  });
});

describe("Exit notifications during an agent run", () => {
  /**
   * A tool that ends Background job b1, then yields long enough for a queued Exit notification to
   * flush. It runs sequentially, so a later tool call in the same message starts after it.
   */
  const finishJob: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "finish_job",
      label: "finish_job",
      description: "Test tool: end Background job b1.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        TermctrlRegistry.current()?.jobExited("b1", { code: 0, signal: null });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { content: [{ type: "text", text: "ended" }], details: {} };
      },
    });
  };

  async function fixtureWithJob() {
    const fixture = await createSdkFixture({
      binary: available,
      createDriver: new FakeDriverFactory().create,
      extraFactories: [finishJob],
    });
    const owner = fixture.session.sessionManager.getSessionId();
    TermctrlRegistry.current()?.createJob(owner, "make", (id) => ({
      logPath: `/tmp/pi-termctrl/${id}.log`,
      stop: () => {},
      tail: () => "built",
      removeLog: async () => {},
    }));
    return fixture;
  }

  function exitNotifications(fixture: Awaited<ReturnType<typeof createSdkFixture>>) {
    return fixture.session.messages.filter(
      (message) => message.role === "custom" && message.customType === EXIT_NOTIFICATION_TYPE,
    );
  }

  test("an exit no tool reports reaches the agent at the end of the turn", async () => {
    const fixture = await fixtureWithJob();
    fixture.responses.push(
      fauxAssistantMessage(fauxToolCall("finish_job", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Noted."),
    );
    await fixture.session.prompt("Finish the job");
    await settle(fixture.session);

    expect(fixture.turns).toHaveLength(2);
    expect(JSON.stringify(fixture.turns[1]?.messages.at(-1))).toContain(
      "Background job b1 exited with code 0",
    );
    expect(exitNotifications(fixture)).toHaveLength(1);
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
    expect(plain(fixture.statuses.at(-1))).toBe("\u25cf termctrl 1 running");

    await fixture.session.reload();
    expect(
      TermctrlRegistry.current()
        ?.entries()
        .map(({ id, state }) => [id, state]),
    ).toEqual([["t1", "running"]]);
    expect(toolNames(fixture)).toContain("terminal_send");
    expect(plain(fixture.statuses.at(-1))).toBe("\u25cf termctrl 1 running");

    await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(drivers.terminal(0).stopCalls).toBe(1);
    expect(TermctrlRegistry.current()?.entries()).toEqual([]);
    expect(fixture.statuses.at(-1)).toBeUndefined();
  });
});

describe("Queued Steer through Pi", () => {
  test("a steer typed while bash runs moves the call to the background without waiting for it", async () => {
    const fixture = await createSdkFixture();
    fixture.responses.push(
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo working; sleep 30" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Changing course."),
    );
    const startedAt = Date.now();
    const running = fixture.session.prompt("Run the slow command");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fixture.session.prompt("Actually, do something else", { streamingBehavior: "steer" });
    await running;
    await settle(fixture.session);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(toolResultText(fixture.turns[1]?.messages ?? [], "bash")).toContain(
      "Command moved to the background as b1 because a message was queued for you.",
    );
    expect(JSON.stringify(fixture.turns[1]?.messages.at(-1))).toContain(
      "Actually, do something else",
    );
  });

  test("a follow-up typed while bash runs does not move it", async () => {
    const fixture = await createSdkFixture();
    fixture.responses.push(
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo working; sleep 1.5" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Done."),
      fauxAssistantMessage("Then that."),
    );
    const running = fixture.session.prompt("Run the command");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fixture.session.prompt("After that, one more thing", { streamingBehavior: "followUp" });
    await running;
    await settle(fixture.session);

    const text = toolResultText(fixture.turns[1]?.messages ?? [], "bash");
    expect(text).toContain("working");
    expect(text).not.toContain("moved to the background");
  });
});
