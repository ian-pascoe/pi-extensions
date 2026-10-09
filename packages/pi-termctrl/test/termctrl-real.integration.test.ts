import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getShellConfig, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_TERMCTRL_SETTINGS } from "../src/pi-termctrl-settings.js";
import { resolveTermctrlBinary } from "../src/termctrl-binary.js";
import { createTermctrlDriver } from "../src/termctrl-driver.js";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import {
  createTerminalSendTool,
  createTerminalStartTool,
  createTerminalStopTool,
  parseWaitPattern,
  type TerminalToolRuntime,
} from "../src/terminal-tools.js";

const binary = resolveTermctrlBinary();
const packagedPlatform = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(
  `${process.platform}-${process.arch}`,
);

let directory: string;
const owner = "real-binary-test";

function toolContext(): ExtensionToolContext {
  const context = { cwd: directory, sessionManager: { getSessionId: () => owner } };
  // SAFETY: the Terminal tools read only `cwd` and `sessionManager.getSessionId()` from the context.
  return context as ExtensionToolContext;
}

function createTools() {
  if (binary.kind !== "available") throw new Error(binary.reason);
  const path = binary.path;
  const registry = TermctrlRegistry.acquire({ createDriver: () => createTermctrlDriver(path) });
  const shell = getShellConfig();
  const runtime: TerminalToolRuntime = {
    registry,
    shell: () => ({ shell: shell.shell, args: shell.args, commandPrefix: undefined }),
    viewport: () => ({ cols: 80, rows: 12 }),
    scrollback: () => DEFAULT_TERMCTRL_SETTINGS.scrollback,
  };
  return {
    registry,
    start: createTerminalStartTool(runtime),
    send: createTerminalSendTool(runtime),
    stop: createTerminalStopTool(runtime),
  };
}

type Tools = ReturnType<typeof createTools>;

/**
 * Wait, as an agent would, for a program to draw `pattern` (`wait_for_text` syntax). `terminal_start`
 * settles after 250 ms of quiet, which a program that is slow to start, as under load, can spend
 * still blank. The result is returned as is when its screen already shows the text; otherwise
 * `terminal_send` polls the Terminal for it.
 */
async function untilScreenShows(
  tools: Tools,
  context: ExtensionToolContext,
  result: { readonly details: { readonly id: string; readonly screen: string } },
  pattern: string,
) {
  if (parseWaitPattern(pattern)(result.details.screen)) return result;
  const polled = await tools.send.execute(
    "send",
    { id: result.details.id, wait_for_text: pattern, wait_ms: 10_000 },
    undefined,
    undefined,
    context,
  );
  return polled;
}

