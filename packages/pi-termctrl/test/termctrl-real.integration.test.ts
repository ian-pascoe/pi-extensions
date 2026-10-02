import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getShellConfig, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { resolveTermctrlBinary } from "../src/termctrl-binary.js";
import { createTermctrlDriver } from "../src/termctrl-driver.js";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import {
  createTerminalSendTool,
  createTerminalStartTool,
  createTerminalStopTool,
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
  };
  return {
    registry,
    start: createTerminalStartTool(runtime),
    send: createTerminalSendTool(runtime),
    stop: createTerminalStopTool(registry),
  };
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
    expect(started.details.screen).toContain(">");
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
    expect(started.details.screen).toContain("line 1");
    const paged = await tools.send.execute(
      "send",
      { id: "t1", keys: ["PageDown"], wait_ms: 5_000 },
      undefined,
      undefined,
      context,
    );
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
    "polls a long-running process and returns every scrolled-off line",
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
      const shown = ticks(`${polled.details.scrolled_off}\n${polled.details.screen}`);
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

  test(
    "reports a rewritten line and the output after clear once they scroll off",
    { timeout: 20_000 },
    async () => {
      const tools = createTools();
      const context = toolContext();
      const started = await tools.start.execute(
        "start",
        {
          command:
            "printf 'Building... '; sleep 1; printf 'FAILED\\n'; seq 1 20; sleep 1; clear; seq 101 130; echo finished; sleep 30",
        },
        undefined,
        undefined,
        context,
      );
      expect(started.details.screen).toBe("Building...");
      const built = await tools.send.execute(
        "send",
        { id: "t1", wait_for_text: "/^20$/m", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      expect(built.details.scrolled_off.split("\n")[0]).toBe("Building... FAILED");
      const cleared = await tools.send.execute(
        "send",
        { id: "t1", wait_for_text: "finished", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      expect(cleared.details.scrolled_off.split("\n")[0]).toBe("101");
      expect(cleared.details.output_missing).toBe(true);
    },
  );

  test(
    "keeps its place past termctrl's scrollback limit and reports lines it dropped",
    { timeout: 30_000 },
    async () => {
      const tools = createTools();
      const context = toolContext();
      await tools.start.execute(
        "start",
        { command: "bash --norc --noprofile -i", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
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
    await tools.start.execute(
      "start",
      { command: `trap '' INT TERM HUP; echo stubborn; echo $$ > ${pidFile}; sleep 1000` },
      undefined,
      undefined,
      context,
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    const stopped = await tools.stop.execute("stop", { id: "t1" }, undefined, undefined, context);
    expect(stopped.details).toMatchObject({ id: "t1", state: "exited" });
    expect(stopped.details.screen).toContain("stubborn");
    expect(tools.registry.entries()).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("SIGKILL escalation kills the Terminal's process group", { timeout: 20_000 }, async () => {
    if (binary.kind !== "available") return;
    const driver = await createTermctrlDriver(binary.path);
    try {
      const handle = await driver.launch({
        id: "escalation",
        command: ["/bin/sh", "-c", "trap '' INT TERM HUP; sleep 1000"],
        cwd: directory,
        viewport: { cols: 40, rows: 5 },
      });
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
