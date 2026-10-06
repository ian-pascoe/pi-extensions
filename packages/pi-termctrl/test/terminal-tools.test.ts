import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
import {
  createTerminalListTool,
  createTerminalSendTool,
  createTerminalStartTool,
  createTerminalStopTool,
  createTerminalWaitTool,
  type TerminalToolRuntime,
} from "../src/terminal-tools.js";
import { FakeDriverFactory, type FakeTerminal } from "./fake-driver.js";

/** Whether the fake session has a message queued, for `terminal_wait`. */
let pendingMessages = false;
/** The session's working directory; `terminal_start` checks that it exists. */
let workDir: string;

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "pi-termctrl-tools-")));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function toolContext(owner: string): ExtensionToolContext {
  const context = {
    get cwd() {
      return workDir;
    },
    sessionManager: { getSessionId: () => owner },
    hasPendingMessages: () => pendingMessages,
  };
  // SAFETY: the Terminal tools read only `cwd`, `sessionManager.getSessionId()` and
  // `hasPendingMessages()` from the context.
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
  readonly wait: ReturnType<typeof createTerminalWaitTool>;
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
    wait: createTerminalWaitTool({ registry, exitTailLines: () => 2 }),
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
  pendingMessages = false;
  harness = createHarness();
});

afterEach(async () => {
  vi.useRealTimers();
  await TermctrlRegistry.teardownForTests();
});

/** Real timers, kept so a call's real file I/O can finish without moving the fake clock. */
const realSetTimeout = globalThis.setTimeout;

async function timed<T>(run: Promise<T>): Promise<{ readonly value: T; readonly elapsed: number }> {
  const startedAt = Date.now();
  let settled: { value: T } | undefined;
  void run.then((value) => {
    settled = { value };
  });
  while (settled === undefined) {
    // Move the fake clock only while something waits on it; otherwise the call is in real I/O.
    if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(10);
    else await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
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
      cwd: workDir,
      viewport: { cols: 100, rows: 30 },
    });
    expect(result.structuredContent).toEqual({
      id: "t1",
      state: "running",
      settle_reason: "quiet",
      changed: true,
      screen: ">>> ",
      scrolled_off: "",
    });
    expect(textOf(result)).toBe("t1 running · settled: quiet\n--- screen ---\n>>> ");
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
    expect(textOf(value)).toContain("t1 exited with code 3 · settled: exited");
  });

  test("a Terminal seen running still sends an Exit notification when it exits later", async () => {
    const delivered: string[] = [];
    harness.runtime.registry.bindOwner("root", (notices) => {
      delivered.push(...notices.map((notice) => notice.id));
      return true;
    });
    const { result, terminal } = await startTerminal();
    expect(result.structuredContent).toMatchObject({ state: "running" });
    await timed(
      harness.send.execute("call", { id: "t1", text: "1\n" }, undefined, undefined, root),
    );

    terminal.exitWith({ code: 0, signal: null });
    await harness.runtime.registry.pollTerminals();
    await new Promise((resolve) => setImmediate(resolve));

    expect(delivered).toEqual(["t1"]);
  });
});

