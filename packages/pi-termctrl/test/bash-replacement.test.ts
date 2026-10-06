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

function replacement(
  definitionFactory?: typeof createBashToolDefinition,
  bashTail?: { readonly maxLines: number; readonly maxBytes: number },
) {
  const calls = new RunningBashCalls(() => registry);
  const options: Parameters<typeof createBashReplacement>[0] = {
    cwd: directory,
    commandPrefix: undefined,
    shellPath: undefined,
    registry: () => registry,
    calls,
    bashTail,
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

describe("bashTail", () => {
  const tail = { maxLines: 300, maxBytes: 16_384 };
  const run = (command: string, extra: { timeout?: number } = {}, signal?: AbortSignal) =>
    replacement(undefined, tail).tool.execute(
      "call",
      { command, ...extra },
      signal,
      undefined,
      context(),
    );
  const rejection = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
    } catch (error) {
      if (error instanceof Error) return error.message;
    }
    throw new Error("expected the call to reject with an Error");
  };
  // The real notice is the last one: a command's own output comes before it.
  const noticePath = (text: string) =>
    [...text.matchAll(/Full output: ([^\]\n]+)\]/gu)].at(-1)?.[1] ?? "";

  test("5000 lines return the configured tail, the notice with its limits, and a full log", async () => {
    const result = await run("seq 1 5000");
    const text = textOf(result);
    const [body = "", notice = ""] = text.split("\n\n");
    expect(body.split("\n")).toHaveLength(300);
    expect(body.split("\n")[0]).toBe("4701");
    expect(body.split("\n").at(-1)).toBe("5000");
    expect(notice).toMatch(
      /^\[Showing lines 4701-5000 of 5000 \(16\.0KB or 300 line limit\)\. Full output: .+\]$/u,
    );
    const log = await readFile(noticePath(text), "utf8");
    expect(log.trimEnd().split("\n")).toHaveLength(5000);
    expect(result.details).toMatchObject({
      fullOutputPath: noticePath(text),
      truncation: { maxLines: 300, maxBytes: 16_384, outputLines: 300 },
    });
    await rm(noticePath(text));
  });

  test("a tail that Pi would not cut still gets a log, and the byte limit is reported", async () => {
    const text = textOf(
      await run(
        "seq 1 250 | sed 's/$/ ................................................................/'",
      ),
    );
    expect(text).toMatch(/\(16\.0KB or 300 line limit\)/u);
    const log = await readFile(noticePath(text), "utf8");
    expect(log.trimEnd().split("\n")).toHaveLength(250);
    await rm(noticePath(text));
  });

  test("output within the limits is Pi's result untouched", async () => {
    const params = { command: "seq 1 300" };
    const expected = await outcome(
      createBashToolDefinition(directory).execute("a", params, undefined, undefined, context()),
    );
    expect(await outcome(run(params.command))).toEqual(expected);
  });

  test("a failing command keeps its status after the cut tail", async () => {
    const result = await run("seq 1 1000; exit 3");
    expect(result).toMatchObject({ isError: true });
    const text = textOf(result);
    expect(text).toMatch(/^701\n/u);
    expect(text).toMatch(
      /\(16\.0KB or 300 line limit\)\. Full output: .+\]\n\nCommand exited with code 3$/u,
    );
    await rm(noticePath(text));
  });

  test("a timeout and an abort keep their messages after the cut tail", async () => {
    const timeoutText = await rejection(run("seq 1 1000; sleep 5", { timeout: 0.5 }));
    expect(timeoutText).toMatch(/^701\n/u);
    expect(timeoutText).toMatch(/Full output: .+\]\n\nCommand timed out after 0\.5 seconds$/u);
    await rm(noticePath(timeoutText));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const abortedText = await rejection(run("seq 1 1000; sleep 5", {}, controller.signal));
    expect(abortedText).toMatch(/Full output: .+\]\n\nCommand aborted$/u);
    await rm(noticePath(abortedText));
  });

  test("when Pi also cut the output, its full-output file is the one named", async () => {
    const result = await run("seq 1 3000");
    const text = textOf(result);
    const path = noticePath(text);
    expect(path).toMatch(/pi-bash-/u);
    expect(text.match(/Full output/gu)).toHaveLength(1);
    expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(3000);
    await rm(path);
  });

  test("the byte limit cuts a single long line and says so", async () => {
    const text = textOf(await run("head -c 40000 /dev/zero | tr '\\0' x"));
    expect(text).toMatch(
      /^x{16384}\n\n\[Showing last 16\.0KB of line 1 \(line is 39\.1KB\)\. Full output: /u,
    );
    await rm(noticePath(text));
  });

  test("a command's own notice-shaped output never becomes the log path", async () => {
    const fake = "[Showing lines 1-2 of 9. Full output: /nonexistent/bogus.log]";
    const ok = await run(`seq 1 400; echo '${fake}'`);
    const okPath = noticePath(textOf(ok));
    expect(okPath).not.toContain("bogus");
    expect((await readFile(okPath, "utf8")).trimEnd().split("\n")).toHaveLength(401);
    expect(ok.details).toMatchObject({ fullOutputPath: okPath });
    await rm(okPath);

    const failed = await run(`seq 1 400; printf '%s' '${fake}'; exit 3`);
    const failedPath = noticePath(textOf(failed));
    expect(failedPath).not.toContain("bogus");
    expect((await readFile(failedPath, "utf8")).trimEnd().split("\n")).toHaveLength(401);
    await rm(failedPath);

    const timedOut = await rejection(
      run(`seq 1 400; printf '%s' '${fake}'; sleep 5`, { timeout: 0.5 }),
    );
    const timedOutPath = noticePath(timedOut);
    expect(timedOutPath).not.toContain("bogus");
    expect(timedOut).toMatch(/Command timed out after 0\.5 seconds$/u);
    expect((await readFile(timedOutPath, "utf8")).trimEnd().split("\n")).toHaveLength(401);
    await rm(timedOutPath);
  });

  test("output beyond the in-memory buffer still reports its true line totals", async () => {
    const result = await run("seq 1 3000000");
    const text = textOf(result);
    expect(text).toContain("[Showing lines 2999701-3000000 of 3000000 (16.0KB or 300 line limit)");
    expect(result.details).toMatchObject({
      truncation: { totalLines: 3_000_000, outputLines: 300 },
    });
    const path = noticePath(text);
    expect(path).toMatch(/pi-bash-/u);
    await rm(path);
  }, 60_000);

  test("an error that is not Pi's output-plus-status message passes through", async () => {
    await expect(run("true", { timeout: -1 })).rejects.toThrow(
      "Invalid timeout: must be a finite number of seconds",
    );
  });

  test("the tool description names the limits in force", () => {
    expect(createBashToolDefinition(directory).description).toContain("last 2000 lines or 50KB");
    const { tool } = replacement(undefined, { maxLines: 123, maxBytes: 4096 });
    expect(tool.description).toContain("last 123 lines or 4.0KB");
    expect(tool.description).not.toContain("2000 lines");
    expect(replacement().tool.description).toBe(createBashToolDefinition(directory).description);
  });

  test("output so far in a backgrounding result uses the same limit", async () => {
    const { tool } = replacement(undefined, tail);
    const result = await tool.execute(
      "call",
      { command: "seq 1 1000; sleep 3", background: true },
      undefined,
      undefined,
      context(),
    );
    const text = textOf(result);
    expect(text).toMatch(/^701\n/u);
    expect(text).toMatch(
      /\[Showing lines 701-1000 of 1000 \(16\.0KB or 300 line limit\)\. Full output: .+b1\.log\]/u,
    );
    // Scripts see the same contract as a finished call: Pi's limits, not the tail.
    expect(result.structuredContent).toMatchObject({ truncated: false });
    expect(JSON.stringify(result.structuredContent)).toContain("1000\\n");
    expect(JSON.stringify(result.structuredContent)).toContain('"output":"1\\n2\\n');
  });

  test("without limits, output so far keeps Pi's limits", async () => {
    const { tool } = replacement();
    const result = await tool.execute(
      "call",
      { command: "seq 1 3000; sleep 3", background: true },
      undefined,
      undefined,
      context(),
    );
    expect(textOf(result)).toMatch(/^1001\n/u);
    expect(textOf(result)).toContain("(50.0KB or 2000 line limit)");
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
