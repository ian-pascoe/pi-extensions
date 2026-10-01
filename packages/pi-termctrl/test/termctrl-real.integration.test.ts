import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      { command: `less ${file}`, wait_for_text: undefined, wait_ms: 10_000 },
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
    "polls a long-running process and returns scrolled-off lines once",
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
      const firstScreen = ticks(started.details.screen);
      const polled = await tools.send.execute(
        "send",
        { id: "t1", wait_for_text: "finished", wait_ms: 10_000 },
        undefined,
        undefined,
        context,
      );
      expect(polled.details.screen).toContain("finished");
      const scrolled = ticks(polled.details.scrolled_off);
      expect(scrolled.length).toBeGreaterThan(0);
      expect(Math.min(...scrolled)).toBeGreaterThan(Math.max(...firstScreen));
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

  test("terminal_stop stops a process that ignores signals", { timeout: 20_000 }, async () => {
    const tools = createTools();
    const context = toolContext();
    await tools.start.execute(
      "start",
      { command: "trap '' INT TERM HUP; echo stubborn; sleep 1000" },
      undefined,
      undefined,
      context,
    );
    const stopped = await tools.stop.execute("stop", { id: "t1" }, undefined, undefined, context);
    expect(stopped.details).toMatchObject({ id: "t1", state: "exited" });
    expect(stopped.details.output).toContain("stubborn");
    expect(tools.registry.entries()).toEqual([]);
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
