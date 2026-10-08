import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createDapToolDefinitions } from "../src/dap-tool.js";
import { DapSession, type DapSessionSnapshot } from "../src/dap-session.js";
import { createDapSessionFiles, type DapSessionFiles } from "../src/dap-session-files.js";
import type { ResolvedDapSettings } from "../src/pi-dap-settings.js";

const temporaryDirectories: string[] = [];
const sessionFileStores: DapSessionFiles[] = [];
const openSessions: DapSession[] = [];

async function processIdsContaining(fragment: string): Promise<ReadonlySet<number>> {
  const processIds = new Set<number>();
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const commandLine = (await readFile(`/proc/${entry.name}/cmdline`)).toString("utf8");
      if (commandLine.includes(fragment)) processIds.add(Number(entry.name));
    } catch {
      // Processes can exit while /proc is scanned.
    }
  }
  return processIds;
}

async function debuggeeProcessIds(
  projectDirectory: string,
  programName: string,
): Promise<ReadonlySet<number>> {
  const processIds = new Set<number>();
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const commandLine = (await readFile(`/proc/${entry.name}/cmdline`)).toString("utf8");
      const cwd = await readlink(`/proc/${entry.name}/cwd`);
      if (cwd === projectDirectory && commandLine.includes(programName)) {
        processIds.add(Number(entry.name));
      }
    } catch {
      // Processes can exit while /proc is scanned.
    }
  }
  return processIds;
}

