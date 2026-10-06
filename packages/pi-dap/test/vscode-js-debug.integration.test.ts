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

afterEach(async () => {
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

  const adapterPath = resolve(
    import.meta.dirname,
    "../../../tools/pi-dap-vscode-js-debug/node_modules/vscode-js-debug/src/dapDebugServer.js",
  );
  const baselineAdapterProcesses = await processIdsContaining(adapterPath);
  const files = await createDapSessionFiles(piSessionDirectory);
  sessionFileStores.push(files);
  const settings: ResolvedDapSettings = {
    adapters: new Map([
      [
        "node",
        {
          id: "node",
          command: process.execPath,
          args: [adapterPath, "$PORT", "127.0.0.1"],
          environment: { ...process.env, PI_DAP_SUPPORTED_ADAPTER_TEST: "1" },
          transport: { type: "tcp", host: "127.0.0.1", port: 0 },
        },
      ],
    ]),
    profiles: new Map([
      [
        "node",
        {
          id: "node",
          adapterId: "node",
          arguments: {
            type: "pwa-node",
            request: "launch",
            name: "Pi DAP Supported Adapter test",
            console: "internalConsole",
            stopOnEntry: true,
          },
        },
      ],
    ]),
    timeouts: { startupMs: 10_000, requestMs: 10_000, executionMs: 10_000, shutdownMs: 3_000 },
    warnings: [],
  };
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
async function startFunctionFirstSession(profileArguments: Record<string, string | boolean>) {
  const projectDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-js-debug-function-"));
  const piSessionDirectory = await mkdtemp(resolve(tmpdir(), "pi-dap-js-debug-function-session-"));
  temporaryDirectories.push(projectDirectory, piSessionDirectory);
  const programPath = resolve(projectDirectory, "program.js");
  await writeFile(programPath, FUNCTION_FIRST_PROGRAM);
  const adapterPath = resolve(
    import.meta.dirname,
    "../../../tools/pi-dap-vscode-js-debug/node_modules/vscode-js-debug/src/dapDebugServer.js",
  );
  const files = await createDapSessionFiles(piSessionDirectory);
  sessionFileStores.push(files);
  const settings: ResolvedDapSettings = {
    adapters: new Map([
      [
        "node",
        {
          id: "node",
          command: process.execPath,
          args: [adapterPath, "$PORT", "127.0.0.1"],
          environment: { ...process.env, PI_DAP_SUPPORTED_ADAPTER_TEST: "1" },
          transport: { type: "tcp", host: "127.0.0.1", port: 0 },
        },
      ],
    ]),
    profiles: new Map([["node", { id: "node", adapterId: "node", arguments: profileArguments }]]),
    timeouts: { startupMs: 10_000, requestMs: 10_000, executionMs: 10_000, shutdownMs: 3_000 },
    warnings: [],
  };
  const session = new DapSession({ cwd: projectDirectory, settings, sessionFiles: files });
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
  await session.stop();
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
  await session.stop();

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
    expect(stop.stop?.topFrame).toMatchObject({ name: "global.add", line: 2 });
  }
  // Only the user's breakpoint reports the id Pi DAP returned from dap_set_breakpoints.
  expect(breakpointStops.length).toBeGreaterThan(0);
  for (const stop of breakpointStops) {
    expect(stop.stop?.hitBreakpointIds?.length).toBeGreaterThan(0);
    expect(stop.stop?.topFrame).toMatchObject({ line: 3 });
  }
}, 30_000);
