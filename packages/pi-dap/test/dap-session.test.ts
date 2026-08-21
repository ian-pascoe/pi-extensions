import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DapSession, type DapSessionSnapshot } from "../src/dap-session.js";
import { createDapSessionFiles, type DapSessionFiles } from "../src/dap-session-files.js";
import type { ResolvedDapSettings } from "../src/pi-dap-settings.js";

const temporaryDirectories: string[] = [];
const openSessionFiles: DapSessionFiles[] = [];
const fakeAdapterPath = resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("DAP session test timed out waiting for state");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

interface SessionFixture {
  readonly cwd: string;
  readonly files: DapSessionFiles;
  readonly session: DapSession;
}

async function createSession(
  profileArguments: Readonly<
    Record<string, null | boolean | number | string | readonly string[]>
  > = {
    stopOnEntry: true,
  },
  executionMs = 200,
  observation: {
    readonly onSnapshotChange?: (snapshot: DapSessionSnapshot) => void;
    readonly onUnexpectedFailure?: (error: Error) => void;
  } = {},
  adapterCommand = process.execPath,
): Promise<SessionFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-dap-session-project-"));
  temporaryDirectories.push(cwd);
  const files = await createDapSessionFiles(cwd);
  openSessionFiles.push(files);
  const settings: ResolvedDapSettings = {
    adapters: new Map([
      [
        "node",
        {
          id: "node",
          command: adapterCommand,
          args: [fakeAdapterPath],
          environment: {},
          transport: { type: "stdio" },
        },
      ],
    ]),
    profiles: new Map([
      [
        "node",
        {
          id: "node",
          adapterId: "node",
          arguments: profileArguments,
        },
      ],
    ]),
    timeouts: {
      executionMs,
      requestMs: 1_000,
      shutdownMs: 500,
      startupMs: 1_000,
    },
    warnings: [],
  };
  return {
    cwd,
    files,
    session: new DapSession({ cwd, settings, sessionFiles: files, ...observation }),
  };
}

