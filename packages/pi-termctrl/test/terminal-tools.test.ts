import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import {
  createTerminalListTool,
  createTerminalSendTool,
  createTerminalStartTool,
  createTerminalStopTool,
  type TerminalToolRuntime,
} from "../src/terminal-tools.js";
import { FakeDriverFactory, type FakeTerminal } from "./fake-driver.js";

function toolContext(owner: string): ExtensionToolContext {
  const context = { cwd: "/work", sessionManager: { getSessionId: () => owner } };
  // SAFETY: the Terminal tools read only `cwd` and `sessionManager.getSessionId()` from the context.
  return context as ExtensionToolContext;
}

function textOf(result: { readonly content: readonly (TextContent | ImageContent)[] }): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

interface Harness {
  readonly drivers: FakeDriverFactory;
  readonly runtime: TerminalToolRuntime;
  readonly start: ReturnType<typeof createTerminalStartTool>;
  readonly send: ReturnType<typeof createTerminalSendTool>;
  readonly stop: ReturnType<typeof createTerminalStopTool>;
  readonly list: ReturnType<typeof createTerminalListTool>;
}

function createHarness(): Harness {
  const drivers = new FakeDriverFactory();
  const registry = TermctrlRegistry.acquire({
    createDriver: drivers.create,
    pollIntervalMs: 60_000,
  });
  const runtime: TerminalToolRuntime = {
    registry,
    shell: () => ({ shell: "/bin/bash", args: ["-c"], commandPrefix: "shopt -s expand_aliases" }),
    viewport: () => ({ cols: 100, rows: 30 }),
  };
  return {
    drivers,
    runtime,
    start: createTerminalStartTool(runtime),
    send: createTerminalSendTool(runtime),
    stop: createTerminalStopTool(registry),
    list: createTerminalListTool(registry),
  };
}

/** A Terminal whose output never stops, so only the wait budget can end a wait. */
function busy(terminal: FakeTerminal): void {
  terminal.alwaysBusy = true;
}

let harness: Harness;
const root = toolContext("root");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  harness = createHarness();
});

afterEach(async () => {
  vi.useRealTimers();
  await TermctrlRegistry.teardownForTests();
});

async function timed<T>(run: Promise<T>): Promise<{ readonly value: T; readonly elapsed: number }> {
  const startedAt = Date.now();
  let settled: { value: T } | undefined;
  void run.then((value) => {
    settled = { value };
  });
  while (settled === undefined) await vi.advanceTimersByTimeAsync(10);
  return { value: settled.value, elapsed: Date.now() - startedAt };
}

async function startTerminal(prepare?: (terminal: FakeTerminal) => void) {
  harness.drivers.onLaunch = (terminal) => {
    terminal.screen = ">>> ";
    terminal.lastOutputAt = Date.now() - 1_000;
    prepare?.(terminal);
  };
  const { value } = await timed(
    harness.start.execute("call", { command: "python3" }, undefined, undefined, root),
  );
  return { result: value, terminal: harness.drivers.terminal(0) };
}

describe("terminal_start", () => {
  test("runs the command through Pi's shell with the prefix, cwd and viewport", async () => {
    const { result, terminal } = await startTerminal();
    expect(terminal.request).toEqual({
      id: "t1",
      command: ["/bin/bash", "-c", "shopt -s expand_aliases\npython3"],
      cwd: "/work",
      viewport: { cols: 100, rows: 30 },
    });
    expect(result.structuredContent).toEqual({
      id: "t1",
      state: "running",
      changed: true,
      screen: ">>> ",
      scrolled_off: "",
    });
    expect(textOf(result)).toBe("t1 running\n--- screen ---\n>>> ");
  });

  test("settles after 250 ms of quiet", async () => {
    harness.drivers.onLaunch = (terminal) => {
      terminal.reportsIdle = false;
      terminal.screen = "ready";
    };
    const { elapsed } = await timed(
      harness.start.execute("call", { command: "app" }, undefined, undefined, root),
    );
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(400);
  });

  test("waits 2 s by default and clamps wait_ms to 5 minutes", async () => {
    harness.drivers.onLaunch = busy;
    const byDefault = await timed(
      harness.start.execute("call", { command: "yes" }, undefined, undefined, root),
    );
    expect(byDefault.elapsed).toBeGreaterThanOrEqual(2_000);
    expect(byDefault.elapsed).toBeLessThan(2_100);

    const clamped = await timed(
      harness.start.execute(
        "call",
        { command: "yes", wait_ms: 3_600_000 },
        undefined,
        undefined,
        root,
      ),
    );
    expect(clamped.elapsed).toBeGreaterThanOrEqual(300_000);
    expect(clamped.elapsed).toBeLessThan(300_100);
  });

  test("returns as soon as the process exits", async () => {
    harness.drivers.onLaunch = (terminal) => {
      busy(terminal);
      terminal.screen = "bye";
      terminal.exitWith({ code: 3, signal: null });
    };
    const { value, elapsed } = await timed(
      harness.start.execute("call", { command: "false" }, undefined, undefined, root),
    );
    expect(elapsed).toBeLessThan(100);
    expect(value.structuredContent).toMatchObject({ state: "exited", exit_code: 3, screen: "bye" });
    expect(textOf(value)).toContain("t1 exited with code 3");
  });
});

