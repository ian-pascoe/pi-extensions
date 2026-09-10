import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as childProcess from "node:child_process";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { Value } from "typebox/value";
import { DapToolResultDetailsSchema, type DapToolParameters } from "../src/dap-tool-contract.js";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type AgentToolUpdateCallback,
  type KeybindingsManager,
  initTheme,
  createAgentSession,
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPiDapExtension } from "../src/pi-dap-extension.js";
import type { DapSettingsDocumentInput } from "../src/pi-dap-settings.js";

// oxlint-disable-next-line anti-slop/no-module-mocking -- SAFETY: Replace only external OS executables; actual installer, sessions, protocol clients, and SDK lifecycle run unchanged.
vi.mock("node:child_process", { spy: true });

const temporaryDirectories: string[] = [];
const agentSessions: AgentSession[] = [];

interface ExtensionHarness {
  readonly agentDirectory: string;
  readonly notifications: string[];
  readonly runner: ExtensionRunner;
  readonly session: AgentSession;
  readonly sessionDirectory: string;
  readonly widgetCalls: readonly { readonly key: string; readonly content: unknown }[];
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createExtensionHarness(
  projectTrusted: boolean,
  globalSettings: DapSettingsDocumentInput,
  mode: "tui" | "rpc" = "rpc",
): Promise<ExtensionHarness> {
  const cwd = await makeTemporaryDirectory("pi-dap-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-dap-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-dap-extension-sessions-");
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(
    resolve(cwd, ".pi/settings.json"),
    JSON.stringify({ dap: { unknownProjectField: true } }),
  );

  const sessionManager = SessionManager.create(cwd, sessionDirectory);
  const settingsManager = SettingsManager.create(cwd, agentDirectory, { projectTrusted });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    settingsManager,
    extensionFactories: [
      {
        name: "pi-dap-lifecycle-test",
        factory: createPiDapExtension(() => agentDirectory),
      },
    ],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  expect(extensions.errors).toEqual([]);
  expect(extensions.extensions).toHaveLength(1);

  const model = getModel("anthropic", "claude-sonnet-4-5");
  if (model === undefined) throw new Error("Pi DAP extension test: missing pinned model");
  const session = (
    await createAgentSession({
      cwd,
      agentDir: agentDirectory,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
    })
  ).session;
  agentSessions.push(session);
  const runner = session.extensionRunner;
  const notifications: string[] = [];
  const widgetCalls: { key: string; content: unknown }[] = [];
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message) => notifications.push(message),
      setWidget: (key, content) => widgetCalls.push({ key, content }),
    },
    mode,
  );
  return {
    agentDirectory,
    notifications,
    get runner() {
      return session.extensionRunner;
    },
    session,
    sessionDirectory,
    widgetCalls,
  };
}

async function startExtension(
  harness: ExtensionHarness,
  reason: "startup" | "reload",
): Promise<void> {
  await harness.runner.emit({ type: "session_start", reason } satisfies SessionStartEvent);
}

async function shutdownExtension(harness: ExtensionHarness): Promise<void> {
  await harness.runner.emit({
    type: "session_shutdown",
    reason: "quit",
  } satisfies SessionShutdownEvent);
}

async function piDapSessionDirectories(sessionDirectory: string): Promise<string[]> {
  return (await readdir(sessionDirectory)).filter((entry) => entry.startsWith("pi-dap-"));
}

