import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
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
  expect(observerSnapshots).toContainEqual(
    expect.objectContaining({ state: "stopped", stopReason: "breakpoint" }),
  );
  const stack = await session.stack();
  const topStackFrame = stack.stackFrames?.at(0);
  expect(topStackFrame?.source?.path).toBe(programPath);
  const variables = await session.variables({ frameId: topStackFrame?.id ?? -1 });
  expect(variables.variableGroups?.flatMap((group) => group.variables)).toContainEqual(
    expect.objectContaining({ name: "answer", value: "42" }),
  );
  const evaluation = await session.evaluate({ expression: "answer" });
  expect(evaluation.evaluation?.result).toBe("42");

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
