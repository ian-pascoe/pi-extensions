import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  type KeybindingsManager,
  initTheme,
  createAgentSession,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolResultEvent,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";
import { POST_EDIT_DIAGNOSTICS_ENTRY_TYPE } from "../src/lsp-post-edit-diagnostics-rendering.js";
import { LspWorkspaceEditStore } from "../src/lsp-workspace-edit.js";
import type { LspSettingsDocumentInput } from "../src/pi-lsp-settings.js";
import { serializeAnthropicRequest } from "./fixtures/serialize-anthropic-request.js";

// Replace only the external acquisition executable, retaining the installer and LSP client.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const temporaryDirectories: string[] = [];
const agentSessions: AgentSession[] = [];
const harnessRunners: ExtensionRunner[] = [];

const typescriptSettings = {
  lsp: {
    servers: {
      typescript: {
        command: "missing-lsp-test-server",
        languages: [{ extensions: [".ts"], languageId: "typescript" }],
      },
    },
  },
};

interface ExtensionHarness {
  readonly agentDirectory: string;
  readonly notifications: string[];
  readonly resourceLoader: DefaultResourceLoader;
  readonly runner: ExtensionRunner;
  readonly sessionDirectory: string;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly statuses: (string | undefined)[];
  setSignal(signal: AbortSignal | undefined): void;
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

async function createExtensionHarness(
  projectTrusted: boolean,
  globalSettings: LspSettingsDocumentInput = {},
  presets = false,
): Promise<ExtensionHarness> {
  const cwd = await makeTemporaryDirectory("pi-lsp-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-lsp-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-lsp-extension-sessions-");
  const wire = JSON.parse(JSON.stringify(globalSettings));
  if (!presets) {
    wire.lsp ??= {};
    wire.lsp.servers = {
      typescript: null,
      pyright: null,
      gopls: null,
      "rust-analyzer": null,
      ...wire.lsp.servers,
    };
  }
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(wire));
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(
    resolve(cwd, ".pi/settings.json"),
    JSON.stringify({ lsp: { unknownField: true } }),
  );

  const sessionManager = SessionManager.create(cwd, sessionDirectory);
  const settingsManager = SettingsManager.create(cwd, agentDirectory, { projectTrusted });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    settingsManager,
    extensionFactories: [
      {
        name: "pi-lsp-lifecycle-test",
        factory: createPiLspExtension({ getAgentDirectory: () => agentDirectory }),
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
  let signal: AbortSignal | undefined;
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
      getSignal: () => signal,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "Pi LSP lifecycle test",
    },
  );
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message) => notifications.push(message),
      setStatus: (_key, text) => {
        statuses.push(text);
      },
    },
    "rpc",
  );
  harnessRunners.push(runner);
  return {
    agentDirectory,
    notifications,
    resourceLoader,
    runner,
    sessionDirectory,
    sessionManager,
    settingsManager,
    statuses,
    setSignal: (value) => {
      signal = value;
    },
  };
}

async function externalTypeScript(directory: string, name: string, version: string) {
  await mkdir(directory, { recursive: true });
  const script = resolve(directory, "typescript-fixture.cjs");
  await writeFile(
    script,
    `if (process.argv.includes("--version")) console.log("Version ${version}"); else { process.env.FAKE_SYMBOL_NAME = ${JSON.stringify(name)}; import(${JSON.stringify(new URL("fixtures/fake-lsp-server.mjs", import.meta.url).href)}); }\n`,
  );
  const command = resolve(directory, process.platform === "win32" ? "tsc.cmd" : "tsc");
  await writeFile(
    command,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0typescript-fixture.cjs" %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
  );
  await chmod(command, 0o755);
}

async function managedHarness(settings: LspSettingsDocumentInput = {}) {
  const harness = await createExtensionHarness(false, settings, true);
  const store = resolve(harness.agentDirectory, "managed-tools");
  await mkdir(store);
  await writeFile(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
  const control = async (options: { wait?: boolean; fail?: boolean; version?: string }) =>
    writeFile(
      resolve(store, "fixture.json"),
      JSON.stringify({
        ...options,
        server: new URL("fixtures/fake-lsp-server.mjs", import.meta.url).href,
      }),
    );
  await control({});
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation((command, args, options) =>
    /mise(?:\.exe)?$/u.test(String(command))
      ? original.spawn(
          process.execPath,
          [
            fileURLToPath(new URL("fixtures/managed-mise.cjs", import.meta.url)),
            ...(args ?? []).slice(2),
          ],
          options ?? {},
        )
      : original.spawn(command, args ?? [], options ?? {}),
  );
  vi.stubEnv("PATH", "");
  vi.stubGlobal("fetch", () => Promise.reject(new Error("Unexpected network")));
  await writeFile(
    resolve(harness.sessionManager.getCwd(), "source.ts"),
    "export const answer = 42;\n",
  );
  return { harness, store, control };
}

async function startExtension(harness: ExtensionHarness): Promise<void> {
  await harness.runner.emit({
    type: "session_start",
    reason: "startup",
  } satisfies SessionStartEvent);
}

async function shutdownExtension(harness: ExtensionHarness): Promise<void> {
  await harness.runner.emit({
    type: "session_shutdown",
    reason: "quit",
  } satisfies SessionShutdownEvent);
}

function completedAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Applied changes" }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function piLspSessionDirectories(sessionDirectory: string): Promise<string[]> {
  return (await readdir(sessionDirectory)).filter((entry) => entry.startsWith("pi-lsp-"));
}

beforeEach(() => {
  vi.stubGlobal("fetch", () =>
    Promise.reject(new Error("Unexpected network in offline LSP tests")),
  );
});