afterEach(async () => {
  for (const session of agentSessions.splice(0)) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

interface AcquisitionControl {
  readonly version?: string;
  readonly wait?: boolean;
  readonly fail?: string;
}

async function acquisition(
  harness: ExtensionHarness,
  control: AcquisitionControl = {},
): Promise<void> {
  const store = resolve(harness.agentDirectory, "managed-tools");
  await mkdir(store, { recursive: true });
  await writeFile(
    resolve(store, process.platform === "win32" ? "mise.exe" : "mise"),
    "external fixture",
  );
  await writeFile(
    resolve(store, "fixture.json.next"),
    JSON.stringify({
      ...control,
      adapter: pathToFileURL(resolve(import.meta.dirname, "fixtures/fake-managed-js-adapter.mjs"))
        .href,
      dapFixture: resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs"),
    }),
  );
  await rename(resolve(store, "fixture.json.next"), resolve(store, "fixture.json"));
}

function managed(harness: ExtensionHarness) {
  return new ToolInstaller(resolve(harness.agentDirectory, "managed-tools"));
}
function sdkPrefix(harness: ExtensionHarness): string {
  return JSON.stringify({
    tools: harness.session.agent.state.tools,
    prompt: harness.session.agent.state.systemPrompt,
    history: harness.session.messages,
  });
}
async function dap(
  harness: ExtensionHarness,
  input: DapToolParameters,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
) {
  const tool = harness.runner.getToolDefinition("dap");
  if (!tool) throw new Error("Expected registered DAP tool");
  return tool.execute("managed-sdk", input, signal, onUpdate, harness.runner.createContext());
}
async function update(harness: ExtensionHarness, args = "update") {
  const command = harness.runner.getCommand("dap");
  if (!command) throw new Error("Expected registered DAP command");
  await command.handler(args, harness.runner.createCommandContext());
}
function helperCalls() {
  return vi
    .mocked(childProcess.spawn)
    .mock.calls.filter(([command]) => ["mise", "mise.exe"].includes(basename(command)));
}

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Unexpected network in offline DAP test")),
  );
  vi.stubEnv("PATH", dirname(process.execPath));
  const native = await vi.importActual<typeof childProcess>("node:child_process");
  vi.mocked(childProcess.spawn)
    .mockReset()
    .mockImplementation((command, args, options) => {
      if (["mise", "mise.exe"].includes(basename(command)))
        return native.spawn(
          process.execPath,
          [resolve(import.meta.dirname, "fixtures/fake-dap-mise.cjs"), ...(args ?? []).slice(2)],
          options ?? {},
        );
      // The acquired Python executable is an external protocol fixture; no session/client is mocked.
      if (/[\\/]debugpy[\\/](?:bin|Scripts)[\\/]python(?:\.exe)?$/.test(command))
        return native.spawn(
          process.execPath,
          [resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs")],
          options ?? {},
        );
      return native.spawn(command, args ?? [], options ?? {});
    });
});

