import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  type ExtensionToolContext,
  type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createBashReplacement, RunningBashCalls } from "../src/bash-replacement.js";
import { TermctrlRegistry, type ExitNotice } from "../src/termctrl-registry.js";
import { createTerminalStopTool } from "../src/terminal-tools.js";
import { FakeDriverFactory } from "./fake-driver.js";

class FakeUi {
  handler: TerminalInputHandler | undefined;
  subscriptions = 0;
  readonly notifications: string[] = [];
  onTerminalInput(handler: TerminalInputHandler): () => void {
    this.subscriptions++;
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }
  notify(message: string): void {
    this.notifications.push(message);
  }
}

let directory: string;
let ui: FakeUi;
let registry: TermctrlRegistry;
let notices: ExitNotice[][];

function context(owner = "root"): ExtensionToolContext {
  const value = {
    cwd: directory,
    model: undefined,
    sessionManager: { getSessionId: () => owner, getSessionFile: () => undefined },
    ui: {
      onTerminalInput: (handler: TerminalInputHandler) => ui.onTerminalInput(handler),
      notify: (message: string) => ui.notify(message),
    },
  };
  // SAFETY: Pi's bash execute and the replacement read only these context members.
  return value as ExtensionToolContext;
}

type Result = Awaited<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>>;

function textOf(result: { readonly content: readonly (TextContent | ImageContent)[] }): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

/** Strip values that legitimately differ between two runs: temp paths and wall time. */
function comparable(result: Result) {
  const normalize = (text: string) => text.replaceAll(/\/[^\s\]]*pi-bash-[^\s\]]*/gu, "<temp>");
  const structured = result.structuredContent;
  const structuredText = JSON.stringify(structured ?? null).replaceAll(
    /"wall_time_seconds":[\d.]+/gu,
    '"wall_time_seconds":0',
  );
  return {
    text: normalize(textOf(result)),
    isError: result.isError,
    details: normalize(JSON.stringify(result.details ?? null)),
    structured: normalize(structuredText),
  };
}