describe("terminal_send", () => {
  test("types text, presses keys, and settles 500 ms by default under constant output", async () => {
    const { terminal } = await startTerminal();
    busy(terminal);
    const { value, elapsed } = await timed(
      harness.send.execute(
        "call",
        { id: "t1", text: "print(1)", keys: ["Enter", "Control+C"] },
        undefined,
        undefined,
        root,
      ),
    );
    expect(terminal.typed).toEqual(["print(1)"]);
    expect(terminal.pressed).toEqual([["Enter", "Control+C"]]);
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(600);
    expect(value.structuredContent).toMatchObject({ changed: false, state: "running" });
    expect(textOf(value)).toContain("t1 running · screen unchanged");
  });

  test("settles on a wait_for_text match, as a literal or a regex", async () => {
    const { terminal } = await startTerminal();
    busy(terminal);
    terminal.onInput = (self) => {
      setTimeout(() => {
        self.screen = "Build finished in 12s";
      }, 1_000);
    };
    const literal = await timed(
      harness.send.execute(
        "call",
        { id: "t1", text: "make\n", wait_for_text: "finished", wait_ms: 10_000 },
        undefined,
        undefined,
        root,
      ),
    );
    expect(literal.elapsed).toBeGreaterThanOrEqual(1_000);
    expect(literal.elapsed).toBeLessThan(1_100);

    terminal.screen = "";
    const regex = await timed(
      harness.send.execute(
        "call",
        { id: "t1", text: "make\n", wait_for_text: "/FINISHED in \\d+s/i", wait_ms: 10_000 },
        undefined,
        undefined,
        root,
      ),
    );
    expect(regex.elapsed).toBeLessThan(1_100);
    expect(regex.value.structuredContent).toMatchObject({ screen: "Build finished in 12s" });
  });

  test("a poll waits up to 30 s for new output, then settles on quiet", async () => {
    const { terminal } = await startTerminal();
    const quietPoll = await timed(
      harness.send.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(quietPoll.elapsed).toBeGreaterThanOrEqual(30_000);
    expect(quietPoll.elapsed).toBeLessThan(30_100);

    terminal.reportsIdle = false;
    setTimeout(() => {
      terminal.screen = ">>> tick";
    }, 5_000);
    const activePoll = await timed(
      harness.send.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(activePoll.elapsed).toBeGreaterThanOrEqual(5_250);
    expect(activePoll.elapsed).toBeLessThan(5_400);
    expect(activePoll.value.structuredContent).toMatchObject({ changed: true, screen: ">>> tick" });
  });

  test("returns only lines that scrolled off since the previous call, capped with a notice", async () => {
    const { terminal } = await startTerminal((self) => {
      self.logLines = ["one", "two", "three"];
      self.screen = "two\nthree";
    });
    terminal.onInput = (self) => {
      self.logLines.push("four", "five", "six");
      self.screen = "five\nsix";
    };
    const second = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(second.value.structuredContent).toMatchObject({ scrolled_off: "four" });

    terminal.onInput = (self) => {
      for (let line = 0; line < 500; line++) self.logLines.push(`row ${line}`);
      self.screen = "row 498\nrow 499";
    };
    const third = await timed(
      harness.send.execute("call", { id: "t1", text: "y" }, undefined, undefined, root),
    );
    const scrolled = third.value.details.scrolled_off;
    expect(scrolled.split("\n")[0]).toBe(
      "[298 earlier scrolled-off lines omitted (limit 200 lines or 16.0KB)]",
    );
    expect(scrolled.split("\n").at(-1)).toBe("row 497");
    expect(textOf(third.value)).toContain("--- scrolled off ---\n[298 earlier");
  });

  test("a wait_for_text match already on the screen counts only after the screen changes", async () => {
    const { terminal } = await startTerminal((self) => {
      self.screen = ">>> 6*7\n42\n>>> ";
    });
    busy(terminal);
    terminal.onInput = (self) => {
      setTimeout(() => {
        self.screen = ">>> 6*7\n42\n>>> 1+1\n2\n>>> ";
      }, 300);
    };
    const { value, elapsed } = await timed(
      harness.send.execute(
        "call",
        { id: "t1", text: "1+1\n", wait_for_text: "2", wait_ms: 5_000 },
        undefined,
        undefined,
        root,
      ),
    );
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(400);
    expect(value.structuredContent).toMatchObject({ screen: ">>> 6*7\n42\n>>> 1+1\n2\n>>> " });
  });

  test("rejects unknown keys before sending anything", async () => {
    const { terminal } = await startTerminal();
    await expect(
      harness.send.execute(
        "call",
        { id: "t1", text: "a", keys: ["Enter", "Ctrl+C", "F1"] },
        undefined,
        undefined,
        root,
      ),
    ).rejects.toThrow("Unknown keys: Ctrl+C, F1. Valid keys: Enter, Escape,");
    expect(terminal.typed).toEqual([]);
  });

  test("hides other sessions' Terminals and rejects input to Background jobs", async () => {
    await startTerminal();
    await expect(
      harness.send.execute("call", { id: "t1" }, undefined, undefined, toolContext("child")),
    ).rejects.toThrow("Unknown id t1");
    harness.runtime.registry.createJob("root", "sleep 9", () => ({
      logPath: "/tmp/b1.log",
      stop: () => {},
      tail: () => "",
      removeLog: async () => {},
    }));
    await expect(
      harness.send.execute("call", { id: "b1", text: "x" }, undefined, undefined, root),
    ).rejects.toThrow("b1 is a Background job, which accepts no input");
  });
});

describe("terminal_stop and terminal_list", () => {
  test("stop returns the final screen and forgets the Terminal", async () => {
    const { terminal } = await startTerminal((self) => {
      self.logLines = [">>> "];
    });
    terminal.logLines = [">>> ", "older", ">>> exit()"];
    terminal.screen = ">>> exit()";
    const { value } = await timed(
      harness.stop.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(terminal.stopCalls).toBe(1);
    expect(value.structuredContent).toEqual({
      id: "t1",
      kind: "terminal",
      state: "exited",
      signal: "SIGKILL",
      changed: true,
      screen: ">>> exit()",
      scrolled_off: "older",
    });
    expect(textOf(value)).toBe(
      "Terminal t1 stopped.\n--- scrolled off ---\nolder\n--- final screen ---\n>>> exit()",
    );
    expect(harness.runtime.registry.entries()).toEqual([]);
  });

  test("list shows Terminals and a separate background_jobs section", async () => {
    await startTerminal();
    harness.runtime.registry.createJob("root", "npm test", () => ({
      logPath: "/tmp/pi-termctrl/b1.log",
      stop: () => {},
      tail: () => "",
      removeLog: async () => {},
    }));
    harness.runtime.registry.jobExited("b1", { code: 0, signal: null });
    const { value } = await timed(harness.list.execute("call", {}, undefined, undefined, root));
    expect(value.structuredContent).toEqual({
      terminals: [{ id: "t1", command: "python3", state: "running", age_seconds: 0 }],
      background_jobs: [
        {
          id: "b1",
          command: "npm test",
          state: "exited",
          exit_code: 0,
          age_seconds: 0,
          log_path: "/tmp/pi-termctrl/b1.log",
        },
      ],
    });
    expect(textOf(value)).toBe(
      "Terminals:\nt1 running · 0s · python3\n\nBackground jobs:\nb1 exited with code 0 · 0s · npm test · log /tmp/pi-termctrl/b1.log",
    );
    expect(harness.runtime.registry.get("b1")?.seen).toBe(true);
  });
});