// Actual ToolInstaller is used throughout: only OS acquisition/adapter executables are replaced.
describe("managed DAP through the offline SDK", () => {
  test("Installed-only Mode reports missing tools without downloading even the helper", async () => {
    const harness = await createExtensionHarness(false, { dap: { autoInstall: false } });
    await startExtension(harness, "startup");
    await expect(dap(harness, { operation: "launch", program: "app.js" })).rejects.toThrow(
      /installed|download/i,
    );
    expect(harness.notifications).toEqual([]);
    expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
    expect(helperCalls()).toEqual([]);
  });

  test("first launch waits for actual acquisition, publishes a selection and starts the acquired adapter with stable SDK prefixes", async () => {
    const harness = await createExtensionHarness(false, {});
    await acquisition(harness, { wait: true });
    await startExtension(harness, "startup");
    expect(helperCalls()).toEqual([]);
    const before = sdkPrefix(harness);
    const progress = vi.fn();
    const launch = dap(harness, { operation: "launch", program: "app.mjs" }, undefined, progress);
    await vi.waitFor(
      () =>
        expect(JSON.stringify(progress.mock.calls)).toContain("Waiting for acquisition fixture"),
      { timeout: 10_000 },
    );
    expect(await managed(harness).installed("dap-javascript")).toBeUndefined();
    expect(sdkPrefix(harness)).toBe(before);
    await acquisition(harness);
    expect((await launch).details).toMatchObject({
      state: "stopped",
      adapter_id: "javascript",
      profile_id: "javascript",
    });
    expect((await managed(harness).installed("dap-javascript"))?.components.adapter?.version).toBe(
      "1.0.0",
    );
    expect(sdkPrefix(harness)).toBe(before);
    if (process.platform === "darwin") {
      const result = await dap(harness, {
        operation: "evaluate",
        expression: "__fixture_adapter_tmp",
      });
      const details = Value.Parse(DapToolResultDetailsSchema, result.details);
      if (details.presentation?.kind !== "evaluation")
        throw new Error("Expected temporary directory evaluation");
      const temporary = details.presentation.value;
      expect(temporary).toMatch(/^\/tmp\/pi-dap-ipc-/);
      expect(temporary.length).toBeLessThan(40);
      expect((await stat(temporary)).mode & 0o777).toBe(0o700);
      await shutdownExtension(harness);
      await expect(stat(temporary)).rejects.toThrow();
    }
  }, 30_000);

  test.each(["stop", "reload", "abort"] as const)(
    "%s cancels actual first acquisition and permits a clean retry",
    async (action) => {
      const harness = await createExtensionHarness(false, {});
      await acquisition(harness, { wait: true });
      await startExtension(harness, "startup");
      const controller = new AbortController();
      const progress = vi.fn();
      const launch = dap(
        harness,
        { operation: "launch", program: "app.js" },
        controller.signal,
        progress,
      );
      const rejected = expect(launch).rejects.toThrow(/cancel|abort/i);
      await vi.waitFor(
        () =>
          expect(JSON.stringify(progress.mock.calls)).toContain("Waiting for acquisition fixture"),
        { timeout: 10_000 },
      );
      await expect(dap(harness, { operation: "launch", program: "app.js" })).rejects.toThrow(
        "no active Debug Session",
      );
      if (action === "stop") await dap(harness, { operation: "stop" });
      else if (action === "reload") await startExtension(harness, "reload");
      else controller.abort();
      await rejected;
      expect(await managed(harness).installed("dap-javascript")).toBeUndefined();
      await acquisition(harness);
      expect(
        (await dap(harness, { operation: "launch", program: "app.js" })).details,
      ).toMatchObject({ state: "stopped" });
    },
    30_000,
  );

  test("acquisition failure preserves an idle session and SDK prefix and retries successfully", async () => {
    const harness = await createExtensionHarness(false, {});
    await acquisition(harness, { fail: "github:microsoft/vscode-js-debug" });
    await startExtension(harness, "startup");
    const before = sdkPrefix(harness);
    await expect(dap(harness, { operation: "launch", program: "app.js" })).rejects.toThrow(
      "fixture registry unavailable",
    );
    expect((await dap(harness, { operation: "status" })).details).toMatchObject({ state: "idle" });
    expect(await managed(harness).installed("dap-javascript")).toBeUndefined();
    expect(sdkPrefix(harness)).toBe(before);
    await acquisition(harness);
    expect((await dap(harness, { operation: "launch", program: "app.js" })).details).toMatchObject({
      state: "stopped",
    });
  }, 30_000);

  test("Python acquires a private adapter without changing the project's Debuggee interpreter", async () => {
    const harness = await createExtensionHarness(false, {});
    const cwd = harness.runner.createContext().cwd;
    const python = resolve(
      cwd,
      process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
    );
    await mkdir(dirname(python), { recursive: true });
    await copyFile(process.execPath, python);
    vi.stubEnv("PATH", "");
    await acquisition(harness);
    await startExtension(harness, "startup");
    expect((await dap(harness, { operation: "launch", program: "app.py" })).details).toMatchObject({
      state: "stopped",
      adapter_id: "python",
    });
    const installation = await managed(harness).installed("dap-python");
    expect(installation?.components.adapter?.selector).toBe("pipx:debugpy");
    const adapter = resolve(
      installation!.components.adapter!.directory,
      process.platform === "win32" ? "debugpy/Scripts/python.exe" : "debugpy/bin/python",
    );
    expect(vi.mocked(childProcess.spawn).mock.calls.some(([command]) => command === adapter)).toBe(
      true,
    );
    const result = await dap(harness, {
      operation: "evaluate",
      expression: "__fixture_launch_arguments",
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(JSON.stringify(python).slice(1, -1).replaceAll("\\", "\\\\")),
    });
    expect(await readdir(dirname(python))).toEqual([
      process.platform === "win32" ? "python.exe" : "python",
    ]);
  }, 30_000);

  test.each(["project", "PATH"] as const)(
    "%s JavaScript adapters and runtimes take precedence without acquisition",
    async (location) => {
      const harness = await createExtensionHarness(false, {});
      const cwd = harness.runner.createContext().cwd;
      const root = resolve(cwd, "nested package 空間");
      const bin =
        location === "project" ? resolve(root, "node_modules/.bin") : resolve(cwd, "external bin");
      const script =
        location === "project"
          ? resolve(root, "node_modules/@vscode/js-debug/src/dapDebugServer.js")
          : resolve(bin, "dapDebugServer.js");
      await mkdir(bin, { recursive: true });
      await mkdir(dirname(script), { recursive: true });
      await mkdir(root, { recursive: true });
      const node = resolve(bin, process.platform === "win32" ? "node.exe" : "node");
      await copyFile(process.execPath, node);
      await copyFile(resolve(import.meta.dirname, "fixtures/fake-managed-js-adapter.mjs"), script);
      await writeFile(resolve(dirname(script), "package.json"), '{"type":"module"}');
      vi.stubEnv(
        "PI_DAP_FIXTURE",
        resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs"),
      );
      vi.stubEnv("PATH", location === "PATH" ? bin : dirname(process.execPath));
      const originalPath = process.env.PATH;
      await startExtension(harness, "startup");
      for (const extension of ["js", "mjs", "cjs"]) {
        await dap(harness, { operation: "launch", program: resolve(root, `app.${extension}`) });
        const result = await dap(harness, {
          operation: "evaluate",
          expression: "__fixture_launch_arguments",
        });
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining(JSON.stringify(node).slice(1, -1).replaceAll("\\", "\\\\")),
        });
        await dap(harness, { operation: "stop" });
      }
      expect(helperCalls()).toEqual([]);
      expect(process.env.PATH).toBe(originalPath);
    },
    30_000,
  );

  test.each([
    { adapters: { javascript: null } },
    { adapters: { javascript: { command: "broken" } } },
    { profiles: { javascript: null } },
    { profiles: { javascript: { adapter: "missing", arguments: {} } } },
    { profiles: { custom: null } },
  ])("explicit or quarantined settings never resurrect a built-in: %j", async (settings) => {
    const harness = await createExtensionHarness(false, { dap: settings });
    await startExtension(harness, "startup");
    await expect(dap(harness, { operation: "launch", program: "app.js" })).rejects.toThrow(
      /Launch Profile|profile/,
    );
    expect(helperCalls()).toEqual([]);
  });

  test.each(["app.ts", "app.tsx", "app.jsx", "app.pyc", "package.json"])(
    "%s requires an explicit Launch Profile without acquisition",
    async (program) => {
      const harness = await createExtensionHarness(false, {});
      await startExtension(harness, "startup");
      await expect(dap(harness, { operation: "launch", program })).rejects.toThrow(
        /Launch Profile|profile/,
      );
      expect(helperCalls()).toEqual([]);
    },
  );

  test("failed explicit selected and sole profiles never fall back to managed adapters", async () => {
    const harness = await createExtensionHarness(false, {
      dap: {
        adapters: {
          custom: { command: "pi-dap-definitely-not-an-executable", transport: "stdio" },
        },
        profiles: { custom: { adapter: "custom", arguments: {} } },
      },
    });
    await startExtension(harness, "startup");
    await expect(dap(harness, { operation: "launch", program: "app.py" })).rejects.toThrow(
      "pi-dap-definitely-not-an-executable",
    );
    await expect(
      dap(harness, { operation: "launch", program: "app.js", profile: "custom" }),
    ).rejects.toThrow("pi-dap-definitely-not-an-executable");
    expect(helperCalls()).toEqual([]);
  });

  test("update all leaves unused tools alone without acquiring a helper", async () => {
    const harness = await createExtensionHarness(false, {});
    await startExtension(harness, "startup");
    await update(harness);
    await update(harness, "update python");
    expect(helperCalls()).toEqual([]);
    expect(harness.notifications.join("\n")).toContain("no installed managed DAP presets");
  });

  test("updates preserve live executables and stable SDK prefixes; Installed-only Mode reuses the new selection on next launch", async () => {
    const harness = await createExtensionHarness(false, {});
    await acquisition(harness);
    await startExtension(harness, "startup");
    await dap(harness, { operation: "launch", program: "app.js" });
    const before = sdkPrefix(harness);
    await acquisition(harness, { version: "2.0.0" });
    await update(harness);
    expect(sdkPrefix(harness)).toBe(before);
    expect(harness.notifications.join("\n")).toContain("adapter 1.0.0 → node 2.0.0, adapter 2.0.0");
    expect(await managed(harness).installed("dap-python")).toBeUndefined();
    const old = await dap(harness, {
      operation: "evaluate",
      expression: "__fixture_adapter_version",
    });
    expect(old.details).toMatchObject({ presentation: { kind: "evaluation", value: "1.0.0" } });
    await dap(harness, { operation: "stop" });
    await writeFile(
      resolve(harness.agentDirectory, "settings.json"),
      JSON.stringify({ dap: { autoInstall: false } }),
    );
    await startExtension(harness, "reload");
    const callsBefore = helperCalls().length;
    await dap(harness, { operation: "launch", program: "app.js" });
    const next = await dap(harness, {
      operation: "evaluate",
      expression: "__fixture_adapter_version",
    });
    expect(next.details).toMatchObject({ presentation: { kind: "evaluation", value: "2.0.0" } });
    expect(helperCalls()).toHaveLength(callsBefore);
  }, 30_000);

  test("updates report no-change and per-tool failures while retaining working selections", async () => {
    const harness = await createExtensionHarness(false, {});
    await acquisition(harness);
    await startExtension(harness, "startup");
    await dap(harness, { operation: "launch", program: "app.js" });
    await dap(harness, { operation: "stop" });
    await update(harness, "update javascript");
    expect(harness.notifications.join("\n")).toContain("(no change)");
    vi.stubEnv("PATH", "");
    await dap(harness, { operation: "launch", program: "app.py" });
    await dap(harness, { operation: "stop" });
    await acquisition(harness, { version: "2.0.0", fail: "pipx:debugpy" });
    await update(harness);
    expect(harness.notifications.join("\n")).toContain("update failed:");
    expect((await managed(harness).installed("dap-javascript"))?.components.adapter?.version).toBe(
      "2.0.0",
    );
    expect((await managed(harness).installed("dap-python"))?.components.adapter?.version).toBe(
      "1.0.0",
    );
  }, 30_000);

  test.each(["cancel", "reload", "Escape"] as const)(
    "idle update %s cancels the actual installer before closing its operation",
    async (action) => {
      const harness = await createExtensionHarness(false, {}, action === "Escape" ? "tui" : "rpc");
      await acquisition(harness);
      await startExtension(harness, "startup");
      await dap(harness, { operation: "launch", program: "app.js" });
      await dap(harness, { operation: "stop" });
      await acquisition(harness, { version: "2.0.0", wait: true });
      const ui = harness.runner.getUIContext();
      const progress: string[] = [];
      let closed = false;
      let component: Component | undefined;
      const setStatus = (_key: string, value: string | undefined) => {
        if (value) progress.push(value);
      };
      if (action === "Escape") {
        initTheme("dark", false);
        harness.runner.setUIContext(
          {
            ...ui,
            setStatus,
            custom: (factory) =>
              new Promise((done) => {
                // SAFETY: Native BorderedLoader only needs requestRender; its injected keybindings argument is unused.
                void Promise.resolve(
                  factory(
                    { requestRender: () => undefined } as TUI,
                    ui.theme,
                    {} as KeybindingsManager,
                    (result) => {
                      closed = true;
                      done(result);
                    },
                  ),
                ).then((value) => {
                  component = value;
                });
              }),
          },
          "tui",
        );
      } else harness.runner.setUIContext({ ...ui, setStatus }, "rpc");
      const updating = update(harness);
      await vi.waitFor(
        () => expect(progress.join("\n")).toContain("Waiting for acquisition fixture"),
        { timeout: 10_000 },
      );
      if (action === "cancel") await update(harness, "update cancel");
      else if (action === "reload") await startExtension(harness, "reload");
      else {
        component?.handleInput?.("\u001b");
        expect(closed).toBe(false);
      }
      await updating;
      if (action === "Escape") expect(closed).toBe(true);
      expect(
        (await managed(harness).installed("dap-javascript"))?.components.adapter?.version,
      ).toBe("1.0.0");
      expect(harness.notifications.join("\n")).toContain("update cancelled");
    },
    30_000,
  );
});