describe("terminal_start working directory", () => {
  test("resolves a relative cwd against the session's directory", async () => {
    await mkdir(join(workDir, "sub"), { recursive: true });
    await timed(
      harness.start.execute("call", { command: "ls", cwd: "sub" }, undefined, undefined, root),
    );
    expect(harness.drivers.terminal(0).request.cwd).toBe(join(workDir, "sub"));
  });

  test("a missing cwd errors with the resolved path and starts nothing", async () => {
    await expect(
      harness.start.execute(
        "call",
        { command: "ls", cwd: "nope/deeper" },
        undefined,
        undefined,
        root,
      ),
    ).rejects.toThrow(`Working directory does not exist: ${join(workDir, "nope", "deeper")}`);
    expect(harness.drivers.drivers.flatMap((driver) => driver.terminals)).toEqual([]);
    expect(harness.runtime.registry.entries()).toEqual([]);
  });

  test("a cwd that is a file errors with the resolved path", async () => {
    await writeFile(join(workDir, "file.txt"), "x");
    await expect(
      harness.start.execute("call", { command: "ls", cwd: "file.txt" }, undefined, undefined, root),
    ).rejects.toThrow(`Working directory is not a directory: ${join(workDir, "file.txt")}`);
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
    expect(textOf(value)).toContain("t1 running · settled: timeout · screen unchanged");
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

  test("returns every line that scrolled off since the previous result, including seen ones", async () => {
    const { result, terminal } = await startTerminal((self) => {
      self.logLines = ["one", "two", "three"];
      self.screen = "two\nthree";
    });
    expect(result.structuredContent).toMatchObject({ scrolled_off: "one" });
    terminal.onInput = (self) => {
      self.logLines.push("four", "five", "six");
      self.screen = "five\nsix";
    };
    const second = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(second.value.structuredContent).toMatchObject({ scrolled_off: "two\nthree\nfour" });
    expect(second.value.details.full_output_path).toBeUndefined();
  });

  test("leaves lines on the result's screen unread when output arrives before the log is read", async () => {
    // Each read of the log finds one line the captured screen did not show yet.
    const output = (self: FakeTerminal) => {
      self.logLines.push(String(self.logLines.length + 1));
    };
    const { result, terminal } = await startTerminal((self) => {
      self.logLines = ["1", "2"];
      self.screen = "1\n2";
      self.onLogs = output;
    });
    // Nothing has scrolled off the screen the agent was shown.
    expect(result.structuredContent).toMatchObject({ screen: "1\n2", scrolled_off: "" });
    terminal.onInput = (self) => {
      self.logLines = ["1", "2", "3", "4", "5"];
      self.screen = "4\n5";
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ screen: "4\n5", scrolled_off: "1\n2\n3" });
    terminal.onLogs = undefined;
    terminal.onInput = (self) => {
      self.logLines.push("7");
      self.screen = "6\n7";
    };
    const last = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(last.value.structuredContent).toMatchObject({ scrolled_off: "4\n5" });
    expect(last.value.structuredContent).not.toHaveProperty("output_missing");
  });

  test("reports a line rewritten after the agent saw it in its final form", async () => {
    const { result, terminal } = await startTerminal((self) => {
      self.logLines = ["Building..."];
      self.screen = "Building...";
    });
    expect(result.structuredContent).toMatchObject({ scrolled_off: "" });
    terminal.onInput = (self) => {
      self.logLines = ["Building... FAILED", "1", "2", "3"];
      self.screen = "2\n3";
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ scrolled_off: "Building... FAILED\n1" });
  });

  test("starts over when the log is reset, as by clear", async () => {
    const numbers = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
    const { result, terminal } = await startTerminal((self) => {
      self.logLines = numbers(1, 8);
      self.screen = numbers(4, 8).join("\n");
    });
    expect(result.structuredContent).toMatchObject({ scrolled_off: "1\n2\n3" });
    terminal.onInput = (self) => {
      self.logLines = numbers(101, 112);
      self.screen = numbers(108, 112).join("\n");
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({
      scrolled_off: numbers(101, 107).join("\n"),
      output_missing: true,
    });
    expect(textOf(value)).toMatch(
      /\n\n\[Earlier output is missing: termctrl keeps limited scrollback/u,
    );
  });

  test("keeps its place when termctrl trims scrollback it already reported", async () => {
    const numbers = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
    const { terminal } = await startTerminal((self) => {
      self.logLines = numbers(1, 10);
      self.screen = numbers(6, 10).join("\n");
    });
    // termctrl drops 1-4, cutting into the anchor (1-5) but not into unreported lines.
    terminal.onInput = (self) => {
      self.logLines = numbers(5, 13);
      self.screen = numbers(9, 13).join("\n");
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ scrolled_off: "6\n7\n8" });
    expect(value.structuredContent).not.toHaveProperty("output_missing");
  });

  test("says output is missing when termctrl dropped lines the agent never received", async () => {
    const numbers = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
    const { terminal } = await startTerminal((self) => {
      self.logLines = numbers(1, 10);
      self.screen = numbers(6, 10).join("\n");
    });
    terminal.onInput = (self) => {
      self.logLines = numbers(50, 60);
      self.screen = numbers(56, 60).join("\n");
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({
      scrolled_off: numbers(50, 55).join("\n"),
      output_missing: true,
    });
  });

  test("says output is missing when a burst overflows before anything scrolled off", async () => {
    const { terminal } = await startTerminal((self) => {
      self.logLines = ["$ "];
      self.screen = "$ ";
    });
    terminal.onInput = (self) => {
      self.logLines = ["4998", "4999", "5000", "$ "];
      self.screen = "5000\n$ ";
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({
      scrolled_off: "4998\n4999",
      output_missing: true,
    });
  });

  test("a prompt line extended by typing is not missing output", async () => {
    const { terminal } = await startTerminal((self) => {
      self.logLines = ["$ "];
      self.screen = "$ ";
    });
    terminal.onInput = (self) => {
      self.logLines = ["$ seq 1 3", "1", "2", "3", "$ "];
      self.screen = "3\n$ ";
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ scrolled_off: "$ seq 1 3\n1\n2" });
    expect(value.structuredContent).not.toHaveProperty("output_missing");
  });

  test("fits large output into Pi's limits and saves every line to a full output file", async () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => `row ${index}`);
    const { terminal } = await startTerminal((self) => {
      self.logLines = [">>> "];
    });
    terminal.onInput = (self) => {
      self.logLines = [">>> ", ...rows, ">>> "];
      self.screen = "row 2999\n>>> ";
    };
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    const { scrolled_off: scrolled, screen, full_output_path: path } = value.details;
    expect(screen).toBe("row 2999\n>>> ");
    expect(scrolled.split("\n")).toEqual(rows.slice(1_001, 2_999));
    expect(path).toMatch(/pi-termctrl\/\d+-t1-output-\d+\.log$/u);
    expect(textOf(value)).toMatch(
      /--- screen ---\nrow 2999\n>>> \n\n\[Showing lines 1003-3002 of 3002 \(50\.0KB or 2000 line limit\)\. Full output: .+-t1-output-\d+\.log\]$/u,
    );
    expect(await readFile(path ?? "", "utf8")).toBe(`>>> \n${rows.join("\n")}\n>>> `);
  });

  test("keeps the bottom of a screen larger than Pi's limits", async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => `row ${index}`);
    const { result } = await startTerminal((self) => {
      self.logLines = ["earlier", ...rows];
      self.screen = rows.join("\n");
    });
    expect(result.details.scrolled_off).toBe("");
    expect(result.details.screen.split("\n")).toEqual(rows.slice(500));
    expect(textOf(result)).toContain("[Showing lines 502-2501 of 2501");
    expect(await readFile(result.details.full_output_path ?? "", "utf8")).toBe(
      ["earlier", ...rows].join("\n"),
    );
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

  test("points to the troubleshooting Skill when the driver is lost", async () => {
    await startTerminal();
    harness.drivers.latest.die();
    await expect(
      harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root),
    ).rejects.toThrow(`t1 was lost because the termctrl driver exited\n\n${TROUBLESHOOTING_HINT}`);
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

  test("input to an exited Terminal errors with its exit code and sends nothing", async () => {
    const { terminal } = await startTerminal();
    terminal.exitWith({ code: 3, signal: null });
    await expect(
      harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root),
    ).rejects.toThrow("t1 exited with code 3 and accepts no input");
    await expect(
      harness.send.execute("call", { id: "t1", keys: ["Enter"] }, undefined, undefined, root),
    ).rejects.toThrow("t1 exited with code 3 and accepts no input");
    expect(terminal.typed).toEqual([]);
    expect(terminal.pressed).toEqual([]);
  });

  test("input to a Terminal the exit watcher already recorded as exited errors too", async () => {
    const { terminal } = await startTerminal();
    terminal.exitWith({ code: 1, signal: null });
    await harness.runtime.registry.pollTerminals();
    await expect(
      harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root),
    ).rejects.toThrow("t1 exited with code 1 and accepts no input");
    expect(terminal.typed).toEqual([]);
  });

  test("input to an exited Terminal sends no deferred Exit notification", async () => {
    const delivered: string[] = [];
    harness.runtime.registry.bindOwner("root", (notices) => {
      delivered.push(...notices.map((notice) => notice.id));
      return false;
    });
    const { terminal } = await startTerminal();
    terminal.exitWith({ code: 1, signal: null });
    await harness.runtime.registry.pollTerminals();
    await expect(
      harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root),
    ).rejects.toThrow("accepts no input");
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered).toEqual([]);
  });

  test("input to a Terminal a signal ended names the signal", async () => {
    const { terminal } = await startTerminal();
    terminal.exitWith({ code: null, signal: "SIGTERM" });
    await expect(
      harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root),
    ).rejects.toThrow("t1 ended by SIGTERM and accepts no input");
  });

  test("polling an exited Terminal still returns its final screen", async () => {
    const { terminal } = await startTerminal();
    terminal.screen = "bye";
    terminal.exitWith({ code: 0, signal: null });
    const { value } = await timed(
      harness.send.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ state: "exited", exit_code: 0, screen: "bye" });
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

describe("terminal_send queueing", () => {
  /** A shell-like program: typed text appears on the screen as it lands. */
  function echoing(terminal: FakeTerminal): void {
    terminal.onInput = (self) => {
      self.screen = self.typed.join("|");
    };
  }

  async function startTerminals(count: number) {
    harness.drivers.onLaunch = (terminal) => {
      terminal.screen = ">>> ";
      terminal.lastOutputAt = Date.now() - 1_000;
      echoing(terminal);
    };
    for (let index = 0; index < count; index++) {
      await timed(
        harness.start.execute("call", { command: "python3" }, undefined, undefined, root),
      );
    }
  }

  const inputs = ["one", "two", "three", "four", "five"];

  function screensOf(results: readonly Awaited<ReturnType<typeof harness.send.execute>>[]) {
    return results.map(({ details }) => ({
      screen: details?.screen,
      scrolled_off: details?.scrolled_off,
      changed: details?.changed,
    }));
  }

  /** The message a call failed with, or "resolved". */
  async function failure(call: Promise<unknown>): Promise<string> {
    try {
      await call;
      return "resolved";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  test("five parallel sends to one Terminal return the screens of five sequential sends", async () => {
    await startTerminals(2);
    const sequential: Awaited<ReturnType<typeof harness.send.execute>>[] = [];
    for (const text of inputs) {
      const { value } = await timed(
        harness.send.execute("call", { id: "t2", text }, undefined, undefined, root),
      );
      sequential.push(value);
    }
    const { value: parallel } = await timed(
      Promise.all(
        inputs.map((text) =>
          harness.send.execute("call", { id: "t1", text }, undefined, undefined, root),
        ),
      ),
    );
    expect(harness.drivers.terminal(0).typed).toEqual(inputs);
    expect(screensOf(parallel)).toEqual(screensOf(sequential));
    expect(screensOf(parallel).map((entry) => entry.screen)).toEqual([
      "one",
      "one|two",
      "one|two|three",
      "one|two|three|four",
      "one|two|three|four|five",
    ]);
  });

  test("sends to different Terminals run concurrently", async () => {
    await startTerminals(2);
    busy(harness.drivers.terminal(0));
    busy(harness.drivers.terminal(1));
    const { elapsed } = await timed(
      Promise.all([
        harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root),
        harness.send.execute("call", { id: "t2", text: "b" }, undefined, undefined, root),
      ]),
    );
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(600);
  });

  test("calls to one Terminal wait for the previous call to settle", async () => {
    await startTerminals(1);
    const terminal = harness.drivers.terminal(0);
    busy(terminal);
    const { elapsed } = await timed(
      Promise.all([
        harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root),
        harness.send.execute("call", { id: "t1", text: "b" }, undefined, undefined, root),
      ]),
    );
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(1_100);
  });

  test("aborting a queued call removes it without affecting the running one", async () => {
    await startTerminals(1);
    const terminal = harness.drivers.terminal(0);
    busy(terminal);
    const controller = new AbortController();
    const running = harness.send.execute(
      "call",
      { id: "t1", text: "a" },
      undefined,
      undefined,
      root,
    );
    const queued = harness.send.execute(
      "call",
      { id: "t1", text: "b" },
      controller.signal,
      undefined,
      root,
    );
    const last = harness.send.execute("call", { id: "t1", text: "c" }, undefined, undefined, root);
    const outcome = failure(queued);
    setTimeout(() => controller.abort(), 100);
    const { value, elapsed } = await timed(Promise.all([running, outcome, last]));
    const [first, message, third] = value;
    expect(message).toContain("cancelled before it started");
    expect(first.structuredContent).toMatchObject({ settle_reason: "timeout", screen: "a" });
    expect(third.structuredContent).toMatchObject({ screen: "a|c" });
    expect(terminal.typed).toEqual(["a", "c"]);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(1_100);
  });

  test("a queued send to a Terminal that exited meanwhile reports the exit", async () => {
    await startTerminals(1);
    const terminal = harness.drivers.terminal(0);
    terminal.onInput = (self) => self.exitWith({ code: 0, signal: null });
    const first = harness.send.execute(
      "call",
      { id: "t1", text: "quit" },
      undefined,
      undefined,
      root,
    );
    const second = harness.send.execute(
      "call",
      { id: "t1", text: "more" },
      undefined,
      undefined,
      root,
    );
    const outcome = failure(second);
    const { value } = await timed(Promise.all([first, outcome]));
    expect(value[0].structuredContent).toMatchObject({ state: "exited", exit_code: 0 });
    expect(value[1]).toContain("t1 exited with code 0 and accepts no input");
    expect(terminal.typed).toEqual(["quit"]);
  });

  test("aborting a queued stop leaves the Terminal running", async () => {
    await startTerminals(1);
    const terminal = harness.drivers.terminal(0);
    busy(terminal);
    const controller = new AbortController();
    const send = harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root);
    const stop = harness.stop.execute("call", { id: "t1" }, controller.signal, undefined, root);
    const outcome = failure(stop);
    setTimeout(() => controller.abort(), 100);
    const { value } = await timed(Promise.all([send, outcome]));
    expect(value[1]).toContain("cancelled before it started");
    expect(terminal.stopCalls).toBe(0);
    expect(harness.runtime.registry.entries()).toHaveLength(1);
  });

  test("stop waits for a running send before taking its final snapshot", async () => {
    await startTerminals(1);
    const terminal = harness.drivers.terminal(0);
    busy(terminal);
    const send = harness.send.execute("call", { id: "t1", text: "a" }, undefined, undefined, root);
    const stop = harness.stop.execute("call", { id: "t1" }, undefined, undefined, root);
    const { value } = await timed(Promise.all([send, stop]));
    expect(value[0].structuredContent).toMatchObject({ screen: "a" });
    expect(value[1].structuredContent).toMatchObject({ kind: "terminal", state: "exited" });
  });
});