async function outcome(run: Promise<Result>) {
  try {
    return { ok: comparable(await run) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function replacement(definitionFactory?: typeof createBashToolDefinition) {
  const calls = new RunningBashCalls(() => registry);
  const options: Parameters<typeof createBashReplacement>[0] = {
    cwd: directory,
    commandPrefix: undefined,
    shellPath: undefined,
    registry: () => registry,
    calls,
  };
  return {
    calls,
    tool: createBashReplacement(
      definitionFactory === undefined ? options : { ...options, definitionFactory },
    ),
  };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await sleep(10);
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-termctrl-bash-"));
  ui = new FakeUi();
  registry = TermctrlRegistry.acquire({ createDriver: new FakeDriverFactory().create });
  notices = [];
  registry.bindOwner("root", (batch) => {
    notices.push([...batch]);
    return true;
  });
});

afterEach(async () => {
  await TermctrlRegistry.teardownForTests();
  await rm(directory, { recursive: true, force: true });
});

describe("foreground parity with Pi's bash", () => {
  test.each([
    { name: "success", params: { command: "echo out; echo err >&2" } },
    { name: "non-zero exit", params: { command: "echo partial; exit 3" } },
    { name: "timeout", params: { command: "echo started; sleep 5", timeout: 0.5 } },
    { name: "invalid timeout", params: { command: "true", timeout: -1 } },
    { name: "truncation", params: { command: "seq 1 3000" } },
  ])("$name matches the built-in result", async ({ params }) => {
    const builtin = createBashToolDefinition(directory);
    const { tool } = replacement();
    const expected = await outcome(builtin.execute("a", params, undefined, undefined, context()));
    const actual = await outcome(tool.execute("b", params, undefined, undefined, context()));
    expect(actual).toEqual(expected);
  });

  test("abort matches the built-in result", async () => {
    const builtin = createBashToolDefinition(directory);
    const { tool } = replacement();
    const run = async (execute: typeof builtin.execute) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      return outcome(
        execute(
          "call",
          { command: "echo begin; sleep 5" },
          controller.signal,
          undefined,
          context(),
        ),
      );
    };
    const expected = await run(builtin.execute.bind(builtin));
    const actual = await run(tool.execute.bind(tool));
    expect(expected).toEqual({ error: "begin\n\n\nCommand aborted" });
    expect(actual).toEqual(expected);
  });

  test("background: true returns an ordinary result when the command finishes in the window", async () => {
    const builtin = createBashToolDefinition(directory);
    const { tool } = replacement();
    const expected = await outcome(
      builtin.execute("a", { command: "echo fast" }, undefined, undefined, context()),
    );
    const actual = await outcome(
      tool.execute(
        "b",
        { command: "echo fast", background: true },
        undefined,
        undefined,
        context(),
      ),
    );
    expect(actual).toEqual(expected);
    expect(registry.entries()).toEqual([]);
  });
});

describe("Background jobs", () => {
  test("background: true moves a slow command to the background after 2 s", async () => {
    const { tool } = replacement();
    const startedAt = Date.now();
    const result = await tool.execute(
      "call",
      { command: "echo first; sleep 2.5; echo second", background: true },
      undefined,
      undefined,
      context(),
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThan(2_400);
    const logPath = join(tmpdir(), "pi-termctrl", `${process.pid}-b1.log`);
    expect(result.structuredContent).toMatchObject({
      output: "first\n",
      truncated: false,
      background: { id: "b1", log_path: logPath },
    });
    expect(result.structuredContent).not.toHaveProperty("exit_code");
    expect(result).not.toHaveProperty("isError");
    expect(textOf(result)).toContain("first\n\n\nCommand moved to the background as b1.");

    await waitFor(() => notices.length === 1);
    expect(await readFile(logPath, "utf8")).toBe("first\nsecond\n");
    expect(notices[0]).toMatchObject([
      { id: "b1", kind: "job", exit: { code: 0, signal: null }, output: "first\nsecond\n" },
    ]);
  });

  test("Ctrl+B backgrounds every running call and nothing else", async () => {
    const { tool } = replacement();
    expect(ui.handler).toBeUndefined();
    const first = tool.execute(
      "a",
      { command: "echo a; sleep 3" },
      undefined,
      undefined,
      context(),
    );
    const second = tool.execute(
      "b",
      { command: "echo b; sleep 3" },
      undefined,
      undefined,
      context(),
    );
    await waitFor(() => ui.handler !== undefined);
    await sleep(200);
    expect(ui.handler?.("x")).toBeUndefined();
    expect(ui.handler?.("\u0002")).toEqual({ consume: true });

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.structuredContent)).toMatchObject([
      { background: { id: "b1" } },
      { background: { id: "b2" } },
    ]);
    expect(ui.handler).toBeUndefined();
    expect(ui.subscriptions).toBe(1);

    const quick = await tool.execute(
      "c",
      { command: "echo idle" },
      undefined,
      undefined,
      context(),
    );
    expect(quick.structuredContent).toMatchObject({ exit_code: 0 });
    expect(ui.handler).toBeUndefined();
  });

  test("Esc after backgrounding leaves the job alive; terminal_stop kills the whole tree", async () => {
    const { tool } = replacement();
    const pidFile = join(directory, "grandchild.pid");
    const controller = new AbortController();
    const running = tool.execute(
      "call",
      { command: `sleep 1000 & echo $! > ${pidFile}; echo started; wait` },
      controller.signal,
      undefined,
      context(),
    );
    await waitFor(() => existsSync(pidFile) && ui.handler !== undefined);
    ui.handler?.("\u0002");
    const result = await running;
    expect(result.structuredContent).toMatchObject({ background: { id: "b1" } });

    controller.abort();
    await sleep(300);
    const grandchild = Number(await readFile(pidFile, "utf8"));
    expect(registry.get("b1")?.state).toBe("running");
    expect(() => process.kill(grandchild, 0)).not.toThrow();

    const logPath = join(tmpdir(), "pi-termctrl", `${process.pid}-b1.log`);
    expect(existsSync(logPath)).toBe(true);
    const stop = createTerminalStopTool(registry);
    const stopped = await stop.execute("stop", { id: "b1" }, undefined, undefined, context());
    expect(stopped.structuredContent).toMatchObject({
      id: "b1",
      kind: "background_job",
      state: "exited",
      signal: "SIGKILL",
      output: "started\n",
    });
    await waitFor(() => {
      try {
        process.kill(grandchild, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(existsSync(logPath)).toBe(false);
    await nextTick();
    expect(notices).toEqual([]);
  });

  test("after backgrounding, Pi's accumulator and onUpdate receive nothing more", async () => {
    let dataAfterBackground = 0;
    let backgrounded = false;
    const definitionFactory: typeof createBashToolDefinition = (cwd, options) => {
      const operations = options?.operations;
      if (operations === undefined) throw new Error("expected wrapped operations");
      return createBashToolDefinition(cwd, {
        ...options,
        operations: {
          exec: (command, execCwd, execOptions) =>
            operations.exec(command, execCwd, {
              ...execOptions,
              onData: (data) => {
                if (backgrounded) dataAfterBackground++;
                execOptions.onData(data);
              },
            }),
        },
      });
    };
    const { tool } = replacement(definitionFactory);
    let updatesAfterBackground = 0;
    const running = tool.execute(
      "call",
      { command: "for i in $(seq 1 20); do echo tick $i; sleep 0.05; done" },
      undefined,
      () => {
        if (backgrounded) updatesAfterBackground++;
      },
      context(),
    );
    await waitFor(() => ui.handler !== undefined);
    await sleep(200);
    ui.handler?.("\u0002");
    backgrounded = true;
    await running;
    await waitFor(() => registry.get("b1")?.state === "exited");
    expect(dataAfterBackground).toBe(0);
    expect(updatesAfterBackground).toBe(0);
    const log = await readFile(join(tmpdir(), "pi-termctrl", `${process.pid}-b1.log`), "utf8");
    expect(log).toContain("tick 20");
  });

  test("log files are deleted when removed from /ps and when the owner shuts down", async () => {
    const { tool } = replacement();
    const start = async () => {
      const running = tool.execute(
        "call",
        { command: "echo x; sleep 0.3" },
        undefined,
        undefined,
        context(),
      );
      await waitFor(() => ui.handler !== undefined);
      ui.handler?.("\u0002");
      return running;
    };
    const first = await start();
    const firstLog = join(tmpdir(), "pi-termctrl", `${process.pid}-b1.log`);
    expect(first.structuredContent).toMatchObject({ background: { log_path: firstLog } });
    await waitFor(() => registry.get("b1")?.state === "exited");
    expect(existsSync(firstLog)).toBe(true);
    await registry.remove("b1");
    expect(existsSync(firstLog)).toBe(false);

    await start();
    const secondLog = join(tmpdir(), "pi-termctrl", `${process.pid}-b2.log`);
    expect(existsSync(secondLog)).toBe(true);
    await registry.shutdownOwner("root");
    expect(existsSync(secondLog)).toBe(false);
  });

  test("the cap stops background: true before the command runs", async () => {
    for (let index = 0; index < 16; index++) {
      registry.createJob("root", `job ${index}`, () => ({
        logPath: `/tmp/fake-${index}.log`,
        stop: () => {},
        tail: () => "",
        removeLog: async () => {},
      }));
    }
    const marker = join(directory, "ran");
    const { tool } = replacement();
    await expect(
      tool.execute(
        "call",
        { command: `touch ${marker}`, background: true },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow("Cannot start: 16 Terminals and Background jobs are already running");
    expect(existsSync(marker)).toBe(false);
  });
});