describe("Pi DAP extension lifecycle", () => {
  test("restores the rendered DAP tool before reload session startup", async () => {
    const harness = await createExtensionHarness(false, {});
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: harness.runner.getUIContext(),
    });

    let definitionDuringTranscriptRebuild: unknown;
    await harness.session.reload({
      beforeSessionStart: () => {
        definitionDuringTranscriptRebuild = harness.session.getToolDefinition("dap");
      },
    });

    expect(definitionDuringTranscriptRebuild).toMatchObject({
      name: "dap",
      renderCall: expect.any(Function),
      renderResult: expect.any(Function),
    });
    await shutdownExtension(harness);
  });

  test("loads the tool eagerly, reloads trust-aware settings, and shuts down idempotently", async () => {
    const harness = await createExtensionHarness(false, {
      dap: { unknownGlobalField: true },
    });

    expect(harness.runner.getAllRegisteredTools().map(({ definition }) => definition.name)).toEqual(
      ["dap"],
    );
    expect(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);

    await startExtension(harness, "startup");
    expect(harness.runner.getAllRegisteredTools().map(({ definition }) => definition.name)).toEqual(
      ["dap"],
    );
    expect(harness.runner.getToolDefinition("dap")).toMatchObject({
      renderCall: expect.any(Function),
      renderResult: expect.any(Function),
    });
    expect(harness.notifications).toEqual([
      expect.stringContaining("global dap.unknownGlobalField"),
    ]);
    expect(harness.notifications[0]).not.toContain("unknownProjectField");
    const firstDirectories = await piDapSessionDirectories(harness.sessionDirectory);
    expect(firstDirectories).toHaveLength(1);

    const tool = harness.runner.getToolDefinition("dap");
    if (tool === undefined) throw new Error("Expected registered DAP tool");
    const status = await tool.execute(
      "status",
      { operation: "status" },
      undefined,
      undefined,
      harness.runner.createContext(),
    );
    expect(status.details).toMatchObject({ operation: "status", state: "idle" });

    harness.notifications.length = 0;
    await writeFile(resolve(harness.agentDirectory, "settings.json"), "{}");
    await startExtension(harness, "reload");
    expect(harness.notifications).toEqual([]);
    const reloadedDirectories = await piDapSessionDirectories(harness.sessionDirectory);
    expect(reloadedDirectories).toHaveLength(1);
    expect(reloadedDirectories).not.toEqual(firstDirectories);
    expect(harness.runner.getAllRegisteredTools()).toHaveLength(1);

    await Promise.all([shutdownExtension(harness), shutdownExtension(harness)]);
    expect(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);
  });

  test("mounts only in TUI mode and disposes the old Observer widget on reload", async () => {
    const fakeAdapterPath = resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs");
    const harness = await createExtensionHarness(
      false,
      {
        dap: {
          timeouts: { executionMs: 20 },
          adapters: {
            node: {
              command: process.execPath,
              args: [fakeAdapterPath],
              transport: "stdio",
            },
          },
          profiles: {
            node: { adapter: "node", arguments: { neverStop: true, stopOnEntry: false } },
          },
        },
      },
      "tui",
    );
    await startExtension(harness, "startup");
    const tool = harness.runner.getToolDefinition("dap");
    if (tool === undefined) throw new Error("Expected registered DAP tool");
    await tool.execute(
      "launch",
      { operation: "launch" },
      undefined,
      undefined,
      harness.runner.createContext(),
    );
    expect(harness.widgetCalls).toContainEqual({ key: "pi-dap", content: expect.any(Function) });

    await startExtension(harness, "reload");
    expect(harness.widgetCalls.at(-1)).toEqual({ key: "pi-dap", content: undefined });
    await shutdownExtension(harness);

    const rpc = await createExtensionHarness(false, {});
    await startExtension(rpc, "startup");
    const rpcTool = rpc.runner.getToolDefinition("dap");
    if (rpcTool === undefined) throw new Error("Expected registered DAP tool");
    await expect(
      rpcTool.execute(
        "launch",
        { operation: "launch" },
        undefined,
        undefined,
        rpc.runner.createContext(),
      ),
    ).rejects.toThrow("launch requires profile");
    expect(rpc.widgetCalls).toEqual([]);
    await shutdownExtension(rpc);
  });
});