describe("settle reason", () => {
  test("is matched when wait_for_text is found", async () => {
    const { terminal } = await startTerminal();
    busy(terminal);
    terminal.onInput = (self) => {
      self.screen = "Build finished";
    };
    const { value } = await timed(
      harness.send.execute(
        "call",
        { id: "t1", text: "make\n", wait_for_text: "finished", wait_ms: 5_000 },
        undefined,
        undefined,
        root,
      ),
    );
    expect(value.structuredContent).toMatchObject({ settle_reason: "matched" });
    expect(textOf(value)).toContain("t1 running · settled: matched");
    expect(textOf(value)).not.toContain("was not seen");
  });

  test("is timeout when wait_ms runs out, and an unmatched wait_for_text says it was not seen", async () => {
    const { terminal } = await startTerminal();
    busy(terminal);
    const { value } = await timed(
      harness.send.execute(
        "call",
        {
          id: "t1",
          text: "make\n",
          wait_for_text: "/never[0-9]+/",
          wait_ms: 1_000,
        },
        undefined,
        undefined,
        root,
      ),
    );
    expect(value.structuredContent).toMatchObject({ settle_reason: "timeout" });
    expect(textOf(value)).toContain("t1 running · settled: timeout");
    expect(textOf(value)).toContain(
      'wait_for_text "/never[0-9]+/" was not seen before the wait ended.',
    );
  });

  test("is timeout for a terminal_start whose output never pauses", async () => {
    harness.drivers.onLaunch = busy;
    const { value } = await timed(
      harness.start.execute("call", { command: "yes" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ settle_reason: "timeout" });
    expect(textOf(value)).toContain("t1 running · settled: timeout");
    expect(textOf(value)).not.toContain("was not seen");
  });

  test("is quiet when the screen stops changing", async () => {
    await startTerminal();
    const { value } = await timed(
      harness.send.execute("call", { id: "t1", text: "x" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ settle_reason: "quiet" });
    expect(textOf(value)).toContain("settled: quiet");
  });

  test("is exited when the process exits, including a poll of an exited Terminal", async () => {
    const { terminal } = await startTerminal();
    terminal.onInput = (self) => {
      self.exitWith({ code: 0, signal: null });
    };
    const { value } = await timed(
      harness.send.execute(
        "call",
        { id: "t1", text: "exit\n", wait_for_text: "never" },
        undefined,
        undefined,
        root,
      ),
    );
    expect(value.structuredContent).toMatchObject({
      state: "exited",
      settle_reason: "exited",
    });
    expect(textOf(value)).toContain("t1 exited with code 0 · settled: exited");

    const poll = await timed(
      harness.send.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(poll.value.structuredContent).toMatchObject({
      settle_reason: "exited",
    });
  });

  test("is reported by a poll for output as quiet, and as timeout when nothing arrives under constant output", async () => {
    const { terminal } = await startTerminal();
    terminal.reportsIdle = false;
    setTimeout(() => {
      terminal.screen = ">>> tick";
    }, 1_000);
    const active = await timed(
      harness.send.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(active.value.structuredContent).toMatchObject({
      settle_reason: "quiet",
    });

    busy(terminal);
    const idle = await timed(
      harness.send.execute("call", { id: "t1", wait_ms: 1_000 }, undefined, undefined, root),
    );
    expect(idle.value.structuredContent).toMatchObject({
      settle_reason: "timeout",
    });
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
      scrolled_off: ">>> \nolder",
    });
    expect(textOf(value)).toBe(
      "Terminal t1 stopped.\n--- scrolled off ---\n>>> \nolder\n--- final screen ---\n>>> exit()",
    );
    expect(harness.runtime.registry.entries()).toEqual([]);
  });

  test("stopping a running Terminal whose screen the agent saw omits the screen", async () => {
    const { terminal } = await startTerminal();
    terminal.screen = "ready";
    await timed(harness.send.execute("call", { id: "t1" }, undefined, undefined, root));
    const { value } = await timed(
      harness.stop.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(terminal.stopCalls).toBe(1);
    expect(value.structuredContent).toEqual({
      id: "t1",
      kind: "terminal",
      state: "exited",
      signal: "SIGKILL",
      changed: false,
    });
    expect(textOf(value)).toBe(
      "Terminal t1 stopped.\nIts screen is unchanged since your last result.",
    );
    expect(harness.runtime.registry.entries()).toEqual([]);
  });

  test("stopping a running Terminal with an unchanged screen still reports lines that scrolled off unseen", async () => {
    const { terminal } = await startTerminal((self) => {
      self.logLines = ["one", "two"];
      self.screen = "two";
    });
    await timed(harness.send.execute("call", { id: "t1" }, undefined, undefined, root));
    terminal.logLines = ["one", "two", "three"];
    const { value } = await timed(
      harness.stop.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ changed: false, scrolled_off: "two" });
    expect(value.structuredContent).not.toHaveProperty("screen");
  });

  test("stopping an exited Terminal whose screen the agent saw omits the screen", async () => {
    const { terminal } = await startTerminal();
    terminal.screen = "bye";
    terminal.exitWith({ code: 2, signal: null });
    await timed(harness.send.execute("call", { id: "t1" }, undefined, undefined, root));
    const { value } = await timed(
      harness.stop.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toEqual({
      id: "t1",
      kind: "terminal",
      state: "exited",
      exit_code: 2,
      changed: false,
    });
    expect(textOf(value)).toBe(
      "Terminal t1 had already exited with code 2; removed.\nIts screen is unchanged since your last result.",
    );
    expect(harness.runtime.registry.entries()).toEqual([]);
  });

  test("stopping an exited Terminal still reports lines that scrolled off unseen", async () => {
    const { terminal } = await startTerminal((self) => {
      self.logLines = ["one", "two"];
      self.screen = "two";
    });
    // A second running Terminal keeps the driver open, so the exited one's log stays readable.
    await timed(harness.start.execute("call", { command: "sleep 9" }, undefined, undefined, root));
    terminal.screen = "two";
    terminal.exitWith({ code: 0, signal: null });
    await timed(harness.send.execute("call", { id: "t1" }, undefined, undefined, root));
    terminal.logLines = ["one", "two", "three"];
    const { value } = await timed(
      harness.stop.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({ changed: false, scrolled_off: "two" });
    expect(value.structuredContent).not.toHaveProperty("screen");
  });

  test("stopping an exited Terminal the agent has not seen since it changed shows the screen", async () => {
    const { terminal } = await startTerminal();
    terminal.screen = "bye";
    terminal.exitWith({ code: 2, signal: null });
    await harness.runtime.registry.pollTerminals();
    const { value } = await timed(
      harness.stop.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    expect(value.structuredContent).toMatchObject({
      state: "exited",
      exit_code: 2,
      changed: true,
      screen: "bye",
    });
    expect(textOf(value)).toContain("--- final screen ---\nbye");
  });

  test("a stopped Terminal's full output file lasts until its session shuts down", async () => {
    const rows = Array.from({ length: 2_100 }, (_, index) => `row ${index}`);
    const { terminal } = await startTerminal();
    terminal.logLines = [...rows, ">>> "];
    terminal.screen = ">>> ";
    const { value } = await timed(
      harness.stop.execute("call", { id: "t1" }, undefined, undefined, root),
    );
    const path = value.details.full_output_path ?? "";
    expect(textOf(value)).toContain(`Full output: ${path}]`);
    expect(existsSync(path)).toBe(true);
    await harness.runtime.registry.shutdownOwner("child");
    expect(existsSync(path)).toBe(true);
    await harness.runtime.registry.shutdownOwner("root");
    expect(existsSync(path)).toBe(false);
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

describe("terminal_wait", () => {
  function job(command: string, output = "") {
    return harness.runtime.registry.createJob("root", command, (id) => ({
      logPath: `/tmp/pi-termctrl/${id}.log`,
      stop: () => {},
      tail: () => output,
      removeLog: async () => {},
    }));
  }

  function collectDeliveries(): string[] {
    const delivered: string[] = [];
    harness.runtime.registry.bindOwner("root", (notices) => {
      delivered.push(...notices.map((notice) => notice.id));
      return true;
    });
    return delivered;
  }

  async function flushNotifications(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  test("returns at the first exit with its output and log, and what is still running", async () => {
    const delivered = collectDeliveries();
    job("npm test", "one\ntwo\nthree\n");
    job("sleep 100");
    const waiting = harness.wait.execute("call", {}, undefined, undefined, root);
    await vi.advanceTimersByTimeAsync(1_000);
    harness.runtime.registry.jobExited("b1", { code: 1, signal: null });
    const value = await waiting;
    await flushNotifications();

    expect(value.structuredContent).toEqual({
      reason: "exited",
      exited: [
        {
          id: "b1",
          kind: "background_job",
          command: "npm test",
          exit_code: 1,
          duration_ms: 1_000,
          output: "two\nthree",
          log_path: "/tmp/pi-termctrl/b1.log",
        },
      ],
      running: [{ id: "b2", kind: "background_job", command: "sleep 100", age_seconds: 1 }],
    });
    expect(textOf(value)).toBe(
      "Background job b1 exited with code 1 after 1s: npm test\nLog: /tmp/pi-termctrl/b1.log\nLast lines of output:\ntwo\nthree\n\nStill running:\nb2 running · 1s · sleep 100 · log /tmp/pi-termctrl/b2.log",
    );
    expect(delivered).toEqual([]);
    expect(harness.runtime.registry.get("b1")?.seen).toBe(true);
  });

  test("a Terminal's exit, found by the exit watcher, ends the wait", async () => {
    const delivered = collectDeliveries();
    const { terminal } = await startTerminal();
    const waiting = harness.wait.execute("call", { ids: ["t1"] }, undefined, undefined, root);
    await vi.advanceTimersByTimeAsync(500);
    terminal.screen = "bye";
    terminal.exitWith({ code: 0, signal: null });
    await harness.runtime.registry.pollTerminals();
    const value = await waiting;
    await flushNotifications();

    expect(value.structuredContent).toMatchObject({
      reason: "exited",
      exited: [{ id: "t1", kind: "terminal", exit_code: 0, output: "bye" }],
      running: [],
    });
    expect(textOf(value)).toContain('terminal_send {"id": "t1"} returns its final screen.');
    expect(delivered).toEqual([]);
  });

  test("an exit after the wait timed out still sends an Exit notification", async () => {
    const delivered = collectDeliveries();
    job("sleep 100");
    const { value, elapsed } = await timed(
      harness.wait.execute("call", { wait_ms: 3_000 }, undefined, undefined, root),
    );
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThan(3_200);
    expect(value.structuredContent).toMatchObject({ reason: "timeout", exited: [] });
    expect(textOf(value)).toBe(
      "Nothing exited within 3s.\n\nStill running:\nb1 running · 3s · sleep 100 · log /tmp/pi-termctrl/b1.log",
    );

    harness.runtime.registry.jobExited("b1", { code: 0, signal: null });
    await flushNotifications();
    expect(delivered).toEqual(["b1"]);
  });

  test("returns early when a message is queued, and clamps wait_ms to 5 minutes", async () => {
    job("sleep 100");
    const startedAt = Date.now();
    const waiting = harness.wait.execute(
      "call",
      { wait_ms: 3_600_000 },
      undefined,
      undefined,
      root,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    pendingMessages = true;
    await vi.advanceTimersByTimeAsync(100);
    const value = await waiting;
    expect(Date.now() - startedAt).toBe(2_100);
    expect(value.structuredContent).toMatchObject({ reason: "message", exited: [] });

    pendingMessages = false;
    const clamped = await timed(harness.wait.execute("call", {}, undefined, undefined, root));
    expect(clamped.elapsed).toBeGreaterThanOrEqual(300_000);
    expect(clamped.elapsed).toBeLessThan(300_200);
  });

  test("returns when the call is aborted", async () => {
    job("sleep 100");
    const controller = new AbortController();
    const waiting = harness.wait.execute("call", {}, controller.signal, undefined, root);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    const value = await waiting;
    expect(value.structuredContent).toMatchObject({ reason: "aborted" });
  });

  test("reports an exit whose notification is still queued instead of notifying", async () => {
    const delivered = collectDeliveries();
    job("make", "built");
    harness.runtime.registry.jobExited("b1", { code: 0, signal: null });
    const { value, elapsed } = await timed(
      harness.wait.execute("call", {}, undefined, undefined, root),
    );
    await flushNotifications();
    expect(elapsed).toBeLessThanOrEqual(10);
    expect(value.structuredContent).toMatchObject({ reason: "exited", exited: [{ id: "b1" }] });
    expect(delivered).toEqual([]);
  });

  test("with nothing running returns at once, and rejects unknown or foreign ids", async () => {
    const { value } = await timed(harness.wait.execute("call", {}, undefined, undefined, root));
    expect(value.structuredContent).toEqual({ reason: "nothing_running", exited: [], running: [] });
    expect(textOf(value)).toBe(
      "Nothing to wait for: you have no running Terminals or Background jobs.",
    );

    harness.runtime.registry.createJob("child", "sleep 100", (id) => ({
      logPath: `/tmp/pi-termctrl/${id}.log`,
      stop: () => {},
      tail: () => "",
      removeLog: async () => {},
    }));
    await expect(
      harness.wait.execute("call", { ids: ["b1"] }, undefined, undefined, root),
    ).rejects.toThrow("Unknown id b1");
  });
});