afterEach(async () => {
  for (const runner of harnessRunners.splice(0))
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementation(original.spawn);
  for (const session of agentSessions.splice(0)) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi LSP extension lifecycle", () => {
  test("cancels a hung external TypeScript version shim and its subprocess before returning", async () => {
    const harness = await createExtensionHarness(false, { lsp: { autoInstall: false } }, true);
    const cwd = harness.sessionManager.getCwd();
    const bin = resolve(cwd, "node_modules", ".bin");
    await externalTypeScript(bin, "unused", "7.0.2");
    const marker = resolve(cwd, "probe-pids");
    await writeFile(
      resolve(bin, "typescript-fixture.cjs"),
      `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid)); setInterval(() => {}, 1000);\n`,
    );
    vi.stubEnv("PATH", "");
    await startExtension(harness);
    try {
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      const controller = new AbortController();
      const pending = tool.execute(
        "probe",
        { operation: "document_symbols", file_path: "source.ts" },
        controller.signal,
        undefined,
        harness.runner.createContext(),
      );
      const cancelled = expect(pending).rejects.toThrow("cancelled");
      await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("");
      const pid = Number(await readFile(marker, "utf8"));
      controller.abort();
      await cancelled;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
      expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
    } finally {
      await shutdownExtension(harness);
    }
  });

  test("cancels one concurrent caller without cancelling its sibling acquisition and reuses the installation without a helper", async () => {
    const { harness, store, control } = await managedHarness();
    await control({ wait: true });
    await startExtension(harness);
    try {
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      const controller = new AbortController();
      const first = tool.execute(
        "cancel-me",
        { operation: "document_symbols", file_path: "source.ts" },
        controller.signal,
        undefined,
        harness.runner.createContext(),
      );
      const cancelled = expect(first).rejects.toThrow("cancelled");
      let settled = false;
      const second = tool
        .execute(
          "keep-me",
          { operation: "document_symbols", file_path: "source.ts" },
          undefined,
          (result) => {
            for (const item of result.content ?? [])
              if (item.type === "text") harness.statuses.push(item.text);
          },
          harness.runner.createContext(),
        )
        .finally(() => {
          settled = true;
        });
      await expect.poll(() => harness.statuses.join("\n")).toContain("Installing");
      controller.abort();
      await cancelled;
      expect(settled).toBe(false);
      await writeFile(resolve(store, "release"), "");
      expect(await second).toMatchObject({
        details: { server_outcomes: [{ server_id: "typescript", outcome: "success" }] },
      });
      await rm(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"));
      await writeFile(
        resolve(harness.agentDirectory, "settings.json"),
        JSON.stringify({ lsp: { autoInstall: false } }),
      );
      await harness.runner.emit({ type: "session_start", reason: "reload" });
      expect(
        await tool.execute(
          "offline",
          { operation: "document_symbols", file_path: "source.ts" },
          undefined,
          undefined,
          harness.runner.createContext(),
        ),
      ).toMatchObject({ content: [{ text: expect.stringContaining("7.0.2") }] });
      expect(await readdir(store)).not.toContain(
        process.platform === "win32" ? "mise.exe" : "mise",
      );
    } finally {
      await shutdownExtension(harness);
    }
  });

  test("keeps multiple Explicit Definitions and a labeled failing command without substituting defaults", async () => {
    const fake = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));
    const languages = [{ extensions: [".ts"], languageId: "typescript" }];
    const harness = await createExtensionHarness(
      false,
      {
        lsp: {
          autoInstall: true,
          servers: {
            customA: { command: process.execPath, args: [fake], languages },
            customB: { command: process.execPath, args: [fake], languages },
            customBroken: { command: "explicit-command-must-not-be-replaced", languages },
          },
        },
      },
      true,
    );
    await writeFile(
      resolve(harness.sessionManager.getCwd(), "source.ts"),
      "export const answer = 42;\n",
    );
    await startExtension(harness);
    try {
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      const result = await tool.execute(
        "explicit",
        { operation: "document_symbols", file_path: "source.ts" },
        undefined,
        undefined,
        harness.runner.createContext(),
      );
      expect(result.details).toMatchObject({
        server_outcomes: [
          { server_id: "customA", outcome: "success" },
          { server_id: "customB", outcome: "success" },
          { server_id: "customBroken", outcome: "unavailable" },
        ],
      });
      expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
    } finally {
      await shutdownExtension(harness);
    }
  });

  test.each(["tui", "rpc"] as const)(
    "cancels idle Tool Updates in %s and waits for cleanup before allowing another update",
    async (mode) => {
      const { harness, control, store } = await managedHarness();
      await startExtension(harness);
      const tool = harness.runner.getToolDefinition("lsp");
      const command = harness.runner.getCommand("lsp");
      if (!tool || !command) throw new Error("Expected lsp");
      await tool.execute(
        "install",
        { operation: "document_symbols", file_path: "source.ts" },
        undefined,
        undefined,
        harness.runner.createContext(),
      );
      await control({ version: "7.1.0", wait: true });
      let component: Component | undefined;
      let closed = false;
      const tui = new TuiMainScreen(new ProcessTerminal());
      const render = vi.spyOn(tui, "requestRender").mockImplementation(() => {});
      if (mode === "tui") {
        initTheme("dark");
        const keybindingApi: {
          KeybindingsManager: { create(directory: string): KeybindingsManager };
        } = await import(
          new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
            .href
        );
        harness.runner.setUIContext(
          {
            ...harness.runner.getUIContext(),
            custom: (factory) =>
              new Promise((done) => {
                void Promise.resolve(
                  factory(
                    tui,
                    harness.runner.getUIContext().theme,
                    keybindingApi.KeybindingsManager.create(harness.agentDirectory),
                    (value) => {
                      closed = true;
                      done(value);
                    },
                  ),
                ).then((value) => {
                  component = value;
                });
              }),
          },
          "tui",
        );
      }
      try {
        const pending = command.handler("update typescript", harness.runner.createCommandContext());
        await expect.poll(() => harness.statuses.join("\n")).toContain("Installing");
        if (mode === "tui") {
          component?.handleInput?.("\u001b");
          expect(closed).toBe(false);
        } else await command.handler("update cancel", harness.runner.createCommandContext());
        await pending;
        expect(harness.notifications.at(-1)).toContain("cancelled");
        expect(harness.statuses.at(-1)).toBeUndefined();
        expect(
          await tool.execute(
            "old",
            { operation: "document_symbols", file_path: "source.ts" },
            undefined,
            undefined,
            harness.runner.createContext(),
          ),
        ).toMatchObject({ content: [{ text: expect.stringContaining("7.0.2") }] });
        await writeFile(resolve(store, "release"), "");
        await command.handler("update typescript", harness.runner.createCommandContext());
        expect(harness.notifications.at(-1)).toContain("7.1.0");
        if (mode === "tui") expect(closed).toBe(true);
      } finally {
        render.mockRestore();
        await shutdownExtension(harness);
      }
    },
    15_000,
  );

  test.each(["7.0.2", "6.0.0"])(
    "prefers eligible project then PATH TypeScript shims without managing External Installations (project %s)",
    async (version) => {
      const harness = await createExtensionHarness(false, { lsp: { autoInstall: false } }, true);
      const cwd = harness.sessionManager.getCwd();
      const pathBin = await makeTemporaryDirectory("pi-lsp-path 空間 ");
      await externalTypeScript(resolve(cwd, "node_modules", ".bin"), "project-server", version);
      await externalTypeScript(pathBin, "path-server", "7.0.2");
      await copyFile(
        process.execPath,
        resolve(pathBin, process.platform === "win32" ? "node.exe" : "node"),
      );
      await chmod(resolve(pathBin, process.platform === "win32" ? "node.exe" : "node"), 0o755);
      vi.stubEnv("PATH", pathBin);
      await writeFile(resolve(cwd, "source.ts"), "export const answer = 42;\n");
      await startExtension(harness);
      try {
        const tool = harness.runner.getToolDefinition("lsp");
        const command = harness.runner.getCommand("lsp");
        if (!tool || !command) throw new Error("Expected lsp");
        expect(
          await tool.execute(
            "external",
            { operation: "document_symbols", file_path: "source.ts" },
            undefined,
            undefined,
            harness.runner.createContext(),
          ),
        ).toMatchObject({
          content: [
            {
              text: expect.stringContaining(
                version.startsWith("7") ? "project-server" : "path-server",
              ),
            },
          ],
        });
        await command.handler("update", harness.runner.createCommandContext());
        expect(harness.notifications.at(-1)).toContain(
          "External Installations were left untouched",
        );
        expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
        expect(process.env.PATH).toBe(pathBin);
      } finally {
        await shutdownExtension(harness);
      }
    },
  );

  test("retains the external Rust toolchain policy when reusing a managed rust-analyzer", async () => {
    const { harness, store, control } = await managedHarness();
    await control({ version: "1.98.1" });
    vi.stubEnv("RUSTUP_TOOLCHAIN", undefined);
    const cwd = harness.sessionManager.getCwd();
    await writeFile(resolve(cwd, "source.rs"), "fn main() {}\n");
    await startExtension(harness);
    try {
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      const symbols = () =>
        tool.execute(
          "rust-symbols",
          { operation: "document_symbols", file_path: "source.rs" },
          undefined,
          undefined,
          harness.runner.createContext(),
        );
      expect(await symbols()).toMatchObject({
        content: [{ text: expect.stringContaining("RUSTUP_TOOLCHAIN=1.98.1") }],
      });
      const bin = resolve(cwd, "bin");
      await mkdir(bin);
      for (const name of ["rustc", "cargo"]) {
        const executable = resolve(bin, name + (process.platform === "win32" ? ".exe" : ""));
        await copyFile(process.execPath, executable);
        await chmod(executable, 0o755);
      }
      await rm(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"));
      for (const toolchain of ["nightly-user", undefined]) {
        vi.stubEnv("RUSTUP_TOOLCHAIN", toolchain);
        await harness.runner.emit({ type: "session_start", reason: "reload" });
        expect(await symbols()).toMatchObject({
          content: [{ text: expect.stringContaining(`RUSTUP_TOOLCHAIN=${toolchain ?? "unset"}`) }],
        });
        expect(process.env.RUSTUP_TOOLCHAIN).toBe(toolchain);
      }
    } finally {
      await shutdownExtension(harness);
    }
  }, 15_000);

  test("resolves an external Node independently while acquiring only missing TypeScript, ignoring a project TypeScript 6 compiler", async () => {
    const { harness, store } = await managedHarness();
    const cwd = harness.sessionManager.getCwd();
    const runtime = resolve(cwd, "bin");
    await mkdir(runtime);
    await copyFile(
      process.execPath,
      resolve(runtime, process.platform === "win32" ? "node.exe" : "node"),
    );
    await chmod(resolve(runtime, process.platform === "win32" ? "node.exe" : "node"), 0o755);
    await externalTypeScript(resolve(cwd, "node_modules", ".bin"), "must-not-run-ts6", "6.0.0");
    await startExtension(harness);
    try {
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      expect(
        await tool.execute(
          "native",
          { operation: "document_symbols", file_path: "source.ts" },
          undefined,
          undefined,
          harness.runner.createContext(),
        ),
      ).toMatchObject({ content: [{ text: expect.stringContaining("7.0.2") }] });
      const installed = JSON.parse(
        await readFile(resolve(store, "selections", "lsp-typescript.json"), "utf8"),
      );
      expect(Object.keys(installed.components)).toEqual(["compiler"]);
      expect(process.env.PATH).toBe("");
    } finally {
      await shutdownExtension(harness);
    }
  });

  test("preserves standalone SDK serialized tools, system and history prefixes through acquire, update and reload while running Instances stay pinned", async () => {
    const { harness, store, control } = await managedHarness();
    await control({ wait: true });
    const model = getModel("anthropic", "claude-sonnet-4-5");
    const modelRuntime = await ModelRuntime.create({
      authPath: resolve(harness.agentDirectory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const { session } = await createAgentSession({
      cwd: harness.sessionManager.getCwd(),
      agentDir: harness.agentDirectory,
      model,
      modelRuntime,
      resourceLoader: harness.resourceLoader,
      sessionManager: harness.sessionManager,
      settingsManager: harness.settingsManager,
    });
    agentSessions.push(session);
    await session.bindExtensions({ mode: "rpc", uiContext: harness.runner.getUIContext() });
    const history = [
      { role: "user" as const, content: "Inspect the source without changing it", timestamp: 1 },
    ];
    session.agent.state.messages = history;
    for (const message of history) session.sessionManager.appendMessage(message);
    const before = await serializeAnthropicRequest(session, history);
    const tool = session.getToolDefinition("lsp");
    const command = session.extensionRunner.getCommand("lsp");
    if (!tool || !command) throw new Error("Expected lsp command and tool");
    const execute = () =>
      tool.execute(
        "symbols",
        { operation: "document_symbols", file_path: "source.ts" },
        undefined,
        (result) => {
          for (const item of result.content ?? [])
            if (item.type === "text") harness.statuses.push(item.text);
        },
        session.extensionRunner.createContext(),
      );
    const first = execute();
    await expect.poll(() => harness.statuses.join("\n")).toContain("Installing");
    expect(await serializeAnthropicRequest(session, history)).toEqual(before);
    await writeFile(resolve(store, "release"), "");
    expect(await first).toMatchObject({ content: [{ text: expect.stringContaining("7.0.2") }] });
    await control({ version: "7.1.0" });
    await command.handler("update typescript", session.extensionRunner.createCommandContext());
    expect(harness.notifications.at(-1)).toContain("7.0.2 →");
    expect(harness.notifications.at(-1)).toContain("7.1.0");
    expect(await execute()).toMatchObject({
      content: [{ text: expect.stringContaining("7.0.2") }],
    });
    await tool.execute(
      "restart",
      { operation: "restart", server_id: "typescript", file_path: "source.ts" },
      undefined,
      undefined,
      session.extensionRunner.createContext(),
    );
    expect(await execute()).toMatchObject({
      content: [{ text: expect.stringContaining("7.1.0") }],
    });
    await control({ version: "7.2.0", fail: true });
    await command.handler("update typescript", session.extensionRunner.createCommandContext());
    expect(harness.notifications.at(-1)).toContain("previous installation retained");
    expect(await execute()).toMatchObject({
      content: [{ text: expect.stringContaining("7.1.0") }],
    });
    expect(await serializeAnthropicRequest(session, history)).toEqual(before);
    expect(session.messages).toEqual(history);
    await session.reload();
    expect(await serializeAnthropicRequest(session, history)).toEqual(before);
    expect(session.messages).toEqual(history);
  }, 15000);

  test.each(["cancel", "failure", "reload"])(
    "preserves successful mutations when first-use assistance ends by %s",
    async (ending) => {
      const { harness, control } = await managedHarness();
      await control(ending === "failure" ? { fail: true } : { wait: true });
      await startExtension(harness);
      const abort = new AbortController();
      harness.setSignal(abort.signal);
      const details = { bytesWritten: 26 };
      const pending = harness.runner.emitToolResult({
        type: "tool_result",
        toolCallId: "managed-write",
        toolName: "write",
        input: { path: "source.ts", content: "export const answer = 42;\n" },
        content: [{ type: "text", text: "Wrote source.ts" }],
        details,
        isError: false,
      });
      await expect.poll(() => harness.statuses.join("\n")).toContain("Installing");
      if (ending === "cancel") abort.abort();
      if (ending === "reload")
        await harness.runner.emit({ type: "session_start", reason: "reload" });
      const result = await pending;
      expect(result?.isError).toBe(false);
      expect(result?.details).toBe(details);
      expect(result?.content?.[0]).toEqual({ type: "text", text: "Wrote source.ts" });
      expect(result?.content?.at(-1)).toMatchObject({
        text: expect.stringContaining("unavailable server"),
      });
      expect(harness.statuses.at(-1)).toBeUndefined();
      if (ending === "reload") {
        await harness.runner.emit({
          type: "turn_end",
          turnIndex: 0,
          message: completedAssistantMessage(),
          toolResults: [],
        });
        expect(harness.sessionManager.getBranch()).toEqual([]);
      }
      await Promise.all([shutdownExtension(harness), shutdownExtension(harness)]);
    },
  );

  test.each([null, { command: "broken", languages: [] }, "disabled"])(
    "never resurrects a null, invalid, or disabled same-ID preset: %j",
    async (definition) => {
      const lsp =
        definition === "disabled"
          ? { autoInstall: false, enablement: { typescript: false } }
          : { autoInstall: false, servers: { typescript: definition } };
      const harness = await createExtensionHarness(false, { lsp }, true);
      await startExtension(harness);
      try {
        const tool = harness.runner.getToolDefinition("lsp");
        if (!tool) throw new Error("Expected lsp");
        await expect(
          tool.execute(
            "blocked",
            { operation: "capabilities", server_id: "typescript", file_path: "source.ts" },
            undefined,
            undefined,
            harness.runner.createContext(),
          ),
        ).rejects.toThrow(definition === "disabled" ? "disabled" : "does not match");
        expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
      } finally {
        await shutdownExtension(harness);
      }
    },
  );

  test("explicit matching definitions under different IDs suppress every fallback even when gated or disabled", async () => {
    const harness = await createExtensionHarness(
      false,
      {
        lsp: {
          autoInstall: false,
          enablement: { disabled: false },
          servers: {
            gated: {
              command: "must-not-run",
              languages: [{ extensions: [".ts"], languageId: "typescript" }],
              requireRootMarker: true,
              rootMarkers: ["required.json"],
            },
            disabled: {
              command: "must-not-run",
              languages: [{ extensions: [".ts"], languageId: "typescript" }],
            },
          },
        },
      },
      true,
    );
    await startExtension(harness);
    try {
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      await expect(
        tool.execute(
          "suppressed",
          { operation: "document_symbols", file_path: "source.ts" },
          undefined,
          undefined,
          harness.runner.createContext(),
        ),
      ).rejects.toThrow("does not match");
      expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
    } finally {
      await shutdownExtension(harness);
    }
  });

  test("waits for first managed acquisition with visible progress, then answers the original document request", async () => {
    const harness = await createExtensionHarness(false, {}, true);
    const store = resolve(harness.agentDirectory, "managed-tools");
    await mkdir(store);
    await writeFile(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
    await writeFile(
      resolve(store, "fixture.json"),
      JSON.stringify({
        wait: true,
        server: new URL("fixtures/fake-lsp-server.mjs", import.meta.url).href,
      }),
    );
    const original =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementation((command, args, options) =>
      /mise(?:\.exe)?$/u.test(String(command))
        ? original.spawn(
            process.execPath,
            [
              fileURLToPath(new URL("fixtures/managed-mise.cjs", import.meta.url)),
              ...(args ?? []).slice(2),
            ],
            options ?? {},
          )
        : original.spawn(command, args ?? [], options ?? {}),
    );
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await writeFile(
        resolve(harness.sessionManager.getCwd(), "source.ts"),
        "export const answer = 42;\n",
      );
      await startExtension(harness);
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      const progress: string[] = [];
      let settled = false;
      const pending = tool
        .execute(
          "first",
          { operation: "document_symbols", file_path: "source.ts" },
          undefined,
          (result) => {
            for (const item of result.content ?? [])
              if (item.type === "text") progress.push(item.text);
          },
          harness.runner.createContext(),
        )
        .finally(() => {
          settled = true;
        });
      await expect.poll(() => progress.join("\n"), { timeout: 1500 }).toContain("Installing");
      expect(settled).toBe(false);
      await writeFile(resolve(store, "release"), "");
      expect(await pending).toMatchObject({
        details: { server_outcomes: [{ server_id: "typescript", outcome: "success" }] },
      });
      const command = harness.runner.getCommand("lsp");
      if (!command) throw new Error("Expected /lsp");
      await command.handler("update", harness.runner.createCommandContext());
      expect(harness.notifications.at(-1)).toContain("typescript: no change");
      expect(harness.notifications.at(-1)).toContain("7.0.2");
      expect(await readdir(resolve(store, "selections"))).toEqual(["lsp-typescript.json"]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = previousPath;
      fetch.mockRestore();
      await shutdownExtension(harness);
      vi.mocked(spawn).mockImplementation(original.spawn);
    }
  }, 15000);
  test("discovers presets without acquisition and reports Installed-only unavailability on first request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    const harness = await createExtensionHarness(false, { lsp: { autoInstall: false } }, true);
    try {
      await startExtension(harness);
      const tool = harness.runner.getToolDefinition("lsp");
      if (!tool) throw new Error("Expected lsp");
      const context = harness.runner.createContext();
      const status = await tool.execute(
        "status",
        { operation: "status" },
        undefined,
        undefined,
        context,
      );
      expect(status.content).toEqual([
        { type: "text", text: expect.stringContaining('"serverId":"gopls"') },
      ]);
      await expect(
        tool.execute(
          "first",
          { operation: "document_symbols", file_path: "main.go" },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toThrow("automatic downloads");
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
    } finally {
      process.env.PATH = previousPath;
      fetch.mockRestore();
      await shutdownExtension(harness);
    }
  });
  test("persists explicit session toggles and rolls them back with selected branch history", async () => {
    const harness = await createExtensionHarness(false, typescriptSettings);
    const before = harness.sessionManager.appendMessage(completedAssistantMessage());
    await startExtension(harness);
    const command = harness.runner.getCommand("lsp");
    if (command === undefined) throw new Error("Expected /lsp command");
    await command.handler("disable typescript", harness.runner.createCommandContext());
    expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-lsp-enablement",
      data: { serverId: "typescript", enabled: false },
    });
    const disabledLeaf = harness.sessionManager.getLeafId();
    const status = async () => {
      const tool = harness.runner.getToolDefinition("lsp");
      if (tool === undefined) throw new Error("Expected LSP tool");
      return tool.execute(
        "status",
        { operation: "status" },
        undefined,
        undefined,
        harness.runner.createContext(),
      );
    };
    expect(await status()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("disabled") }],
    });
    await harness.runner.emit({ type: "session_start", reason: "reload" });
    expect(await status()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("disabled") }],
    });
    harness.sessionManager.branch(before);
    await harness.runner.emit({
      type: "session_tree",
      newLeafId: before,
      oldLeafId: disabledLeaf,
      fromExtension: false,
    });
    expect(await status()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("configured") }],
    });
    if (disabledLeaf === null) throw new Error("Expected disabled entry");
    harness.sessionManager.branch(disabledLeaf);
    await harness.runner.emit({
      type: "session_tree",
      newLeafId: disabledLeaf,
      oldLeafId: before,
      fromExtension: false,
    });
    expect(await status()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("disabled") }],
    });
    await command.handler("enable typescript", harness.runner.createCommandContext());
    expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
      data: { serverId: "typescript", enabled: true },
    });
    expect(await status()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("configured") }],
    });
    const forkFile = harness.sessionManager.createBranchedSession(disabledLeaf);
    if (forkFile === undefined) throw new Error("Expected saved fork");
    await harness.runner.emit({
      type: "session_start",
      reason: "fork",
      previousSessionFile: forkFile,
    });
    expect(await status()).toMatchObject({
      content: [{ text: expect.stringContaining("disabled") }],
    });
    harness.sessionManager.setSessionFile(forkFile);
    harness.sessionManager.appendCustomEntry("pi-lsp-enablement", {
      serverId: "typescript",
      enabled: "invalid",
    });
    await harness.runner.emit({
      type: "session_start",
      reason: "resume",
      previousSessionFile: forkFile,
    });
    expect(await status()).toMatchObject({
      content: [{ text: expect.stringContaining("disabled") }],
    });
    harness.sessionManager.newSession();
    await harness.runner.emit({
      type: "session_start",
      reason: "new",
      previousSessionFile: forkFile,
    });
    expect(await status()).toMatchObject({
      content: [{ text: expect.stringContaining("configured") }],
    });
    await shutdownExtension(harness);
  });
  test("writes only the selected settings scope and reports a masking session override", async () => {
    const harness = await createExtensionHarness(true, {
      lsp: {
        enablement: { typescript: false },
        servers: {
          typescript: {
            command: "missing-lsp-test-server",
            languages: [{ extensions: [".ts"], languageId: "typescript" }],
          },
        },
      },
    });
    await startExtension(harness);
    const command = harness.runner.getCommand("lsp");
    if (command === undefined) throw new Error("Expected /lsp command");
    await command.handler("enable typescript", harness.runner.createCommandContext());
    const sessionLeaf = harness.sessionManager.getLeafId();
    await command.handler("disable typescript --project", harness.runner.createCommandContext());
    expect(
      JSON.parse(
        await readFile(resolve(harness.sessionManager.getCwd(), ".pi/settings.json"), "utf8"),
      ),
    ).toEqual({
      lsp: { unknownField: true, enablement: { typescript: false } },
    });
    expect(harness.sessionManager.getLeafId()).toBe(sessionLeaf);
    expect(harness.notifications.at(-1)).toContain("masked by session");
    expect(harness.notifications.at(-1)).toContain("enabled");
    await command.handler("disable typescript --global", harness.runner.createCommandContext());
    expect(harness.notifications.at(-1)).toContain("masked by session");
    await shutdownExtension(harness);
  });

  test.each(["first root", String.raw`first\root with spaces`])(
    "stops only the selected root %s and accepts quoted paths without changing enablement",
    async (rootName) => {
      const fakeServerPath = fileURLToPath(
        new URL("fixtures/fake-lsp-server.mjs", import.meta.url),
      );
      const harness = await createExtensionHarness(false, {
        lsp: {
          servers: {
            fake: {
              command: process.execPath,
              args: [fakeServerPath],
              languages: [{ extensions: [".ts"], languageId: "typescript" }],
              rootMarkers: ["workspace.json"],
            },
          },
        },
      });
      const firstRoot = resolve(harness.sessionManager.getCwd(), rootName);
      const secondRoot = resolve(harness.sessionManager.getCwd(), "second");
      for (const root of [firstRoot, secondRoot]) {
        await mkdir(root, { recursive: true });
        await writeFile(resolve(root, "workspace.json"), "{}");
        await writeFile(resolve(root, "source.ts"), "const value = 1;");
      }
      await startExtension(harness);
      const command = harness.runner.getCommand("lsp");
      const tool = harness.runner.getToolDefinition("lsp");
      if (command === undefined || tool === undefined) throw new Error("Expected /lsp and lsp");
      for (const root of [firstRoot, secondRoot]) {
        await tool.execute(
          "start",
          { operation: "capabilities", server_id: "fake", file_path: resolve(root, "source.ts") },
          undefined,
          undefined,
          harness.runner.createContext(),
        );
      }
      expect(await command.getArgumentCompletions?.("sto")).toEqual([
        { value: "stop", label: "stop" },
      ]);
      expect(await command.getArgumentCompletions?.("disable f")).toContainEqual(
        expect.objectContaining({ value: "disable fake" }),
      );
      expect(await command.getArgumentCompletions?.("disable fake --g")).toEqual([
        { value: "disable fake --global", label: "--global" },
      ]);
      expect(
        await command.getArgumentCompletions?.(`stop fake "${firstRoot.slice(0, -2)}`),
      ).toEqual([{ value: `stop fake ${JSON.stringify(firstRoot)}`, label: firstRoot }]);
      expect(
        await command.getArgumentCompletions?.(
          `stop fake ${JSON.stringify(firstRoot).slice(0, -3)}`,
        ),
      ).toEqual([{ value: `stop fake ${JSON.stringify(firstRoot)}`, label: firstRoot }]);
      await command.handler(
        `stop fake ${JSON.stringify(firstRoot)}`,
        harness.runner.createCommandContext(),
      );
      const result = await tool.execute(
        "status",
        { operation: "status" },
        undefined,
        undefined,
        harness.runner.createContext(),
      );
      const text = result.content.find((item) => item.type === "text");
      if (text?.type !== "text") throw new Error("Expected status text");
      expect(JSON.parse(text.text)).toMatchObject({
        servers: [
          { rootPath: firstRoot, state: "stopped" },
          { rootPath: secondRoot, state: "running" },
        ],
      });
      expect(harness.sessionManager.getBranch()).toEqual([]);
      await tool.execute(
        "lazy-restart",
        {
          operation: "capabilities",
          server_id: "fake",
          file_path: resolve(firstRoot, "source.ts"),
        },
        undefined,
        undefined,
        harness.runner.createContext(),
      );
      await shutdownExtension(harness);
    },
  );

  test("offers server status, lifecycle actions, and toggle scope through native selectors", async () => {
    const harness = await createExtensionHarness(false, typescriptSettings);
    await startExtension(harness);
    const selections: string[][] = [];
    harness.runner.setUIContext(
      {
        ...harness.runner.getUIContext(),
        select: async (_title, options) => {
          selections.push(options);
          if (selections.length === 1) return options[0];
          if (selections.length === 2) return "disable";
          return "session";
        },
      },
      "rpc",
    );
    const command = harness.runner.getCommand("lsp");
    if (command === undefined) throw new Error("Expected /lsp command");
    await command.handler("", harness.runner.createCommandContext());
    expect(selections).toEqual([
      [expect.stringContaining("typescript — configured")],
      ["enable", "disable"],
      ["session", "project", "global"],
    ]);
    expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
      data: { serverId: "typescript", enabled: false },
    });
    await shutdownExtension(harness);
  });

  test("reports status and invalid commands without UI or session mutations", async () => {
    const harness = await createExtensionHarness(false, typescriptSettings);
    await startExtension(harness);
    harness.runner.setUIContext(undefined, "print");
    expect(harness.runner.createContext().hasUI).toBe(false);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const command = harness.runner.getCommand("lsp");
      if (command === undefined) throw new Error("Expected /lsp command");
      await command.handler("", harness.runner.createCommandContext());
      expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("typescript — configured"));
      for (const args of [
        "start typescript",
        "restart typescript",
        "inherit typescript",
        "stop typescript --global",
        "disable typescript --project --global",
        "disable typescript extra",
        "disable nonexistent",
        'disable "typescript',
        "disable typescript --unknown",
      ]) {
        await command.handler(args, harness.runner.createCommandContext());
      }
      expect(stderr).toHaveBeenCalledTimes(10);
      expect(harness.sessionManager.getBranch()).toEqual([]);
    } finally {
      stderr.mockRestore();
      await shutdownExtension(harness);
    }
  });

  test("discards a pending picker action after session history navigation", async () => {
    const harness = await createExtensionHarness(false, typescriptSettings);
    const before = harness.sessionManager.appendMessage(completedAssistantMessage());
    await startExtension(harness);
    const choice = Promise.withResolvers<string | undefined>();
    const opened = Promise.withResolvers<string>();
    let selections = 0;
    harness.runner.setUIContext(
      {
        ...harness.runner.getUIContext(),
        select: async (_title, options) => {
          selections += 1;
          if (selections > 1) return selections === 2 ? "disable" : "session";
          opened.resolve(options[0] ?? "");
          return choice.promise;
        },
      },
      "rpc",
    );
    const command = harness.runner.getCommand("lsp");
    if (command === undefined) throw new Error("Expected /lsp command");
    const pending = command.handler("", harness.runner.createCommandContext());
    const option = await opened.promise;
    harness.sessionManager.resetLeaf();
    await harness.runner.emit({
      type: "session_tree",
      newLeafId: null,
      oldLeafId: before,
      fromExtension: false,
    });
    choice.resolve(option);
    await pending;
    expect(selections).toBe(1);
    expect(harness.sessionManager.getBranch()).toEqual([]);
    await shutdownExtension(harness);
  });

  test("keeps the rendered lsp tool available while reload reconstructs the transcript", async () => {
    const harness = await createExtensionHarness(false);
    const model = getModel("anthropic", "claude-sonnet-4-5");
    if (model === undefined) throw new Error("Pi LSP extension test: missing pinned model");
    const session = (
      await createAgentSession({
        cwd: harness.sessionManager.getCwd(),
        agentDir: harness.agentDirectory,
        model,
        resourceLoader: harness.resourceLoader,
        sessionManager: harness.sessionManager,
        settingsManager: harness.settingsManager,
      })
    ).session;
    agentSessions.push(session);
    await session.bindExtensions({
      mode: "rpc",
      uiContext: session.extensionRunner.getUIContext(),
    });

    let definitionAvailableBeforeSessionStart = false;
    let renderCallAvailableBeforeSessionStart = false;
    let renderResultAvailableBeforeSessionStart = false;
    await session.reload({
      beforeSessionStart: () => {
        const definition = session.getToolDefinition("lsp");
        definitionAvailableBeforeSessionStart = definition !== undefined;
        renderCallAvailableBeforeSessionStart = definition?.renderCall !== undefined;
        renderResultAvailableBeforeSessionStart = definition?.renderResult !== undefined;
      },
    });

    expect({
      definition: definitionAvailableBeforeSessionStart,
      renderCall: renderCallAvailableBeforeSessionStart,
      renderResult: renderResultAvailableBeforeSessionStart,
    }).toEqual({ definition: true, renderCall: true, renderResult: true });
  });

  test("starts runtime lazily, replays only the active branch, augments writes, and shuts down idempotently", async () => {
    const harness = await createExtensionHarness(false);
    const filePath = resolve(harness.sessionManager.getCwd(), "source.ts");
    await writeFile(filePath, "before\n");
    const baseEntryId = harness.sessionManager.appendMessage({
      role: "user",
      content: "prepare edits",
      timestamp: Date.now(),
    });
    const previews = new LspWorkspaceEditStore({
      createPreviewId: (() => {
        const ids = ["off-branch-preview", "active-preview", "applied-preview"];
        return () => ids.shift() ?? "unexpected-preview";
      })(),
    });
    const workspaceEdit = {
      changes: {
        [pathToFileURL(filePath).href]: [
          {
            newText: "after",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 6 },
            },
          },
        ],
      },
    };
    const offBranchPreview = await previews.createPreview({
      edit: workspaceEdit,
      serverId: "typescript",
    });
    harness.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "off-branch-call",
      toolName: "lsp",
      content: [{ type: "text", text: "off branch" }],
      details: {
        kind: "workspace_edit_preview",
        preview_id: offBranchPreview.preview_id,
        operation: "format_document",
        summary: offBranchPreview.summary,
        mutation_manifest: [{ operation: "modify", path: filePath }],
        preview_record: offBranchPreview,
        state: "available",
      },
      isError: false,
      timestamp: Date.now(),
    });
    harness.sessionManager.branch(baseEntryId);
    const activePreview = await previews.createPreview({
      edit: workspaceEdit,
      serverId: "typescript",
    });
    harness.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "active-call",
      toolName: "lsp",
      content: [{ type: "text", text: "active branch" }],
      details: {
        kind: "workspace_edit_preview",
        preview_id: activePreview.preview_id,
        operation: "format_document",
        summary: activePreview.summary,
        mutation_manifest: [{ operation: "modify", path: filePath }],
        preview_record: activePreview,
        state: "available",
      },
      isError: false,
      timestamp: Date.now(),
    });
    const appliedPreview = await previews.createPreview({
      edit: workspaceEdit,
      serverId: "typescript",
    });
    harness.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "applied-preview-call",
      toolName: "lsp",
      content: [{ type: "text", text: "preview later applied" }],
      details: {
        kind: "workspace_edit_preview",
        preview_id: appliedPreview.preview_id,
        operation: "format_document",
        summary: appliedPreview.summary,
        mutation_manifest: [{ operation: "modify", path: filePath }],
        preview_record: appliedPreview,
        state: "available",
      },
      isError: false,
      timestamp: Date.now(),
    });
    harness.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "apply-call",
      toolName: "lsp",
      content: [{ type: "text", text: "applied" }],
      details: {
        kind: "workspace_edit_apply",
        preview_id: appliedPreview.preview_id,
        mutation_manifest: [{ operation: "modify", path: filePath }],
        changed_paths: [filePath],
        state: "applied",
      },
      isError: false,
      timestamp: Date.now(),
    });

    expect(harness.runner.getAllRegisteredTools().map(({ definition }) => definition.name)).toEqual(
      ["lsp"],
    );
    expect(await piLspSessionDirectories(harness.sessionDirectory)).toEqual([]);
    await startExtension(harness);

    expect(harness.notifications).toEqual([]);
    expect(harness.runner.hasHandlers("tool_result")).toBe(true);
    expect(harness.runner.getAllRegisteredTools().map(({ definition }) => definition.name)).toEqual(
      ["lsp"],
    );
    const prepareArguments = harness.runner.getToolDefinition("lsp")?.prepareArguments;
    if (prepareArguments === undefined) throw new Error("Expected LSP argument preparation");
    expect(
      prepareArguments({ operation: "apply", preview_id: activePreview.preview_id }),
    ).toMatchObject({
      operation: "apply",
      preview_id: activePreview.preview_id,
      mutation_manifest: [{ operation: "modify", path: filePath }],
    });
    expect(() =>
      prepareArguments({ operation: "apply", preview_id: offBranchPreview.preview_id }),
    ).toThrow("Workspace Edit Preview not found");
    expect(() =>
      prepareArguments({ operation: "apply", preview_id: appliedPreview.preview_id }),
    ).toThrow("already applied");

    const originalDetails = { bytesWritten: 7 };
    const augmented = await harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId: "write-call",
      toolName: "write",
      input: { path: filePath, content: "after\n" },
      content: [{ type: "text", text: "Wrote source.ts" }],
      details: originalDetails,
      isError: false,
    } satisfies ToolResultEvent);
    expect(augmented?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("no configured server"),
    });
    expect(augmented?.details).toBe(originalDetails);
    expect(augmented?.isError).toBe(false);

    const partialApply = await harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId: "partial-apply-call",
      toolName: "lsp",
      input: {
        operation: "apply",
        preview_id: "partial-preview",
        mutation_manifest: [{ operation: "modify", path: filePath }],
      },
      content: [{ type: "text", text: "Rollback failed" }],
      details: {
        kind: "workspace_edit_apply",
        preview_id: "partial-preview",
        mutation_manifest: [{ operation: "modify", path: filePath }],
        changed_paths: [filePath],
        state: "partial_failure",
      },
      isError: false,
    } satisfies ToolResultEvent);
    expect(partialApply?.isError).toBe(true);
    expect(partialApply?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("no configured server"),
    });

    const changedFiles = Array.from(
      { length: 100 },
      (_, index) => `${index}-${"long-diagnostic-path-".repeat(30)}.ts`,
    );
    const spilled = await harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId: "apply-patch-call",
      toolName: "apply_patch",
      input: {},
      content: [{ type: "text", text: "Applied patch" }],
      details: {
        status: "success",
        result: {
          changedFiles,
          createdFiles: [],
          deletedFiles: [],
          movedFiles: [],
          fuzz: 0,
        },
      },
      isError: false,
    } satisfies ToolResultEvent);
    expect(spilled?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("complete Result Spill"),
    });
    const [lspSessionDirectory] = await piLspSessionDirectories(harness.sessionDirectory);
    if (lspSessionDirectory === undefined) throw new Error("Expected Pi LSP session directory");
    const spillFiles = (
      await readdir(resolve(harness.sessionDirectory, lspSessionDirectory))
    ).filter((entry) => entry.startsWith("result-spill-"));
    expect(spillFiles).toHaveLength(1);

    expect(await piLspSessionDirectories(harness.sessionDirectory)).toHaveLength(1);
    await Promise.all([shutdownExtension(harness), shutdownExtension(harness)]);
    expect(await piLspSessionDirectories(harness.sessionDirectory)).toEqual([]);
  });

  test("appends one model-invisible diagnostics entry after a tool batch with findings", async () => {
    const fakeServerPath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));
    const harness = await createExtensionHarness(false, {
      lsp: {
        timeouts: { diagnosticsMs: 1_000, initializeMs: 5_000, shutdownMs: 1_000 },
        servers: {
          fake: {
            command: process.execPath,
            args: [fakeServerPath],
            environment: { FAKE_DIAGNOSTICS: "one" },
            languages: [{ extensions: [".ts"], languageId: "typescript" }],
          },
          formattingOnly: {
            command: process.execPath,
            args: [fakeServerPath],
            environment: { FAKE_NO_PULL: "1", FAKE_PUSH: "none" },
            languages: [{ extensions: [".ts"], languageId: "typescript" }],
          },
        },
      },
    });
    await startExtension(harness);
    const filePath = resolve(harness.sessionManager.getCwd(), "source.ts");
    await writeFile(filePath, "const value: string = 1;\n");

    const originalDetails = { bytesWritten: 25 };
    const augmented = await harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId: "write-with-diagnostic",
      toolName: "write",
      input: { path: filePath, content: "const value: string = 1;\n" },
      content: [{ type: "text", text: "Wrote source.ts" }],
      details: originalDetails,
      isError: false,
    } satisfies ToolResultEvent);
    expect(augmented?.details).toBe(originalDetails);
    expect(augmented?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("fake diagnostic"),
    });
    expect(augmented?.content?.at(-1)).toMatchObject({
      text: expect.not.stringContaining("formattingOnly"),
    });
    expect(
      harness.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === POST_EDIT_DIAGNOSTICS_ENTRY_TYPE,
        ),
    ).toEqual([]);

    await harness.runner.emit({
      type: "turn_end",
      turnIndex: 0,
      message: completedAssistantMessage(),
      toolResults: [],
    } satisfies TurnEndEvent);

    const entries = harness.sessionManager
      .getBranch()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === POST_EDIT_DIAGNOSTICS_ENTRY_TYPE,
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      data: {
        cwd: harness.sessionManager.getCwd(),
        outcomes: [
          {
            kind: "diagnostic",
            diagnostic: { serverId: "fake", path: filePath, message: "fake diagnostic" },
          },
        ],
      },
    });
    expect(harness.runner.getEntryRenderer(POST_EDIT_DIAGNOSTICS_ENTRY_TYPE)).toBeTypeOf(
      "function",
    );
    await shutdownExtension(harness);
  });

  test("silently skips post-edit diagnostics until a required root marker exists", async () => {
    const fakeServerPath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));
    const harness = await createExtensionHarness(false, {
      lsp: {
        timeouts: { diagnosticsMs: 1_000, initializeMs: 5_000, shutdownMs: 1_000 },
        servers: {
          gated: {
            command: process.execPath,
            args: [fakeServerPath],
            environment: { FAKE_DIAGNOSTICS: "one" },
            languages: [{ extensions: [".ts"], languageId: "typescript" }],
            requireRootMarker: true,
            rootMarkers: ["tsconfig.json"],
          },
        },
      },
    });
    await startExtension(harness);
    const cwd = harness.sessionManager.getCwd();
    const filePath = resolve(cwd, "source.ts");
    await writeFile(filePath, "const value: string = 1;\n");
    const event = {
      type: "tool_result",
      toolCallId: "gated-write",
      toolName: "write",
      input: { path: filePath, content: "const value: string = 1;\n" },
      content: [{ type: "text", text: "Wrote source.ts" }],
      details: { bytesWritten: 25 },
      isError: false,
    } satisfies ToolResultEvent;

    await expect(harness.runner.emitToolResult(event)).resolves.toBeUndefined();

    await writeFile(resolve(cwd, "tsconfig.json"), "{}");
    const augmented = await harness.runner.emitToolResult(event);
    expect(augmented?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("fake diagnostic"),
    });
    await shutdownExtension(harness);
  });
});
