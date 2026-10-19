import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
  createExtensionHarness,
  type ExtensionHarness,
  type ExtensionHarnessDirectories,
  makeTemporaryDirectory,
  removeHarnessDirectories,
  resetSharedServerInstancePool,
  shutdownExtension,
  startExtension,
} from "./extension-harness.js";
import { toToolContext } from "./tool-context.js";

const fakeServerPath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));

/** A project two sessions open, whose fake server records every launch. */
interface SharedProject {
  readonly directories: ExtensionHarnessDirectories;
  readonly filePath: string;
  /** Process IDs of the fake servers launched so far, in launch order. */
  launches(): Promise<number[]>;
}

async function createSharedProject(
  environment: Readonly<Record<string, string>> = {},
  server: { readonly maxConcurrentDiagnostics?: number } = {},
): Promise<SharedProject> {
  const cwd = await makeTemporaryDirectory("pi-lsp-shared-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-lsp-shared-agent-");
  const launchLog = resolve(agentDirectory, "launches.log");
  await writeFile(
    resolve(agentDirectory, "settings.json"),
    JSON.stringify({
      lsp: {
        timeouts: { diagnosticsMs: 2_000, initializeMs: 5_000, shutdownMs: 1_000 },
        servers: {
          fake: {
            command: process.execPath,
            args: [fakeServerPath],
            environment: { FAKE_LAUNCH_LOG: launchLog, ...environment },
            languages: [{ extensions: [".ts"], languageId: "typescript" }],
            ...server,
          },
        },
      },
    }),
  );
  const filePath = resolve(cwd, "source.ts");
  await writeFile(filePath, "const value = 1;\n");
  return {
    directories: { cwd, agentDirectory },
    filePath,
    launches: async () =>
      (await readFile(launchLog, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== "")
        .map(Number),
  };
}

const openSessions: ExtensionHarness[] = [];

async function openSession(project: SharedProject, projectTrusted = false) {
  const harness = await createExtensionHarness(projectTrusted, {}, false, project.directories);
  openSessions.push(harness);
  await startExtension(harness);
  return harness;
}

async function runTool(
  harness: ExtensionHarness,
  name: string,
  parameters: Readonly<Record<string, string | number>>,
) {
  const tool = harness.runner.getToolDefinition(name);
  if (tool === undefined) throw new Error(`Expected ${name}`);
  return tool.execute(
    name,
    parameters,
    undefined,
    undefined,
    toToolContext(harness.runner.createContext()),
  );
}

async function runCommand(harness: ExtensionHarness, args: string): Promise<void> {
  const command = harness.runner.getCommand("lsp");
  if (command === undefined) throw new Error("Expected /lsp");
  await command.handler(args, harness.runner.createCommandContext());
}

/** The `lsp_status` text and the Structured Result's first server entry. */
async function status(harness: ExtensionHarness) {
  const result = await runTool(harness, "lsp_status", {});
  const [part] = result.content;
  return {
    text: part?.type === "text" ? part.text : "",
    server: Value.Parse(StatusServersSchema, result.structuredContent).servers[0],
  };
}

const StatusServersSchema = Type.Object(
  {
    servers: Type.Array(
      Type.Object(
        {
          state: Type.String(),
          error: Type.Optional(Type.String()),
          shared_with_sessions: Type.Optional(Type.Integer()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a parent and a child session on `project` and route both to its fake server, returning the
 * process ID of the one launch they share.
 */
async function openLeasingSessions(project: SharedProject) {
  const parent = await openSession(project);
  const child = await openSession(project);
  const start = { server_id: "fake", file_path: project.filePath };
  await runTool(parent, "lsp_capabilities", start);
  await runTool(child, "lsp_capabilities", start);
  const launches = await project.launches();
  const [pid] = launches;
  if (pid === undefined) throw new Error("Expected a launch");
  return { parent, child, start, launches, pid };
}

afterEach(async () => {
  await Promise.all(openSessions.splice(0).map((harness) => shutdownExtension(harness)));
  const leftOver = resetSharedServerInstancePool();
  await removeHarnessDirectories();
  expect(leftOver).toBe(0);
});

describe("Server Instances shared across sessions in one Pi process", () => {
  test("two sessions with one cwd and identical settings launch one process per Server Definition and root", async () => {
    const project = await createSharedProject();

    const { launches } = await openLeasingSessions(project);

    expect(launches).toHaveLength(1);
  });

  test("a project override only one session sees gets its own process", async () => {
    const project = await createSharedProject();
    const { cwd, agentDirectory } = project.directories;
    const globalSettings = JSON.parse(
      await readFile(resolve(agentDirectory, "settings.json"), "utf8"),
    );
    await mkdir(resolve(cwd, ".pi"));
    await writeFile(
      resolve(cwd, ".pi/settings.json"),
      JSON.stringify({
        lsp: {
          servers: {
            fake: { ...globalSettings.lsp.servers.fake, settings: { project: true } },
          },
        },
      }),
    );
    const trusting = await openSession(project, true);
    const untrusting = await openSession(project, false);
    const start = { server_id: "fake", file_path: project.filePath };

    await runTool(trusting, "lsp_capabilities", start);
    await runTool(untrusting, "lsp_capabilities", start);

    expect(await project.launches()).toHaveLength(2);
  });
  test("sessions routing to a cold instance at once share one launch", async () => {
    const project = await createSharedProject({ FAKE_INITIALIZE_DELAY_MS: "200" });
    const parent = await openSession(project);
    const child = await openSession(project);
    const start = { server_id: "fake", file_path: project.filePath };

    await Promise.all([
      runTool(parent, "lsp_capabilities", start),
      runTool(child, "lsp_capabilities", start),
    ]);

    expect(await project.launches()).toHaveLength(1);
  });

  test("a startup continues when the session that triggered it shuts down while another holds a lease", async () => {
    const project = await createSharedProject({ FAKE_INITIALIZE_DELAY_MS: "300" });
    const parent = await openSession(project);
    const child = await openSession(project);
    const start = { server_id: "fake", file_path: project.filePath };

    const triggered = runTool(parent, "lsp_capabilities", start);
    triggered.catch(() => undefined);
    await expect.poll(() => project.launches()).toHaveLength(1);
    const joined = runTool(child, "lsp_capabilities", start);
    await expect.poll(async () => (await status(child)).server?.state).toBe("starting");
    await shutdownExtension(parent);

    await expect(joined).resolves.toMatchObject({ structuredContent: { server_id: "fake" } });
    await expect(triggered).rejects.toThrow("session runtime is shut down");
    expect(await project.launches()).toHaveLength(1);
    expect((await status(child)).server?.state).toBe("running");
  });

  test("a restart during a shared startup reports a fresh running instance, not the stopped startup's failure", async () => {
    const project = await createSharedProject({ FAKE_INITIALIZE_DELAY_MS: "300" });
    const parent = await openSession(project);
    const child = await openSession(project);
    const start = { server_id: "fake", file_path: project.filePath };

    const starting = runTool(parent, "lsp_capabilities", start);
    starting.catch(() => undefined);
    // The first process is launched and waiting to answer initialize.
    await expect.poll(() => project.launches()).toHaveLength(1);
    const restarted = await runTool(child, "lsp_restart", start);

    expect(restarted.structuredContent).toMatchObject({ server_id: "fake" });
    await expect(starting).rejects.toThrow("Instance was stopped during startup");
    expect((await status(child)).server).toMatchObject({ state: "running" });
    expect((await status(child)).server?.error).toBeUndefined();
    await runTool(parent, "lsp_capabilities", start);
    expect((await status(parent)).server).toMatchObject({
      state: "running",
      shared_with_sessions: 1,
    });
    expect(await project.launches()).toHaveLength(2);
  });

  test("an instance stops when its last leaseholder shuts down, and a session that never routes to it takes no lease", async () => {
    const project = await createSharedProject();
    const { parent, child, pid } = await openLeasingSessions(project);
    const bystander = await openSession(project);

    await shutdownExtension(child);
    expect(isRunning(pid)).toBe(true);
    expect((await status(parent)).server).toMatchObject({ state: "running" });
    expect((await status(parent)).server?.shared_with_sessions).toBeUndefined();

    await shutdownExtension(parent);
    expect(isRunning(pid)).toBe(false);
    expect((await status(bystander)).text).toBe(
      "No Server Instances started.\n+1 configured, not started (pass all: true to list)",
    );
  });

  test("/lsp stop in one session stops the process for both, and each relaunches it lazily", async () => {
    const project = await createSharedProject();
    const { parent, child, start, pid } = await openLeasingSessions(project);

    await runCommand(parent, `stop fake ${JSON.stringify(project.directories.cwd)}`);

    expect(isRunning(pid)).toBe(false);
    expect((await status(parent)).server?.state).toBe("stopped");
    expect((await status(child)).server?.state).toBe("stopped");
    await runTool(child, "lsp_capabilities", start);
    await runTool(parent, "lsp_capabilities", start);
    expect(await project.launches()).toHaveLength(2);
    expect((await status(parent)).server).toMatchObject({
      state: "running",
      shared_with_sessions: 1,
    });
  });

  test("a crash makes the instance unavailable in both sessions, and lsp_restart from either recovers both", async () => {
    const project = await createSharedProject();
    const { parent, child, start, pid } = await openLeasingSessions(project);

    process.kill(pid, "SIGKILL");

    await expect.poll(async () => (await status(parent)).server?.state).toBe("unavailable");
    expect((await status(child)).server?.state).toBe("unavailable");
    await expect(runTool(parent, "lsp_capabilities", start)).rejects.toThrow("unavailable");
    await runTool(child, "lsp_restart", start);
    await runTool(parent, "lsp_capabilities", start);
    expect(await project.launches()).toHaveLength(2);
    expect((await status(parent)).server?.state).toBe("running");
  });

  test("disabling the Server Definition in one session releases only its lease", async () => {
    const project = await createSharedProject();
    const { parent, child, start, pid } = await openLeasingSessions(project);

    await runCommand(parent, "disable fake");

    expect(isRunning(pid)).toBe(true);
    expect((await status(parent)).server?.state).toBe("disabled");
    await runTool(child, "lsp_capabilities", start);
    expect(await project.launches()).toHaveLength(1);
    expect((await status(child)).server).toMatchObject({ state: "running" });
    expect((await status(child)).server?.shared_with_sessions).toBeUndefined();
  });

  test("a server-initiated edit becomes a preview only in a sole leaseholder's session", async () => {
    const replyLog = resolve(await makeTemporaryDirectory("pi-lsp-shared-edits-"), "replies.log");
    const project = await createSharedProject({
      FAKE_APPLY_EDIT_ON_HOVER: "1",
      FAKE_APPLY_EDIT_LOG: replyLog,
    });
    const parent = await openSession(project);
    const child = await openSession(project);
    const hover = { file_path: project.filePath, line: 1, character: 1 };

    const sole = await runTool(parent, "lsp_hover", hover);
    const [previewId] = Value.Parse(
      Type.Object({ server_preview_ids: Type.Array(Type.String()) }),
      sole.structuredContent,
    ).server_preview_ids;
    expect(JSON.stringify(sole.content)).toContain("workspace edit captured as preview");

    const shared = await runTool(child, "lsp_hover", hover);
    expect(JSON.stringify(shared.content)).toContain(
      "the shared Server Instance cannot attribute the edit to a session",
    );
    expect(shared.structuredContent).not.toHaveProperty("server_preview_ids");
    const parentNext = await runTool(parent, "lsp_status", {});
    expect(parentNext.structuredContent).not.toHaveProperty("server_preview_ids");
    const replies = (await readFile(replyLog, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    expect(replies).toEqual([
      {
        applied: false,
        failureReason: `Pi LSP: workspace edit captured as preview ${previewId}`,
      },
      {
        applied: false,
        failureReason:
          "Pi LSP: workspace edit preview rejected: the shared Server Instance cannot attribute the edit to a session",
      },
    ]);
  });

  test("a shared instance's stderr file outlives the session that started it and is removed when the instance stops", async () => {
    const project = await createSharedProject({ FAKE_STDERR_BYTES: "16" });
    const { parent, child, pid } = await openLeasingSessions(project);

    await shutdownExtension(parent);
    process.kill(pid, "SIGKILL");
    await expect.poll(async () => (await status(child)).server?.state).toBe("unavailable");
    const stderrPath = /stderr (\S+)\)/u.exec((await status(child)).server?.error ?? "")?.[1];
    if (stderrPath === undefined) throw new Error("Expected the error to cite the stderr file");
    expect(stderrPath.startsWith(parent.sessionDirectory)).toBe(false);
    expect(dirname(dirname(stderrPath))).toBe(tmpdir());
    expect((await stat(dirname(stderrPath))).mode & 0o777).toBe(0o700);
    expect((await stat(stderrPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(stderrPath, "utf8")).toContain("END");

    await runCommand(child, `stop fake ${JSON.stringify(project.directories.cwd)}`);
    await expect(stat(stderrPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("lsp_status and /lsp count the other sessions leasing a running instance", async () => {
    const project = await createSharedProject();
    const parent = await openSession(project);
    const child = await openSession(project);
    const start = { server_id: "fake", file_path: project.filePath };
    await runTool(parent, "lsp_capabilities", start);
    const single = await status(parent);
    const { cwd } = project.directories;
    expect(single.text).toBe(`fake running ${cwd} typescript(.ts)`);
    expect(single.server).not.toHaveProperty("shared_with_sessions");

    await runTool(child, "lsp_capabilities", start);

    for (const session of [parent, child]) {
      const shared = await status(session);
      expect(shared.text).toBe(`fake running ${cwd} typescript(.ts) shared with 1 other session`);
      expect(shared.server?.shared_with_sessions).toBe(1);
    }
    const rows: string[][] = [];
    parent.runner.setUIContext(
      {
        ...parent.runner.getUIContext(),
        select: async (_title, options) => {
          rows.push(options);
          return undefined;
        },
      },
      "rpc",
    );
    await runCommand(parent, "");
    expect(rows).toEqual([
      [expect.stringMatching(/^fake — running — .* — shared with 1 other session$/u)],
    ]);
    await shutdownExtension(child);
    expect((await status(parent)).text).toBe(single.text);
  });

  test("the diagnostics limit holds across sessions sharing one process", async () => {
    const peakLog = resolve(await makeTemporaryDirectory("pi-lsp-shared-peak-"), "peak.log");
    // The server answers pulls only, each after a delay, so concurrent pulls overlap and are counted.
    const project = await createSharedProject(
      { FAKE_PUSH: "none", FAKE_DIAGNOSTIC_LATENCY_MS: "150", FAKE_PEAK_LOG: peakLog },
      { maxConcurrentDiagnostics: 1 },
    );
    const otherFile = resolve(project.directories.cwd, "other.ts");
    await writeFile(otherFile, "const other = 2;\n");
    const parent = await openSession(project);
    const child = await openSession(project);

    await Promise.all([
      runTool(parent, "lsp_diagnostics", { file_path: project.filePath }),
      runTool(child, "lsp_diagnostics", { file_path: otherFile }),
      runTool(parent, "lsp_diagnostics", { file_path: otherFile }),
      runTool(child, "lsp_diagnostics", { file_path: project.filePath }),
    ]);

    expect(await project.launches()).toHaveLength(1);
    expect(await readFile(peakLog, "utf8")).toBe("1");
  });
});