async function waitForProcessesToExit(processIds: ReadonlySet<number>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remaining = [...processIds].filter((processId) => {
      try {
        process.kill(processId, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (remaining.length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Pi DAP integration: processes did not exit: ${[...processIds].join(", ")}`);
}

const ADAPTER_PATH = resolve(
  import.meta.dirname,
  "../../../tools/pi-dap-vscode-js-debug/node_modules/vscode-js-debug/src/dapDebugServer.js",
);

/** Settings for the Supported vscode-js-debug adapter with one `node` Launch Profile. */
function jsDebugSettings(
  profileArguments: Record<string, string | boolean>,
  executionMs = 10_000,
): ResolvedDapSettings {
  return {
    adapters: new Map([
      [
        "node",
        {
          id: "node",
          command: process.execPath,
          args: [ADAPTER_PATH, "$PORT", "127.0.0.1"],
          environment: { ...process.env, PI_DAP_SUPPORTED_ADAPTER_TEST: "1" },
          transport: { type: "tcp", host: "127.0.0.1", port: 0 },
        },
      ],
    ]),
    profiles: new Map([["node", { id: "node", adapterId: "node", arguments: profileArguments }]]),
    timeouts: { startupMs: 10_000, requestMs: 10_000, executionMs, shutdownMs: 3_000 },
    warnings: [],
  };
}

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map((session) => session.shutdown()));
  await Promise.all(sessionFileStores.splice(0).map((files) => files.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("debugs TypeScript through the Supported vscode-js-debug adapter and cleans up both exit paths", async () => {
  const projectDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-js-debug-project-"));
  const piSessionDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-js-debug-session-"));
  temporaryDirectories.push(projectDirectory, piSessionDirectory);
  const programPath = resolve(projectDirectory, "program.ts");
  await writeFile(
    programPath,
    [
      "const base: number = 41;",
      "const answer: number = base + 1;",
      "console.log(`answer=${answer}`);",
    ].join("\n"),
  );

  const adapterPath = ADAPTER_PATH;
  const baselineAdapterProcesses = await processIdsContaining(adapterPath);
  const files = await createDapSessionFiles(piSessionDirectory);
  sessionFileStores.push(files);
  const settings = jsDebugSettings({
    type: "pwa-node",
    request: "launch",
    name: "Pi DAP Supported Adapter test",
    console: "internalConsole",
    stopOnEntry: true,
  });
  const observerSnapshots: DapSessionSnapshot[] = [];
  const session = new DapSession({
    cwd: projectDirectory,
    settings,
    sessionFiles: files,
    onSnapshotChange: (snapshot) => observerSnapshots.push(snapshot),
  });
  await session.setBreakpoints({ filePath: programPath, breakpoints: [{ line: 3 }] });

  const launch = await session.launch({
    profile: "node",
    program: programPath,
    cwd: projectDirectory,
  });
  expect(launch.snapshot).toMatchObject({ state: "stopped", stopReason: "entry" });
  expect(observerSnapshots).toContainEqual(
    expect.objectContaining({ state: "stopped", stopReason: "entry" }),
  );
  const breakpointStop = await session.continue();
  expect(breakpointStop.snapshot).toMatchObject({ state: "stopped", stopReason: "breakpoint" });
  expect(breakpointStop.stop?.topFrame).toMatchObject({
    line: 3,
    source: { path: programPath },
  });
  expect(observerSnapshots).toContainEqual(
    expect.objectContaining({ state: "stopped", stopReason: "breakpoint" }),
  );
  const stack = await session.stack();
  const topStackFrame = stack.stackFrames?.at(0);
  expect(topStackFrame?.source?.path).toBe(programPath);
  const variables = await session.variables({ frameId: topStackFrame?.id ?? -1 });
  expect(variables.variableGroups?.flatMap((group) => group.variables ?? [])).toContainEqual(
    expect.objectContaining({ name: "answer", value: "42" }),
  );
  // js-debug marks Global expensive: it is listed with its reference but never expanded here.
  const expensiveGroups = variables.variableGroups?.filter((group) => group.scope.expensive) ?? [];
  expect(expensiveGroups.length).toBeGreaterThan(0);
  for (const group of expensiveGroups) expect(group.variables).toBeUndefined();
  // The model sees the locals in the visible text, with no Result Spill to read.
  const variablesTool = createDapToolDefinitions(() => ({ session, sessionFiles: files })).find(
    ({ name }) => name === "dap_variables",
  );
  const variablesResult = await variablesTool?.execute(
    "variables",
    { frame_id: topStackFrame?.id ?? -1 },
    undefined,
    undefined,
    // SAFETY: Tool execution only reads cwd from its context.
    { cwd: projectDirectory } as ExtensionToolContext,
  );
  const variablesText = variablesResult?.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
  expect(variablesText).toMatch(/^\s{2}answer(: number)? = 42$/mu);
  expect(variablesText).toContain("expensive, not expanded");
  expect(variablesText).not.toContain("Result Spill");
  const evaluation = await session.evaluate({ expression: "answer" });
  expect(evaluation.evaluation?.result).toBe("42");
  await expect(session.evaluate({ expression: "undefinedName" })).rejects.toThrow(
    /undefinedName is not defined/,
  );

  const adapterProcesses = new Set(
    [...(await processIdsContaining(adapterPath))].filter(
      (processId) => !baselineAdapterProcesses.has(processId),
    ),
  );
  const debuggeeProcesses = await debuggeeProcessIds(projectDirectory, "program.ts");
  expect(adapterProcesses.size).toBeGreaterThan(0);
  expect(debuggeeProcesses.size).toBeGreaterThan(0);

  const continued = await session.continue();
  expect(continued.snapshot.state).toBe("terminated");
  expect(observerSnapshots.at(-1)).toMatchObject({ state: "terminated" });
  expect(continued.output).toContain("answer=42");
  expect(session.status().snapshot.state).toBe("terminated");
  await waitForProcessesToExit(new Set([...adapterProcesses, ...debuggeeProcesses]));

  await session.launch({ profile: "node", program: programPath, cwd: projectDirectory });
  const secondAdapterProcesses = new Set(
    [...(await processIdsContaining(adapterPath))].filter(
      (processId) => !baselineAdapterProcesses.has(processId),
    ),
  );
  const secondDebuggeeProcesses = await debuggeeProcessIds(projectDirectory, "program.ts");
  await session.stop();
  await waitForProcessesToExit(new Set([...secondAdapterProcesses, ...secondDebuggeeProcesses]));
}, 30_000);

const FUNCTION_FIRST_PROGRAM = [
  "function add(a, b) {",
  "  const sum = a + b;",
  "  return sum;",
  "}",
  "let total = 0;",
  "for (let i = 0; i < 3; i++) total = add(total, i);",
  "console.log(`total=${total}`);",
].join("\n");

/** A Supported vscode-js-debug Debug Session whose program starts with a function declaration. */
async function startFunctionFirstSession(
  profileArguments: Record<string, string | boolean>,
  executionMs?: number,
) {
  const projectDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-js-debug-function-"));
  const piSessionDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-js-debug-function-session-"));
  temporaryDirectories.push(projectDirectory, piSessionDirectory);
  const programPath = resolve(projectDirectory, "program.js");
  await writeFile(programPath, FUNCTION_FIRST_PROGRAM);
  const files = await createDapSessionFiles(piSessionDirectory);
  sessionFileStores.push(files);
  const settings = jsDebugSettings(profileArguments, executionMs);
  const session = new DapSession({ cwd: projectDirectory, settings, sessionFiles: files });
  // Closed by afterEach even when an assertion fails, so no adapter or Debuggee leaks.
  openSessions.push(session);
  return { programPath, projectDirectory, session };
}

test("with the repo's node profile, a breakpoint inside a function stops as a breakpoint every call, never as an entry stop", async () => {
  const repoSettings: {
    dap: { profiles: { node: { arguments: Record<string, string | boolean> } } };
  } = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../../../.pi/settings.json"), "utf8"),
  );
  const repoProfile = repoSettings.dap.profiles.node.arguments;
  // js-debug's entry breakpoint (stopOnEntry) would re-stop inside add() on every call.
  expect(repoProfile).not.toHaveProperty("stopOnEntry");
  const { programPath, projectDirectory, session } = await startFunctionFirstSession({
    request: "launch",
    name: "Pi DAP function-first test",
    ...repoProfile,
  });
  await session.setBreakpoints({ filePath: programPath, breakpoints: [{ line: 3 }] });

  const stops = [
    await session.launch({ profile: "node", program: programPath, cwd: projectDirectory }),
  ];
  for (let call = 1; call < 3; call++) stops.push(await session.continue());

  for (const stop of stops) {
    expect(stop.snapshot).toMatchObject({ state: "stopped", stopReason: "breakpoint" });
    expect(stop.stop?.hitBreakpointIds?.length).toBeGreaterThan(0);
    expect(stop.stop?.topFrame).toMatchObject({ name: "global.add", line: 3 });
  }
  const finished = await session.continue();
  expect(finished.snapshot.state).toBe("terminated");
  expect(finished.output).toContain("total=3");
}, 30_000);

test("stopOnEntry leaves js-debug's entry breakpoint inside a function-first program, and hitBreakpointIds tells that stop from the user's", async () => {
  const { programPath, projectDirectory, session } = await startFunctionFirstSession({
    type: "pwa-node",
    request: "launch",
    name: "Pi DAP function-first stopOnEntry test",
    console: "internalConsole",
    stopOnEntry: true,
  });
  await session.setBreakpoints({ filePath: programPath, breakpoints: [{ line: 3 }] });

  const stops = [
    await session.launch({ profile: "node", program: programPath, cwd: projectDirectory }),
  ];
  while (stops.length < 8 && stops.at(-1)?.snapshot.state === "stopped") {
    stops.push(await session.continue());
  }

  const entryStops = stops.filter(
    (stop) => stop.stop && "stopReason" in stop.snapshot && stop.snapshot.stopReason === "entry",
  );
  const breakpointStops = stops.filter(
    (stop) => "stopReason" in stop.snapshot && stop.snapshot.stopReason === "breakpoint",
  );
  // The entry breakpoint moved into add() and fires on every call, not only at launch.
  expect(entryStops.length).toBeGreaterThan(1);
  for (const stop of entryStops) {
    expect(stop.stop?.hitBreakpointIds ?? []).toEqual([]);
    expect(stop.stop?.description).toBe("Paused on breakpoint");
    expect(stop.stop?.topFrame).toMatchObject({ name: "global.add", line: 2 });
  }
  // Only the user's breakpoint reports the id Pi DAP returned from dap_set_breakpoints.
  expect(breakpointStops.length).toBeGreaterThan(0);
  for (const stop of breakpointStops) {
    expect(stop.stop?.hitBreakpointIds?.length).toBeGreaterThan(0);
    // Same description as an entry stop: the reason and the ids are what tell them apart.
    expect(stop.stop?.description).toBe("Paused on breakpoint");
    expect(stop.stop?.topFrame).toMatchObject({ line: 3 });
  }
}, 30_000);

/** Launch a throwaway program to completion through the Supported adapter and return the final result. */
async function runToTermination(source: string) {
  const { programPath, projectDirectory, session } = await startFunctionFirstSession({
    type: "pwa-node",
    request: "launch",
    name: "Pi DAP exit code test",
    console: "internalConsole",
  });
  await writeFile(programPath, source);
  return session.launch({ profile: "node", program: programPath, cwd: projectDirectory });
}

test.each([
  ["a clean run", "console.log('done');", 0],
  ["process.exit(3)", "process.exit(3);", 3],
  ["an uncaught error", "throw new Error('boom');", 1],
])(
  "reports the Debuggee exit code for %s",
  async (_name, source, exitCode) => {
    const result = await runToTermination(source);
    expect(result.snapshot).toMatchObject({ state: "terminated", exitCode });
  },
  30_000,
);

test("a Debuggee that cannot load its program reports a non-zero exit code", async () => {
  const { projectDirectory, session } = await startFunctionFirstSession({
    type: "pwa-node",
    request: "launch",
    name: "Pi DAP missing program test",
    console: "internalConsole",
  });
  const result = await session.launch({
    profile: "node",
    program: resolve(projectDirectory, "does-not-exist.js"),
    cwd: projectDirectory,
  });
  expect(result.snapshot).toMatchObject({ state: "terminated" });
  expect(result.snapshot).toHaveProperty("exitCode", 1);
}, 30_000);

test("a Debug Session that Pi stops reports no exit code instead of guessing one", async () => {
  const { programPath, projectDirectory, session } = await startFunctionFirstSession({
    type: "pwa-node",
    request: "launch",
    name: "Pi DAP stopped exit code test",
    console: "internalConsole",
    stopOnEntry: true,
  });
  await session.launch({ profile: "node", program: programPath, cwd: projectDirectory });
  const stopped = await session.stop();
  expect(stopped.snapshot.state).toBe("terminated");
  expect(Object.hasOwn(stopped.snapshot, "exitCode")).toBe(false);
}, 30_000);

const WORKER_SOURCE = [
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(process.env.MARKER_PATH, 'worker ran');",
  "const value = 1;",
  "console.log('worker value', value);",
].join("\n");

/** Debuggee that starts a worker thread and prints once the worker exits. */
const WORKER_PARENT_SOURCE = [
  "const { Worker } = require('node:worker_threads');",
  "const path = require('node:path');",
  "const worker = new Worker(path.join(__dirname, 'worker.js'));",
  "worker.on('exit', (code) => console.log(`worker exited ${code}`));",
].join("\n");

/** Debuggee that forks a child process and prints once the child exits, as vitest's forks pool does. */
const FORK_PARENT_SOURCE = [
  "const { fork } = require('node:child_process');",
  "const path = require('node:path');",
  "const child = fork(path.join(__dirname, 'worker.js'), { env: process.env });",
  "child.on('exit', (code) => console.log(`child exited ${code}`));",
].join("\n");

/** A child left paused would hold the launch for this long; a released child finishes far sooner. */
const CHILD_SESSION_EXECUTION_MS = 20_000;
const CHILD_SESSION_BUDGET_MS = 15_000;

/** A Debug Session over a program that spawns `worker.js`, with one breakpoint inside the worker. */
async function startChildSessionProgram(
  parentSource: string,
  profileArguments: Record<string, string | boolean> = {},
) {
  const { programPath, projectDirectory, session } = await startFunctionFirstSession(
    {
      type: "pwa-node",
      request: "launch",
      name: "Pi DAP child session test",
      console: "internalConsole",
      ...profileArguments,
    },
    CHILD_SESSION_EXECUTION_MS,
  );
  const workerPath = resolve(projectDirectory, "worker.js");
  const markerPath = resolve(projectDirectory, "marker.txt");
  await writeFile(programPath, parentSource);
  await writeFile(workerPath, WORKER_SOURCE);
  await session.setBreakpoints({ filePath: workerPath, breakpoints: [{ line: 3 }] });
  return { programPath, projectDirectory, markerPath, session };
}

test.each([
  ["a worker thread", WORKER_PARENT_SOURCE, /^pwa-node "\[worker 1\]"/u, "worker exited 0"],
  ["a child process", FORK_PARENT_SOURCE, /^pwa-node "worker\.js \[\d+\]"/u, "child exited 0"],
])(
  "refuses %s as a child session, releases it, and says so within the execution timeout",
  async (_name, parentSource, nameMatcher, exitLine) => {
    const { programPath, projectDirectory, markerPath, session } =
      await startChildSessionProgram(parentSource);
    const started = Date.now();
    const result = await session.launch({
      profile: "node",
      program: programPath,
      cwd: projectDirectory,
      launchArguments: { env: { MARKER_PATH: markerPath } },
    });

    // Under the execution timeout: the child was not left paused waiting for a debugger.
    expect(Date.now() - started).toBeLessThan(CHILD_SESSION_BUDGET_MS);
    expect(result.snapshot).toMatchObject({ state: "terminated", exitCode: 0 });
    expect(result.output).toContain(exitLine);
    expect(await readFile(markerPath, "utf8")).toBe("worker ran");
    expect(result.rejectedChildSessions).toHaveLength(1);
    const [rejected] = result.rejectedChildSessions ?? [];
    expect(rejected?.type).toBe("pwa-node");
    expect(`${rejected?.type} ${JSON.stringify(rejected?.name)}`).toMatch(nameMatcher);
    expect(rejected?.targetId).toEqual(expect.any(String));
    expect(rejected?.message).toContain(rejected?.name);
    expect(rejected?.message).toContain("child debugging is unsupported");
    expect(rejected?.message).toContain("breakpoints in it will not bind");
  },
  40_000,
);

test("a program with no child sessions reports none", async () => {
  const result = await runToTermination("console.log('alone');");
  expect(result.rejectedChildSessions).toBeUndefined();
}, 30_000);

test("launch arguments merged over the profile turn off child process attach, so no child session is refused", async () => {
  const { programPath, projectDirectory, markerPath, session } =
    await startChildSessionProgram(FORK_PARENT_SOURCE);
  const result = await session.launch({
    profile: "node",
    program: programPath,
    cwd: projectDirectory,
    launchArguments: { autoAttachChildProcesses: false, env: { MARKER_PATH: markerPath } },
  });
  expect(result.snapshot).toMatchObject({ state: "terminated", exitCode: 0 });
  expect(result.output).toContain("child exited 0");
  expect(result.rejectedChildSessions).toBeUndefined();
  expect(await readFile(markerPath, "utf8")).toBe("worker ran");
}, 30_000);

test("a released child process that starts a worker thread runs it without a debugger", async () => {
  const { programPath, projectDirectory, markerPath, session } =
    await startChildSessionProgram(FORK_PARENT_SOURCE);
  await writeFile(
    resolve(projectDirectory, "worker.js"),
    [
      "const { Worker } = require('node:worker_threads');",
      "const path = require('node:path');",
      "new Worker(path.join(__dirname, 'inner.js'));",
    ].join("\n"),
  );
  await writeFile(
    resolve(projectDirectory, "inner.js"),
    "require('node:fs').writeFileSync(process.env.MARKER_PATH, 'worker ran');",
  );
  const started = Date.now();
  const result = await session.launch({
    profile: "node",
    program: programPath,
    cwd: projectDirectory,
    launchArguments: { env: { MARKER_PATH: markerPath } },
  });
  expect(Date.now() - started).toBeLessThan(CHILD_SESSION_BUDGET_MS);
  expect(result.snapshot).toMatchObject({ state: "terminated", exitCode: 0 });
  expect(result.output).toContain("child exited 0");
  expect(await readFile(markerPath, "utf8")).toBe("worker ran");
  // The child was released and detached, so the adapter no longer holds its worker for a debugger.
  expect(result.rejectedChildSessions?.map(({ name }) => name)).toEqual([
    expect.stringMatching(/^worker\.js \[\d+\]$/u),
  ]);
}, 30_000);