afterEach(async () => {
  await Promise.all(openSessionFiles.splice(0).map((files) => files.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DapSession", () => {
  test("applies Desired Breakpoints before configuration and supports the stopped inspection workflow", async () => {
    const { cwd, session } = await createSession({ requireBreakpoint: true, stopOnEntry: true });
    const programPath = resolve(cwd, "program.ts");

    await expect(session.continue()).rejects.toThrow("continue requires a stopped Debuggee");
    const desired = await session.setBreakpoints({
      filePath: "program.ts",
      breakpoints: [{ line: 4, condition: "answer === 42" }],
    });
    expect(desired.desiredBreakpoints).toEqual([
      {
        filePath: programPath,
        breakpoints: [{ line: 4, condition: "answer === 42" }],
      },
    ]);

    const launched = await session.launch({ program: "program.ts" });
    expect(launched.snapshot).toMatchObject({
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "entry",
      threadId: 1,
    });
    expect(launched.output).toBe("launched\n");
    await expect(session.launch()).rejects.toThrow("launch requires no active Debug Session");

    const stack = await session.stack({ start: 0, count: 1 });
    expect(stack.stackFrames).toEqual([
      expect.objectContaining({
        id: 10,
        name: "main",
        line: 4,
        source: { name: "program.ts", path: programPath },
      }),
    ]);
    expect(stack.totalFrames).toBe(2);

    const frameVariables = await session.variables({ frameId: 10 });
    expect(frameVariables.variableGroups).toEqual([
      {
        scope: expect.objectContaining({ name: "Local", variablesReference: 20 }),
        variables: [
          expect.objectContaining({ name: "answer", value: "42" }),
          expect.objectContaining({ name: "nested", variablesReference: 21 }),
        ],
      },
    ]);
    const childVariables = await session.variables({
      variablesReference: 21,
      start: 1,
      count: 1,
    });
    expect(childVariables.variables).toEqual([
      expect.objectContaining({ name: "nested", variablesReference: 21 }),
    ]);

    const evaluation = await session.evaluate({ expression: "answer" });
    expect(evaluation.evaluation).toMatchObject({ result: "answer", variablesReference: 0 });

    for (const step of [() => session.next(), () => session.stepIn(), () => session.stepOut()]) {
      await expect(step()).resolves.toMatchObject({
        snapshot: expect.objectContaining({ state: "stopped", stopReason: "step" }),
      });
    }

    await expect(
      session.setBreakpoints({
        filePath: "program.ts",
        breakpoints: [{ line: 8, condition: "fail" }],
      }),
    ).rejects.toThrow("breakpoint rejected");
    expect(session.status().desiredBreakpoints).toEqual([
      {
        filePath: programPath,
        breakpoints: [{ line: 4, condition: "answer === 42" }],
      },
    ]);

    const stopped = await session.stop();
    expect(stopped.snapshot.state).toBe("terminated");
    await expect(session.stop()).resolves.toMatchObject({
      snapshot: expect.objectContaining({ state: "terminated" }),
    });
  });

  test("publishes actual lifecycle transitions and clears stop-specific context on resume", async () => {
    const snapshots: DapSessionSnapshot[] = [];
    const { session } = await createSession({ stopOnEntry: true }, 200, {
      onSnapshotChange: (snapshot) => snapshots.push(snapshot),
    });

    await session.launch();
    expect(snapshots).toEqual([
      { state: "launching", adapterId: "node", profileId: "node" },
      { state: "running", adapterId: "node", profileId: "node" },
      {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "entry",
        threadId: 1,
      },
    ]);

    const priorRunningCount = snapshots.filter(({ state }) => state === "running").length;
    const continuing = session.continue();
    await waitFor(
      () => snapshots.filter(({ state }) => state === "running").length > priorRunningCount,
    );
    expect(snapshots).toContainEqual({
      state: "running",
      adapterId: "node",
      profileId: "node",
    });
    await continuing;
    expect(snapshots.at(-1)).toMatchObject({ state: "stopped", stopReason: "breakpoint" });

    await session.stop();
    expect(snapshots.at(-1)).toMatchObject({
      state: "terminated",
      terminationReason: "stopped by request",
    });
  });

  test("publishes running before a launch wait and isolates observation failures", async () => {
    const snapshots: DapSessionSnapshot[] = [];
    const { session } = await createSession({ neverStop: true, stopOnEntry: false }, 20, {
      onSnapshotChange: (snapshot) => {
        snapshots.push(snapshot);
        if (snapshot.state === "launching") throw new Error("observer failed");
      },
    });

    await expect(session.launch()).resolves.toMatchObject({
      snapshot: { state: "running" },
    });
    expect(snapshots.map(({ state }) => state)).toEqual(["launching", "running"]);
    await expect(session.stop()).resolves.toMatchObject({
      snapshot: { state: "terminated" },
    });
  });

  test("publishes idle after a failed pre-launch startup", async () => {
    const snapshots: DapSessionSnapshot[] = [];
    const { session } = await createSession(
      { stopOnEntry: true },
      200,
      { onSnapshotChange: (snapshot) => snapshots.push(snapshot) },
      resolve(tmpdir(), "missing-pi-dap-adapter"),
    );

    await expect(session.launch()).rejects.toThrow("launch failed");
    expect(snapshots).toEqual([{ state: "idle" }]);
  });

  test("reports an unexpected adapter failure without allowing its observer to break cleanup", async () => {
    const failures: Error[] = [];
    const snapshots: DapSessionSnapshot[] = [];
    const { session } = await createSession({ crashOnContinue: true, stopOnEntry: true }, 200, {
      onSnapshotChange: (snapshot) => snapshots.push(snapshot),
      onUnexpectedFailure: (error) => {
        failures.push(error);
        throw new Error("failure observer failed");
      },
    });

    await session.launch();
    await expect(session.continue()).resolves.toMatchObject({
      snapshot: { state: "terminated" },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("adapter-stderr");
    expect(snapshots.at(-1)?.state).toBe("terminated");
  });

  test("execution timeout and cancellation return running and pause recovers the Debug Session", async () => {
    const { session } = await createSession({ neverStop: true, stopOnEntry: false }, 40);

    const launched = await session.launch();
    expect(launched.snapshot.state).toBe("running");
    await expect(session.stack()).rejects.toThrow("stack requires a stopped Debuggee");

    const paused = await session.pause();
    expect(paused.snapshot).toMatchObject({ state: "stopped", stopReason: "pause" });

    const timedOut = await session.continue();
    expect(timedOut.snapshot.state).toBe("running");

    const recovered = await session.pause();
    expect(recovered.snapshot.state).toBe("stopped");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const cancelled = await session.continue(controller.signal);
    expect(cancelled.snapshot.state).toBe("running");

    await session.stop();
  });

  test("natural exit retains a terminal snapshot and drains remaining Debuggee output", async () => {
    const { session } = await createSession({ exitOnContinue: true, stopOnEntry: true });

    await session.launch();
    const exited = await session.continue();

    expect(exited.snapshot).toMatchObject({ state: "terminated", exitCode: 0 });
    expect(exited.output).toBe("finished\n");
    expect(session.status()).toMatchObject({
      snapshot: expect.objectContaining({ state: "terminated", exitCode: 0 }),
      output: "",
    });
    await session.shutdown();
  });

  test("handles runInTerminal headlessly and rejects child Debug Sessions", async () => {
    const debuggeePidPath = join(
      tmpdir(),
      `pi-dap-debuggee-${String(process.pid)}-${String(Date.now())}`,
    );
    const terminal = await createSession({
      stopOnEntry: true,
      runInTerminalArgs: [
        process.execPath,
        "-e",
        "process.stdout.write('terminal-output\\n'); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
        debuggeePidPath,
      ],
    });

    const launched = await terminal.session.launch();
    let collectedOutput = launched.output;
    await waitFor(async () => {
      try {
        const pidText = await readFile(debuggeePidPath, "utf8");
        collectedOutput += terminal.session.status().output;
        return pidText.length > 0;
      } catch {
        return false;
      }
    });
    const debuggeePid = Number(await readFile(debuggeePidPath, "utf8"));
    expect(collectedOutput).toContain("terminal-output\n");
    expect(isProcessAlive(debuggeePid)).toBe(true);
    await terminal.session.stop();
    await waitFor(() => !isProcessAlive(debuggeePid));
    await rm(debuggeePidPath, { force: true });

    const childSession = await createSession({ requestStartDebugging: true });
    await expect(childSession.session.launch()).rejects.toThrow("startDebugging rejected");
    expect(childSession.session.status().snapshot.state).toBe("terminated");
  });

  test("cleans up launch cancellation and an unexpected Debug Adapter exit", async () => {
    const controller = new AbortController();
    const cancelled = await createSession({ delayInitializedMs: 200, stopOnEntry: true }, 200, {
      onSnapshotChange: (snapshot) => {
        if (snapshot.state === "launching") controller.abort();
      },
    });

    await expect(cancelled.session.launch({}, controller.signal)).rejects.toThrow(
      "launch was cancelled and cleaned up",
    );
    expect(cancelled.session.status().snapshot.state).toBe("terminated");

    const crashed = await createSession({ crashOnContinue: true, stopOnEntry: true });
    await crashed.session.launch();
    const result = await crashed.session.continue();
    expect(result.snapshot).toMatchObject({
      state: "terminated",
      terminationReason: expect.stringContaining("adapter-stderr"),
    });
  });

  test("requires an explicit Launch Profile unless exactly one is configured", async () => {
    const { cwd, files } = await createSession();
    const settings: ResolvedDapSettings = {
      adapters: new Map(),
      profiles: new Map(),
      timeouts: { executionMs: 10, requestMs: 10, shutdownMs: 10, startupMs: 10 },
      warnings: [],
    };
    const session = new DapSession({ cwd, settings, sessionFiles: files });

    await expect(session.launch()).rejects.toEqual(
      expect.objectContaining({
        kind: "configuration",
      }),
    );
  });
});
