/**
 * Cache proofs (plan step 7). Every case drives real Pi sessions offline; only the model stream is
 * scripted. Each captured turn holds the ordered tool definitions and the system prompt exactly as
 * Pi hands them to the provider, plus the full transcript. Where the configuration is unchanged,
 * the serialized tools and system prompt must be byte-equal from turn to turn, each earlier
 * transcript must be a prefix of the next, and no mid-conversation system message (which would
 * add, remove or patch tools or prompt sections) may appear.
 */
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT_NOTIFICATION_TYPE } from "../src/exit-notification.js";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";
import {
  createSdkFixture,
  disposeSdkFixtures,
  settle,
  type CapturedTurn,
  type SdkFixture,
} from "./sdk-fixture.js";

const available = { kind: "available", path: "/fake/termctrl" } as const;

afterEach(async () => {
  await disposeSdkFixtures();
  await TermctrlRegistry.teardownForTests();
});

function serializedTools(turn: CapturedTurn): string {
  return JSON.stringify(turn.tools);
}

function systemMessageCount(messages: readonly Message[]): number {
  return messages.filter((message) => message.role === "system").length;
}

/** Assert byte-equal tools and system prompt, and an append-only transcript, across all turns. */
function expectStablePrefix(turns: readonly CapturedTurn[], minimumTurns: number): void {
  expect(turns.length, "captured turns").toBeGreaterThanOrEqual(minimumTurns);
  const [first] = turns;
  if (first === undefined) throw new Error("no captured turns");
  expect(systemMessageCount(first.messages)).toBe(1);
  for (const [index, turn] of turns.entries()) {
    if (index === 0) continue;
    const previous = turns[index - 1];
    if (previous === undefined) throw new Error("missing previous turn");
    expect(serializedTools(turn), `tools of turn ${index}`).toBe(serializedTools(first));
    expect(turn.systemPrompt, `system prompt of turn ${index}`).toBe(first.systemPrompt);
    expect(
      JSON.stringify(turn.messages.slice(0, previous.messages.length)),
      `transcript prefix of turn ${index}`,
    ).toBe(JSON.stringify(previous.messages));
    expect(systemMessageCount(turn.messages), `system messages in turn ${index}`).toBe(1);
  }
}