/** Create the file a test program is waiting for before it continues. */
function release(gate: string): Promise<void> {
  return writeFile(gate, "");
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-termctrl-real-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

afterEach(async () => {
  await TermctrlRegistry.teardownForTests();
});

test("a packaged termctrl binary resolves on supported platforms", () => {
  if (!packagedPlatform) return;
  expect(binary).toMatchObject({ kind: "available" });
});

describe.skipIf(binary.kind !== "available")("real termctrl binary", () => {
  test("drives a REPL", { timeout: 20_000 }, async () => {
    const tools = createTools();
    const context = toolContext();
    const started = await tools.start.execute(
      "start",
      { command: "node --interactive", wait_ms: 10_000 },
      undefined,
      undefined,
      context,
    );
    const prompt = await untilScreenShows(tools, context, started, ">");
    expect(prompt.details.screen).toContain(">");
    const answer = await tools.send.execute(
      "send",
      { id: "t1", text: "6 * 7\n", wait_for_text: "42", wait_ms: 10_000 },
      undefined,
      undefined,
      context,
    );
    expect(answer.details).toMatchObject({ state: "running", changed: true });
    expect(answer.details.screen).toContain("42");
    const exited = await tools.send.execute(
      "send",
      { id: "t1", text: ".exit\n", wait_ms: 10_000 },
      undefined,
      undefined,
      context,
    );
    expect(exited.details).toMatchObject({ state: "exited", exit_code: 0 });
  });

  test(
    "sends a Screen Delta from the previous prompt row in a REPL, growing and scrolling",
    { timeout: 30_000 },
    async () => {
      const tools = createTools();
      const context = toolContext();
      const send = (params: { text?: string; wait_for_text?: string; full_screen?: boolean }) =>
        tools.send.execute(
          "send",
          { id: "t1", wait_ms: 10_000, ...params },
          undefined,
          undefined,
          context,
        );
      const textOf = (result: { readonly content: readonly { type: string; text?: string }[] }) =>
        result.content[0]?.text ?? "";
      const started = await tools.start.execute(
        "start",
        { command: "python3 -q", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      await untilScreenShows(tools, context, started, ">>>");
      await send({ text: "1+1\n", wait_for_text: "/^2\\n>>>/m" });
      // Viewport rows are 12, so the later commands scroll the screen.
      for (let index = 3; index <= 8; index++) {
        const result = await send({ text: `${index}*1\n`, wait_for_text: `/^${index}\\n>>>/m` });
        expect(result.details.screen_from_row).toBeGreaterThan(1);
        expect(textOf(result)).toMatch(
          new RegExp(`rows above unchanged\\) ---\\n>>> ${index}\\*1\\n${index}\\n>>>`, "u"),
        );
      }
      const typed = await send({ text: "exi" });
      expect(textOf(typed)).toMatch(/rows above unchanged\) ---\n>>> exi$/u);
      expect(typed.details.cursor).toEqual({
        row: typed.details.screen.split("\n").length,
        column: 8,
      });
      const erased = await tools.send.execute(
        "send",
        { id: "t1", keys: ["Backspace", "Backspace", "Backspace"] },
        undefined,
        undefined,
        context,
      );
      expect(textOf(erased)).toMatch(/rows above unchanged\) ---\n>>>$/u);
      const cleared = await send({
        text: 'print(chr(27) + "[2J" + chr(27) + "[H", end="")\n',
        wait_for_text: "/^>>>$/",
      });
      expect(cleared.details).not.toHaveProperty("screen_from_row");
      expect(textOf(cleared)).toContain("--- screen ---\n>>>");
      await send({ text: "exit()\n" });
    },
  );

  test("handles an exited Terminal, cwd null and a missing cwd", { timeout: 20_000 }, async () => {
    const tools = createTools();
    const context = toolContext();
    const started = await tools.start.execute(
      "start",
      { command: "echo done; exit 4", cwd: null, wait_ms: 10_000 },
      undefined,
      undefined,
      context,
    );
    expect(started.details).toMatchObject({
      state: "exited",
      exit_code: 4,
      settle_reason: "exited",
    });
    await expect(
      tools.send.execute("send", { id: "t1", text: "x" }, undefined, undefined, context),
    ).rejects.toThrow("t1 exited with code 4 and accepts no input");
    const stopped = await tools.stop.execute("stop", { id: "t1" }, undefined, undefined, context);
    expect(stopped.details).toEqual({
      id: "t1",
      kind: "terminal",
      state: "exited",
      exit_code: 4,
      changed: false,
    });
    const missing = join(directory, "missing");
    await expect(
      tools.start.execute("start", { command: "ls", cwd: missing }, undefined, undefined, context),
    ).rejects.toThrow(`Working directory does not exist: ${missing}`);
  });

  test("drives a full-screen TUI", { timeout: 20_000 }, async () => {
    const file = join(directory, "numbers.txt");
    await writeFile(
      file,
      Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n"),
    );
    const tools = createTools();
    const context = toolContext();
    const started = await tools.start.execute(
      "start",
      { command: `less ${file}`, wait_ms: 10_000 },
      undefined,
      undefined,
      context,
    );
    const first = await untilScreenShows(tools, context, started, "line 1");
    expect(first.details.screen).toContain("line 1");
    const paged = await tools.send.execute(
      "send",
      // less may not have handled the key by the time the screen has been quiet for 250 ms.
      { id: "t1", keys: ["PageDown"], wait_for_text: "/^line 12$/m", wait_ms: 10_000 },
      undefined,
      undefined,
      context,
    );
    expect(paged.details.screen).toContain("line 12");
    expect(paged.details.screen).not.toContain("line 1\n");
    expect(paged.details.changed).toBe(true);
    const quit = await tools.send.execute(
      "send",
      { id: "t1", text: "q", wait_ms: 5_000 },
      undefined,
      undefined,
      context,
    );
    expect(quit.details).toMatchObject({ state: "exited", exit_code: 0 });
  });

  test(
    "polls a long-running process and returns every scrolled-off line once",
    { timeout: 20_000 },
    async () => {
      const tools = createTools();
      const context = toolContext();
      const ticks = (text: string) =>
        [...text.matchAll(/tick (\d+)/gu)].map(([, tick]) => Number(tick));
      const started = await tools.start.execute(
        "start",
        {
          command:
            "for i in $(seq 1 80); do echo tick $i; sleep 0.05; done; echo finished; sleep 30",
        },
        undefined,
        undefined,
        context,
      );
      expect(started.details.state).toBe("running");
      const firstTop = ticks(started.details.screen)[0] ?? 1;
      // Ticks keep arriving while the result is read; none still on its screen counts as scrolled off.
      expect(ticks(started.details.scrolled_off)).toEqual(
        Array.from({ length: firstTop - 1 }, (_, index) => index + 1),
      );
      const polled = await tools.send.execute(
        "send",
        { id: "t1", wait_for_text: "finished", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      expect(polled.details.screen).toContain("finished");
      // Ticks the first result showed on its screen are not repeated once they scroll off.
      const shown = ticks(
        `${started.details.screen}\n${polled.details.scrolled_off}\n${polled.details.screen}`,
      );
      expect(shown).toEqual(Array.from({ length: 81 - firstTop }, (_, index) => firstTop + index));
      const quiet = await tools.send.execute(
        "send",
        { id: "t1", wait_ms: 500 },
        undefined,
        undefined,
        context,
      );
      expect(quiet.details).toMatchObject({ changed: false, scrolled_off: "" });
    },
  );

  test.skipIf(spawnSync("python3", ["--version"]).status !== 0)(
    "does not repeat lines the agent saw and keeps the start and end of a flood",
    { timeout: 20_000 },
    async () => {
      const tools = createTools();
      const context = toolContext();
      const started = await tools.start.execute(
        "start",
        { command: "python3 -q", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      await untilScreenShows(tools, context, started, "/^>>>$/m");
      const run = (text: string, waitFor: string) =>
        tools.send.execute(
          "send",
          { id: "t1", text, wait_for_text: waitFor, wait_ms: 10_000 },
          undefined,
          undefined,
          context,
        );
      const ticked = await run("for i in range(3): print('tick', i)\n\n", "/^tick 2\n>>>$/m");
      expect(ticked.details.screen).toMatch(/^tick 0$/mu);
      // 300 lines, not the issue's 500: termctrl's own scrollback must keep them all for the full
      // output file to hold every line and for output_missing to stay unset.
      const flood = await run("for i in range(300): print('line', i)\n\n", "/^line 299\n>>>$/m");
      const scrolled = flood.details.scrolled_off;
      expect(scrolled).not.toContain("tick");
      expect(scrolled.split("\n").length).toBeLessThanOrEqual(100);
      expect(scrolled).toMatch(/^\[… \d+ lines omitted …\]$/mu);
      expect(flood.details.output_missing).toBeUndefined();
      const full = await readFile(flood.details.full_output_path ?? "", "utf8");
      const numbers = [...full.matchAll(/^line (\d+)$/gmu)].map(([, line]) => Number(line));
      expect(numbers).toEqual(Array.from({ length: 300 }, (_, index) => index));
      expect(full).not.toContain("tick");
    },
  );

  test(
    "reports a rewritten line and the output after clear once they scroll off",
    { timeout: 20_000 },
    async () => {
      const tools = createTools();
      const context = toolContext();
      // The program waits for each gate file instead of sleeping, so no load can reorder its output.
      const failed = join(directory, "rewrite-failed.gate");
      const cleared = join(directory, "rewrite-clear.gate");
      const started = await tools.start.execute(
        "start",
        {
          command: `printf 'Building... '; while [ ! -e ${failed} ]; do sleep 0.05; done; printf 'FAILED\\n'; seq 1 20; while [ ! -e ${cleared} ]; do sleep 0.05; done; clear; seq 101 130; echo finished; sleep 30`,
        },
        undefined,
        undefined,
        context,
      );
      const building = await untilScreenShows(tools, context, started, "Building...");
      expect(building.details.screen).toBe("Building...");
      await release(failed);
      const built = await tools.send.execute(
        "send",
        { id: "t1", wait_for_text: "/^20$/m", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      expect(built.details.scrolled_off.split("\n")[0]).toBe("Building... FAILED");
      await release(cleared);
      const finished = await tools.send.execute(
        "send",
        { id: "t1", wait_for_text: "finished", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      expect(finished.details.scrolled_off.split("\n")[0]).toBe("101");
      expect(finished.details.output_missing).toBe(true);
    },
  );

  test(
    "keeps its place past termctrl's scrollback limit and reports lines it dropped",
    { timeout: 30_000 },
    async () => {
      const tools = createTools();
      const context = toolContext();
      const started = await tools.start.execute(
        "start",
        { command: "bash --norc --noprofile -i", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      await untilScreenShows(tools, context, started, "/\\$$/m");
      const run = (text: string, waitFor: string) =>
        tools.send.execute(
          "send",
          { id: "t1", text, wait_for_text: waitFor, wait_ms: 10_000 },
          undefined,
          undefined,
          context,
        );
      // Fill termctrl's scrollback, reading as it goes so nothing is dropped unreported.
      for (let batch = 0; batch < 6; batch++) {
        const filled = await run(`seq ${batch}001 ${batch}200; echo b${batch}\n`, `/^b${batch}$/m`);
        expect(filled.details.output_missing).toBeUndefined();
      }
      const small = await run("echo one; echo two; echo three\n", "/^three$/m");
      expect(small.details.output_missing).toBeUndefined();
      expect(small.details.scrolled_off.split("\n").length).toBeLessThan(15);
      const burst = await run("seq 1 5000; echo burst-done\n", "/^burst-done$/m");
      expect(burst.details.output_missing).toBe(true);
      expect(burst.details.scrolled_off.split("\n")[0]).not.toBe("1");
    },
  );

  test("terminal_stop stops a process that ignores signals", { timeout: 20_000 }, async () => {
    const tools = createTools();
    const context = toolContext();
    const pidFile = join(directory, "stubborn.pid");
    const started = await tools.start.execute(
      "start",
      { command: `trap '' INT TERM HUP; echo $$ > ${pidFile}; echo stubborn; sleep 1000` },
      undefined,
      undefined,
      context,
    );
    // The program prints after writing its pid file, so the file is complete once the text shows.
    await untilScreenShows(tools, context, started, "/^stubborn$/m");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    const stopped = await tools.stop.execute("stop", { id: "t1" }, undefined, undefined, context);
    // untilScreenShows already returned the screen, so the stop result does not repeat it.
    expect(stopped.details).toMatchObject({ id: "t1", state: "exited", changed: false });
    expect(stopped.details).not.toHaveProperty("screen");
    expect(tools.registry.entries()).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a closing driver fails a Terminal request instead of leaving it unanswered", async () => {
    if (binary.kind !== "available") return;
    const driver = await createTermctrlDriver(binary.path);
    const handle = await driver.launch({
      id: "closing",
      command: ["/bin/sh", "-c", "exit 0"],
      cwd: directory,
      viewport: { cols: 40, rows: 5 },
    });
    // The registry closes an idle driver without waiting for it, as when its last Terminal exits,
    // and a tool call can still read that exited Terminal, as terminal_stop does.
    const closed = driver.close();
    await expect(handle.logs()).rejects.toThrow("termctrl driver is closed");
    await closed;
  });

  test("SIGKILL escalation kills the Terminal's process group", { timeout: 20_000 }, async () => {
    if (binary.kind !== "available") return;
    const driver = await createTermctrlDriver(binary.path);
    try {
      const handle = await driver.launch({
        id: "escalation",
        command: ["/bin/sh", "-c", "trap '' INT TERM HUP; echo ready; sleep 1000"],
        cwd: directory,
        viewport: { cols: 40, rows: 5 },
      });
      // Signals sent before the trap is installed would end the shell without needing SIGKILL.
      const readyDeadline = Date.now() + 10_000;
      while (!(await handle.snapshot()).screen.includes("ready")) {
        if (Date.now() > readyDeadline) throw new Error("the shell never installed its traps");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      handle.kill();
      const deadline = Date.now() + 5_000;
      let snapshot = await handle.snapshot();
      while (snapshot.state === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        snapshot = await handle.snapshot();
      }
      expect(snapshot.state).toBe("exited");
      expect(snapshot.exit?.signal).toMatch(/kill/iu);
      await handle.stop();
    } finally {
      await driver.close();
    }
  });
});
