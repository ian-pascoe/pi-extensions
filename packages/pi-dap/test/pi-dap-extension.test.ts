import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { createPiDapExtension } from "../src/pi-dap-extension.js";
import type { DapSettingsDocumentInput } from "../src/pi-dap-settings.js";

const temporaryDirectories: string[] = [];

interface ExtensionHarness {
  readonly agentDirectory: string;
  readonly notifications: string[];
  readonly runner: ExtensionRunner;
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
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
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

  const modelRuntime = await ModelRuntime.create({
    authPath: resolve(agentDirectory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  runner.bindCore(
    {
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
      setSessionName: (name) => sessionManager.appendSessionInfo(name),
      getSessionName: () => sessionManager.getSessionName(),
      setLabel: (entryId, label) => sessionManager.appendLabelChange(entryId, label),
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => undefined,
      refreshTools: () => undefined,
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => undefined,
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => projectTrusted,
      getSignal: () => undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "Pi DAP lifecycle test",
    },
  );
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
  return { agentDirectory, notifications, runner, sessionDirectory, widgetCalls };
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
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi DAP extension lifecycle", () => {
  test("loads inertly, reloads trust-aware settings, and shuts down idempotently", async () => {
    const harness = await createExtensionHarness(false, {
      dap: { unknownGlobalField: true },
    });

    expect(harness.runner.getAllRegisteredTools()).toEqual([]);
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

  test("surfaces malformed trusted project settings without starting a Debug Adapter", async () => {
    const harness = await createExtensionHarness(true, {});
    await startExtension(harness, "startup");
    expect(harness.notifications).toContainEqual(
      expect.stringContaining("project dap.unknownProjectField"),
    );
    expect(harness.runner.getAllRegisteredTools()).toHaveLength(1);
    await shutdownExtension(harness);
  });
});