function toolCallTurn(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

async function prompt(fixture: SdkFixture, text: string): Promise<void> {
  await fixture.session.prompt(text);
  await settle(fixture.session);
}

async function waitForTurns(fixture: SdkFixture, count: number, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (fixture.turns.length < count) {
    if (Date.now() > deadline)
      throw new Error(`expected ${count} turns, saw ${fixture.turns.length}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await settle(fixture.session);
}

function toolNamesOf(turn: CapturedTurn | undefined): string[] {
  return (turn?.tools ?? []).map(({ name }) => name);
}

describe("prefix stability", () => {
  test("consecutive turns keep tools, system prompt and history byte-stable", async () => {
    const fixture = await createSdkFixture({
      binary: available,
      createDriver: new FakeDriverFactory().create,
    });
    fixture.responses.push(fauxAssistantMessage("One."), fauxAssistantMessage("Two."));
    await prompt(fixture, "First");
    await prompt(fixture, "Second");
    expectStablePrefix(fixture.turns, 2);
    expect(toolNamesOf(fixture.turns[0])).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "terminal_start",
      "terminal_send",
      "terminal_stop",
      "terminal_list",
      "terminal_wait",
    ]);
  });

  test("/reload keeps tools, system prompt and history byte-stable", async () => {
    const fixture = await createSdkFixture({
      binary: available,
      createDriver: new FakeDriverFactory().create,
    });
    fixture.responses.push(fauxAssistantMessage("Before."), fauxAssistantMessage("After."));
    await prompt(fixture, "Before reload");
    await fixture.session.reload();
    await prompt(fixture, "After reload");
    expectStablePrefix(fixture.turns, 2);
  });

  test("starting and stopping a Terminal changes nothing in the prefix", async () => {
    const drivers = new FakeDriverFactory();
    const fixture = await createSdkFixture({ binary: available, createDriver: drivers.create });
    fixture.responses.push(
      toolCallTurn("terminal_start", { command: "python3", wait_ms: 0 }),
      fauxAssistantMessage("Started."),
      toolCallTurn("terminal_stop", { id: "t1" }),
      fauxAssistantMessage("Stopped."),
      fauxAssistantMessage("Idle."),
    );
    await prompt(fixture, "Start a REPL");
    expect(TermctrlRegistry.current()?.runningCount()).toBe(1);
    await prompt(fixture, "Stop it");
    expect(drivers.terminal(0).stopCalls).toBe(1);
    await prompt(fixture, "Anything else?");
    expectStablePrefix(fixture.turns, 5);
    expect(TermctrlRegistry.current()?.entries()).toEqual([]);
  });

  test("starting and stopping a Background job changes nothing in the prefix", async () => {
    const fixture = await createSdkFixture();
    fixture.responses.push(
      toolCallTurn("bash", { command: "echo begin; sleep 30", background: true }),
      fauxAssistantMessage("Backgrounded."),
      toolCallTurn("terminal_stop", { id: "b1" }),
      fauxAssistantMessage("Stopped."),
      fauxAssistantMessage("Idle."),
    );
    await prompt(fixture, "Run it in the background");
    expect(TermctrlRegistry.current()?.get("b1")?.state).toBe("running");
    await prompt(fixture, "Stop it");
    await prompt(fixture, "Anything else?");
    expectStablePrefix(fixture.turns, 5);
    expect(TermctrlRegistry.current()?.entries()).toEqual([]);
    expect(
      fixture.session.messages.some(
        (message) => message.role === "custom" && message.customType === EXIT_NOTIFICATION_TYPE,
      ),
    ).toBe(false);
  });

  test("terminal_wait reports a Background job's exit once, without an Exit notification", async () => {
    // No termctrl binary: terminal_wait is a management tool, available wherever jobs are.
    const fixture = await createSdkFixture();
    fixture.responses.push(
      toolCallTurn("bash", { command: "echo working; sleep 2.3; echo done", background: true }),
      toolCallTurn("terminal_wait", {}),
      fauxAssistantMessage("It finished."),
      fauxAssistantMessage("Idle."),
    );
    await prompt(fixture, "Run the job and wait for it");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await prompt(fixture, "Anything else?");
    expectStablePrefix(fixture.turns, 4);
    const waitResult = JSON.stringify(fixture.turns[2]?.messages.at(-1));
    expect(waitResult).toContain("Background job b1 exited with code 0");
    expect(waitResult).toContain(`pi-termctrl/${process.pid}-b1.log`);
    expect(waitResult).toContain("done");
    expect(
      fixture.session.messages.some(
        (message) => message.role === "custom" && message.customType === EXIT_NOTIFICATION_TYPE,
      ),
    ).toBe(false);
  });

  test("an Exit notification's turn keeps the previous turn's tools and system prompt", async () => {
    const fixture = await createSdkFixture();
    fixture.responses.push(
      toolCallTurn("bash", { command: "echo working; sleep 2.3; echo done", background: true }),
      fauxAssistantMessage("Running."),
      fauxAssistantMessage("It finished."),
    );
    await prompt(fixture, "Start the job");
    expect(fixture.turns).toHaveLength(2);
    await waitForTurns(fixture, 3);
    expectStablePrefix(fixture.turns, 3);
    expect(JSON.stringify(fixture.turns[2]?.messages.at(-1))).toContain(
      "Background job b1 exited with code 0",
    );
  });
});

describe("configurations", () => {
  test("replaceBash: true is stable and declares bash with background", async () => {
    const fixture = await createSdkFixture({ settings: { termctrl: { replaceBash: true } } });
    fixture.responses.push(fauxAssistantMessage("One."), fauxAssistantMessage("Two."));
    await prompt(fixture, "First");
    await fixture.session.reload();
    await prompt(fixture, "Second");
    expectStablePrefix(fixture.turns, 2);
    const bash = fixture.turns[0]?.tools.find(({ name }) => name === "bash");
    expect(Object.keys(JSON.parse(JSON.stringify(bash?.parameters)).properties)).toEqual([
      "command",
      "timeout",
      "background",
    ]);
  });

  test("replaceBash: false is stable and declares Pi's built-in bash byte for byte", async () => {
    const fixture = await createSdkFixture({ settings: { termctrl: { replaceBash: false } } });
    fixture.responses.push(fauxAssistantMessage("One."), fauxAssistantMessage("Two."));
    await prompt(fixture, "First");
    await fixture.session.reload();
    await prompt(fixture, "Second");
    expectStablePrefix(fixture.turns, 2);
    const builtin = createBashToolDefinition(fixture.cwd);
    const bash = fixture.turns[0]?.tools.find(({ name }) => name === "bash");
    expect(JSON.stringify(bash)).toBe(
      JSON.stringify({
        name: builtin.name,
        description: builtin.description,
        parameters: builtin.parameters,
      }),
    );

    // With no binary and no replacement, the extension declares nothing: the provider sees
    // exactly what a session without Pi Termctrl sees.
    const bare = await createSdkFixture({ withTermctrl: false });
    bare.responses.push(fauxAssistantMessage("One."));
    await prompt(bare, "First");
    const [bareTurn] = bare.turns;
    if (bareTurn === undefined) throw new Error("bare session did not run");
    expect(serializedTools(bareTurn)).toBe(serializedTools(fixture.turns[0] ?? bareTurn));
    expect(bareTurn.systemPrompt.replaceAll(bare.cwd, "<cwd>")).toBe(
      fixture.turns[0]?.systemPrompt.replaceAll(fixture.cwd, "<cwd>"),
    );
  });

  test("bashTail defaults declare the tail limits and keep tools, prompt and history stable", async () => {
    const fixture = await createSdkFixture({ settings: { termctrl: { replaceBash: true } } });
    fixture.responses.push(
      toolCallTurn("bash", { command: "seq 1 5000" }),
      fauxAssistantMessage("Saw it."),
      fauxAssistantMessage("Again."),
    );
    await prompt(fixture, "Count");
    await fixture.session.reload();
    await prompt(fixture, "Anything else?");
    expectStablePrefix(fixture.turns, 3);
    const bash = fixture.turns[0]?.tools.find(({ name }) => name === "bash");
    expect(bash?.description).toContain("last 300 lines or 16.0KB");
    const result = fixture.turns[1]?.messages.find(({ role }) => role === "toolResult");
    const text = JSON.stringify(result?.content);
    expect(text).toContain("4701\\n4702");
    expect(text).not.toContain("4700\\n");
    expect(text).toContain("of 5000 (16.0KB or 300 line limit). Full output: ");
  });

  test("bashTail: false declares Pi's built-in bash byte for byte and keeps Pi's limits", async () => {
    const fixture = await createSdkFixture({
      settings: { termctrl: { replaceBash: true, bashTail: false } },
    });
    fixture.responses.push(
      toolCallTurn("bash", { command: "seq 1 5000" }),
      fauxAssistantMessage("Saw it."),
    );
    await prompt(fixture, "Count");
    expectStablePrefix(fixture.turns, 2);
    const builtin = createBashToolDefinition(fixture.cwd);
    const bash = fixture.turns[0]?.tools.find(({ name }) => name === "bash");
    expect(bash?.description).toBe(builtin.description);
    const text = JSON.stringify(
      fixture.turns[1]?.messages.find(({ role }) => role === "toolResult")?.content,
    );
    expect(text).toContain("3001\\n3002");
    expect(text).toContain("Showing lines 3001-5000 of 5000.");
  });

  test("codemode's declaration of bash is stable across turns, a job and reload", async () => {
    const fixture = await createSdkFixture({ codemode: true });
    fixture.responses.push(
      fauxAssistantMessage("One."),
      toolCallTurn("codemode", {
        code: 'const r = await tools.bash({ command: "echo x; sleep 30", background: true });\nawait tools.terminal_stop({ id: r.background.id });\nreturn r.background.id;',
      }),
      fauxAssistantMessage("Done."),
      fauxAssistantMessage("Three."),
    );
    await prompt(fixture, "First");
    await prompt(fixture, "Run and stop a job from a script");
    await fixture.session.reload();
    await prompt(fixture, "After reload");
    expectStablePrefix(fixture.turns, 4);
    const codemode = fixture.turns[0]?.tools.find(({ name }) => name === "codemode");
    const bash = fixture.turns[0]?.tools.find(({ name }) => name === "bash");
    const declared = `${codemode?.description ?? ""}\n${bash?.description ?? ""}`;
    // Scripts get the typed background result: `exit_code` optional, `background` added.
    expect(declared).toMatch(/resolves to `\{ [^`]*\bexit_code\?, [^`]*\bbackground\? \}`/u);
  });

  test("the binary-missing configuration is stable across turns and reload", async () => {
    const fixture = await createSdkFixture();
    fixture.responses.push(fauxAssistantMessage("One."), fauxAssistantMessage("Two."));
    await prompt(fixture, "First");
    await fixture.session.reload();
    await prompt(fixture, "Second");
    expectStablePrefix(fixture.turns, 2);
    expect(toolNamesOf(fixture.turns[0])).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "terminal_stop",
      "terminal_list",
      "terminal_wait",
    ]);
  });
});
