import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  readlink,
  lstat,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ToolInstaller } from "@ian-pascoe/pi-tool-installer";
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
import { LSP_PRESETS } from "../src/lsp-presets.js";
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

const foreignOwnedPaths = vi.hoisted(() => new Set<string>());
// Exercise foreign filesystem ownership without requiring privileged chown in offline tests.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const result = await original.lstat(...args);
      if (foreignOwnedPaths.has(String(args[0]))) {
        result.uid++;
      }
      return result;
    },
  };
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
  noSession = false,
  presets = false,
): Promise<ExtensionHarness> {
  const cwd = await makeTemporaryDirectory("pi-lsp-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-lsp-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-lsp-extension-sessions-");
  const wire = JSON.parse(JSON.stringify(globalSettings));
  if (!presets) {
    wire.lsp ??= {};
    wire.lsp.servers = {
      ...Object.fromEntries(LSP_PRESETS.map(({ id }) => [id, null])),
      ...wire.lsp.servers,
    };
  }
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(wire));
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(
    resolve(cwd, ".pi/settings.json"),
    JSON.stringify({ lsp: { unknownField: true } }),
  );

  if (noSession) {
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, sessionDirectory);
  }
  const sessionManager = noSession
    ? SessionManager.inMemory(cwd)
    : SessionManager.create(cwd, sessionDirectory);
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

async function externalBiome(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await symlink(process.execPath, resolve(directory, "node"));
  const server = resolve(directory, "biome");
  await writeFile(
    server,
    `#!${process.execPath}\nimport(${JSON.stringify(new URL("fixtures/fake-biome-server.mjs", import.meta.url).href)});\n`,
  );
  await chmod(server, 0o755);
}

async function managedHarness(settings: LspSettingsDocumentInput = {}) {
  const harness = await createExtensionHarness(false, settings, true);
  const store = resolve(harness.agentDirectory, "managed-tools");
  await mkdir(store);
  await writeFile(resolve(store, process.platform === "win32" ? "mise.exe" : "mise"), "fixture");
  const control = async (options: {
    wait?: boolean;
    fail?: boolean;
    failTool?: string;
    version?: string;
  }) =>
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
  foreignOwnedPaths.clear();
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
      .map((directory) =>
        rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }),
      ),
  );
});

describe("Pi LSP extension lifecycle", () => {
  test.skipIf(process.platform === "win32").each(["managed", "external"])(
    "macOS %s Biome keeps a safe short alias to its persistent per-store socket home",
    async (installation) => {
      const { harness, store } = await managedHarness({
        lsp: { autoInstall: installation === "managed", servers: { typescript: null } },
      });
      const cwd = harness.sessionManager.getCwd();
      const ordinaryCache = resolve(store, "lsp/biome/cache/keep");
      await mkdir(resolve(ordinaryCache, ".."), { recursive: true });
      await writeFile(ordinaryCache, "preserve ordinary cache");
      for (const name of ["one", "two"]) {
        const root = resolve(cwd, name);
        await mkdir(root);
        await writeFile(resolve(root, "biome.json"), "{}");
        await writeFile(resolve(root, "main.js"), "debugger;\n");
      }
      if (installation === "external") await externalBiome(resolve(cwd, "node_modules/.bin"));
      vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
      const originalTmpdir = process.env.TMPDIR;
      const launch = async (root: string): Promise<{ home: string; tmpdir?: string }> =>
        JSON.parse(await readFile(resolve(cwd, root, "biome-launch.json"), "utf8"));
      const diagnose = (root: string) =>
        harness.runner
          .getToolDefinition("lsp")!
          .execute(
            "biome-socket",
            { operation: "diagnostics", server_id: "biome", file_path: `${root}/main.js` },
            undefined,
            undefined,
            harness.runner.createContext(),
          );
      await startExtension(harness);
      try {
        expect(await diagnose("one")).toMatchObject({
          content: [{ text: expect.stringContaining("debugger;") }],
        });
        const { home } = await launch("one");
        expect((await launch("one")).tmpdir).toBe(originalTmpdir);
        // Biome's native macOS cache layout, not XDG_CACHE_HOME or TMPDIR.
        expect(
          Buffer.byteLength(`${home}/Library/Caches/dev.biomejs.biome/biome-socket-2.5.13`),
        ).toBeLessThan(104);
        temporaryDirectories.push(dirname(home));
        expect((await lstat(dirname(home))).mode & 0o777).toBe(0o700);
        expect((await lstat(home)).isSymbolicLink()).toBe(true);
        expect(await readlink(home)).toBe(await realpath(resolve(store, "lsp/biome")));
        expect(await diagnose("two")).toMatchObject({
          content: [{ text: expect.stringContaining("debugger;") }],
        });
        expect((await launch("two")).home).toBe(home);
        const command = harness.runner
          .getRegisteredCommands()
          .find((value) => value.name === "lsp")!;
        await command.handler(
          `stop biome ${JSON.stringify(resolve(cwd, "one"))}`,
          harness.runner.createCommandContext(),
        );
        expect(existsSync(home)).toBe(true);
        await writeFile(resolve(cwd, "two/main.js"), "changed diagnostic\n");
        expect(await diagnose("two")).toMatchObject({
          content: [{ text: expect.stringContaining("changed diagnostic") }],
        });
        await shutdownExtension(harness);
        for (const root of ["one", "two"]) {
          expect(JSON.parse(await readFile(resolve(cwd, root, "biome-exit.json"), "utf8"))).toEqual(
            { homeExists: true },
          );
        }
        expect(await realpath(home)).toBe(await realpath(resolve(store, "lsp/biome")));
        expect(await readFile(ordinaryCache, "utf8")).toBe("preserve ordinary cache");
        await startExtension(harness);
        expect(await diagnose("one")).toMatchObject({
          content: [{ text: expect.stringContaining("debugger;") }],
        });
        expect((await launch("one")).home).toBe(home);
        expect(process.env.TMPDIR).toBe(originalTmpdir);
        await shutdownExtension(harness);
        const other = await createExtensionHarness(
          false,
          { lsp: { autoInstall: false, servers: { typescript: null } } },
          true,
        );
        const otherRoot = other.sessionManager.getCwd();
        await externalBiome(resolve(otherRoot, "node_modules/.bin"));
        await writeFile(resolve(otherRoot, "biome.json"), "{}");
        await writeFile(resolve(otherRoot, "main.js"), "other store diagnostic\n");
        await startExtension(other);
        const otherDiagnostics = () =>
          other.runner
            .getToolDefinition("lsp")!
            .execute(
              "other-biome",
              { operation: "diagnostics", server_id: "biome", file_path: "main.js" },
              undefined,
              undefined,
              other.runner.createContext(),
            );
        expect(await otherDiagnostics()).toMatchObject({
          content: [{ text: expect.stringContaining("other store diagnostic") }],
        });
        const otherHome = JSON.parse(
          await readFile(resolve(otherRoot, "biome-launch.json"), "utf8"),
        ).home;
        expect(otherHome).not.toBe(home);
        temporaryDirectories.push(dirname(otherHome));
        expect(await realpath(otherHome)).toBe(
          await realpath(resolve(other.agentDirectory, "managed-tools/lsp/biome")),
        );
        // A stale or tampered predictable alias must not redirect native cache writes.
        await rm(home);
        await symlink(cwd, home);
        await startExtension(harness);
        await expect(diagnose("one")).rejects.toThrow(/unsafe.*Biome.*alias/i);
        expect(await readlink(home)).toBe(cwd);
        expect(await readFile(ordinaryCache, "utf8")).toBe("preserve ordinary cache");
        await shutdownExtension(harness);
        await rm(home);
        await writeFile(home, "do not replace an existing file");
        await startExtension(harness);
        await expect(diagnose("one")).rejects.toThrow(/unsafe.*Biome.*alias/i);
        expect(await readFile(home, "utf8")).toBe("do not replace an existing file");
        await shutdownExtension(harness);
        await rm(home);
        await symlink(await realpath(resolve(store, "lsp/biome")), home);
        await chmod(dirname(home), 0o755);
        await startExtension(harness);
        await expect(diagnose("one")).rejects.toThrow(/unsafe.*Biome.*alias/i);
        expect((await lstat(dirname(home))).mode & 0o777).toBe(0o755);
        await shutdownExtension(harness);
        await chmod(dirname(home), 0o700);
        for (const entry of [dirname(home), home]) {
          foreignOwnedPaths.add(entry);
          await startExtension(harness);
          await expect(diagnose("one")).rejects.toThrow(/unsafe.*Biome.*alias/i);
          await shutdownExtension(harness);
          foreignOwnedPaths.delete(entry);
        }
        const savedParent = `${dirname(home)}-saved`;
        temporaryDirectories.push(savedParent);
        await rename(dirname(home), savedParent);
        await symlink(savedParent, dirname(home));
        await startExtension(harness);
        await expect(diagnose("one")).rejects.toThrow(/unsafe.*Biome.*alias/i);
        expect(await readlink(dirname(home))).toBe(savedParent);
        await shutdownExtension(harness);
        await rm(dirname(home));
        await writeFile(dirname(home), "do not replace an existing parent file");
        await startExtension(harness);
        await expect(diagnose("one")).rejects.toThrow(/unsafe.*Biome.*alias/i);
        expect(await readFile(dirname(home), "utf8")).toBe(
          "do not replace an existing parent file",
        );
        expect(await otherDiagnostics()).toMatchObject({
          content: [{ text: expect.stringContaining("other store diagnostic") }],
        });
        await shutdownExtension(other);
      } finally {
        await shutdownExtension(harness);
      }
    },
    20_000,
  );
  test.skipIf(process.platform === "win32").each(["explicit", "linux-preset"])(
    "%s Biome preserves its existing HOME policy without a macOS alias",
    async (kind) => {
      const home = await makeTemporaryDirectory("pi-biome-explicit-home-");
      const harness = await createExtensionHarness(
        false,
        {
          lsp: {
            autoInstall: false,
            servers:
              kind === "explicit"
                ? {
                    typescript: null,
                    biome: {
                      command: process.execPath,
                      args: [
                        fileURLToPath(new URL("fixtures/fake-biome-server.mjs", import.meta.url)),
                      ],
                      environment: { HOME: home },
                      languages: [{ extensions: [".js"], languageId: "javascript" }],
                    },
                  }
                : { typescript: null },
          },
        },
        true,
      );
      const cwd = harness.sessionManager.getCwd();
      await externalBiome(resolve(cwd, "node_modules/.bin"));
      await writeFile(resolve(cwd, "biome.json"), "{}");
      await writeFile(resolve(cwd, "main.js"), "debugger;\n");
      vi.stubGlobal(
        "process",
        Object.create(process, { platform: { value: kind === "explicit" ? "darwin" : "linux" } }),
      );
      await startExtension(harness);
      expect(
        await harness.runner
          .getToolDefinition("lsp")!
          .execute(
            "unchanged-biome",
            { operation: "document_symbols", server_id: "biome", file_path: "main.js" },
            undefined,
            undefined,
            harness.runner.createContext(),
          ),
      ).toMatchObject({ content: [{ text: expect.stringContaining("answer") }] });
      const launched = JSON.parse(await readFile(resolve(cwd, "biome-launch.json"), "utf8"));
      expect(launched.home).toBe(
        kind === "explicit" ? home : resolve(harness.agentDirectory, "managed-tools/lsp/biome"),
      );
      expect((await lstat(launched.home)).isDirectory()).toBe(true);
      await shutdownExtension(harness);
    },
  );
  test.each([
    ["css", "vscode-css-language-server", "style.css"],
    ["json", "vscode-json-language-server", "data.json"],
    ["yaml", "yaml-language-server", "data.yaml"],
    ["dockerfile", "docker-langserver", "Dockerfile"],
  ])(
    "%s builtin appends fresh diagnostics to mutation results using its supported transport",
    async (id, executable, file) => {
      const harness = await createExtensionHarness(false, { lsp: { autoInstall: false } }, true);
      const root = harness.sessionManager.getCwd();
      const bin = resolve(root, "node_modules/.bin");
      await mkdir(bin, { recursive: true });
      await copyFile(
        process.execPath,
        resolve(bin, process.platform === "win32" ? "node.exe" : "node"),
      );
      const script = resolve(bin, "server.cjs");
      await writeFile(
        script,
        `import(${JSON.stringify(new URL("fixtures/fake-lsp-server.mjs", import.meta.url).href)});\n`,
      );
      const command = resolve(bin, `${executable}${process.platform === "win32" ? ".cmd" : ""}`);
      await writeFile(
        command,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "%~dp0server.cjs" %*\r\n`
          : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
      );
      await chmod(command, 0o755);
      vi.stubEnv("PATH", "");
      vi.stubEnv("FAKE_NO_PULL", id === "yaml" || id === "dockerfile" ? "1" : "0");
      vi.stubEnv("FAKE_DIAGNOSTICS", "document");
      await startExtension(harness);
      for (const text of ["first invalid document", "changed invalid document"]) {
        await writeFile(resolve(root, file!), text);
        const result = await harness.runner.emitToolResult({
          type: "tool_result",
          toolCallId: "push",
          toolName: "write",
          input: { path: file, content: text },
          content: [{ type: "text", text: "Written" }],
          details: {},
          isError: false,
        });
        expect(result).toMatchObject({ isError: false });
        expect(JSON.stringify(result)).toContain(text);
      }
    },
  );
  test("cancelling Oxlint configuration inspection stops wrapper descendants without losing the mutation", async () => {
    const harness = await createExtensionHarness(
      false,
      { lsp: { servers: { typescript: null } } },
      true,
    );
    const root = harness.sessionManager.getCwd();
    const bin = resolve(root, "node_modules/.bin");
    await mkdir(bin, { recursive: true });
    await copyFile(
      process.execPath,
      resolve(bin, process.platform === "win32" ? "node.exe" : "node"),
    );
    const pidPath = resolve(root, "inspection-child.pid");
    const script = resolve(bin, "inspect.cjs");
    await writeFile(
      script,
      `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); setInterval(() => {}, 1000);\n`,
    );
    const executable = resolve(bin, process.platform === "win32" ? "oxlint.cmd" : "oxlint");
    await writeFile(
      executable,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "%~dp0inspect.cjs" %*\r\n`
        : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
    );
    await chmod(executable, 0o755);
    await writeFile(resolve(root, ".oxlintrc.json"), "{}");
    await writeFile(resolve(root, "source.js"), "debugger;\n");
    await startExtension(harness);
    const abort = new AbortController();
    harness.setSignal(abort.signal);
    const pending = harness.runner.emitToolResult({
      type: "tool_result",
      toolCallId: "inspection",
      toolName: "write",
      input: { path: "source.js", content: "debugger;\n" },
      content: [{ type: "text", text: "Wrote source.js" }],
      details: {},
      isError: false,
    });
    let pid: number | undefined;
    try {
      await expect
        .poll(async () => {
          try {
            return Number(await readFile(pidPath, "utf8"));
          } catch {
            return undefined;
          }
        })
        .toBeGreaterThan(0);
      pid = Number(await readFile(pidPath, "utf8"));
      abort.abort(new Error("Cancelled inspection"));
      expect(await pending).toMatchObject({
        isError: false,
        content: expect.arrayContaining([{ type: "text", text: "Wrote source.js" }]),
      });
      await expect
        .poll(() => {
          try {
            process.kill(pid!, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      abort.abort();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await pending;
    }
  });

  test("external Oxlint roots retain distinct compatible helpers across Installed-only reopen and atomic updates from another root", async () => {
    const { harness, store, control } = await managedHarness({
      lsp: { servers: { typescript: null } },
    });
    const installer = new ToolInstaller(store);
    for (const [name, version, peer] of [
      ["a", "1.82.0", "^7.0.0"],
      ["b", "1.83.0", "^8.0.0"],
    ]) {
      const root = resolve(harness.sessionManager.getCwd(), name!);
      const bin = resolve(root, "node_modules/.bin");
      const pkg = resolve(root, "node_modules/oxlint");
      await mkdir(bin, { recursive: true });
      await mkdir(pkg);
      await copyFile(
        process.execPath,
        resolve(bin, process.platform === "win32" ? "node.exe" : "node"),
      );
      await writeFile(
        resolve(root, "package.json"),
        JSON.stringify({ dependencies: { oxlint: version } }),
      );
      await writeFile(resolve(root, "source.js"), "debugger;\n");
      await writeFile(
        resolve(pkg, "package.json"),
        JSON.stringify({ name: "oxlint", version, peerDependencies: { "oxlint-tsgolint": peer } }),
      );
      const script = resolve(pkg, "server.cjs");
      await writeFile(
        script,
        `if (process.argv.includes("--version")) console.log(${JSON.stringify(version)}); else if (process.argv.includes("--print-config")) console.log('{"options":{"typeAware":true}}'); else { process.env.FAKE_SYMBOL_NAME = process.env.OXLINT_TSGOLINT_PATH; import(${JSON.stringify(new URL("fixtures/fake-lsp-server.mjs", import.meta.url).href)}); }\n`,
      );
      const command = resolve(bin, process.platform === "win32" ? "oxlint.cmd" : "oxlint");
      await writeFile(
        command,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "%~dp0..\\oxlint\\server.cjs" %*\r\n`
          : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
      );
      await chmod(command, 0o755);
    }
    vi.stubGlobal("fetch", async (input: string) => {
      const name = decodeURIComponent(new URL(input).pathname.slice(1));
      if (name !== "oxlint-tsgolint") throw new Error(`Unexpected registry request: ${input}`);
      return Response.json({
        "dist-tags": { latest: "8.0.2" },
        versions: Object.fromEntries(
          ["7.0.2001", "8.0.2"].map((version) => [version, { name, version }]),
        ),
      });
    });
    const symbols = (root: string) =>
      harness.runner
        .getToolDefinition("lsp")!
        .execute(
          "helper",
          { operation: "document_symbols", server_id: "oxlint", file_path: `${root}/source.js` },
          undefined,
          undefined,
          harness.runner.createContext(),
        );
    await startExtension(harness);
    expect(JSON.stringify(await symbols("a"))).toContain("7.0.2001");
    expect(JSON.stringify(await symbols("b"))).toContain("8.0.2");
    await shutdownExtension(harness);
    await writeFile(
      resolve(harness.agentDirectory, "settings.json"),
      JSON.stringify({ lsp: { autoInstall: false, servers: { typescript: null } } }),
    );
    vi.stubGlobal("fetch", () => Promise.reject(new Error("Installed-only must not fetch")));
    await startExtension(harness);
    expect(JSON.stringify(await symbols("a"))).toContain("7.0.2001");
    expect(JSON.stringify(await symbols("b"))).toContain("8.0.2");
    expect(
      (await installer.list()).flatMap(
        (installation) => installation.components.helper?.version ?? [],
      ),
    ).toEqual(expect.arrayContaining(["7.0.2001", "8.0.2"]));
    let next = ["7.0.2002", "8.0.3", "9.0.0"];
    vi.stubGlobal("fetch", async (input: string) => {
      const name = decodeURIComponent(new URL(input).pathname.slice(1));
      if (name !== "oxlint-tsgolint") throw new Error(`Unexpected registry request: ${input}`);
      return Response.json({
        "dist-tags": { latest: "9.0.0" },
        versions: Object.fromEntries(next.map((version) => [version, { name, version }])),
      });
    });
    const foreign = await installer.ensure(
      { id: "formatter-unrelated", requirements: { node: "core:node@22.0.0" } },
      { allowDownload: true },
    );
    const command = harness.runner.getRegisteredCommands().find((value) => value.name === "lsp")!;
    await command.handler("update", harness.runner.createCommandContext());
    const updated = await installer.list();
    expect(
      updated.flatMap((installation) => installation.components.helper?.version ?? []),
    ).toEqual(expect.arrayContaining(["7.0.2002", "8.0.3"]));
    expect(await installer.installed(foreign.id)).toEqual(foreign);
    // Already running Instances retain the original helpers.
    expect(JSON.stringify(await symbols("a"))).toContain("7.0.2001");
    expect(JSON.stringify(await symbols("b"))).toContain("8.0.2");
    next = ["7.0.2003", "8.0.4", "9.0.0"];
    await control({ fail: true });
    await command.handler("update oxlint", harness.runner.createCommandContext());
    expect(await installer.list()).toEqual(updated);
    expect(
      harness.notifications
        .slice(-2)
        .every((message) => message.includes("previous installation retained")),
    ).toBe(true);
  }, 15_000);

  test("managed Oxlint first use and updates retain a compatible server/helper pair across reopen and helper acquisition failure", async () => {
    const { harness, store, control } = await managedHarness({
      lsp: { servers: { typescript: null } },
    });
    const installer = new ToolInstaller(store);
    const root = harness.sessionManager.getCwd();
    await writeFile(resolve(root, "package.json"), '{"devDependencies":{"oxlint":"1.82.0"}}');
    await writeFile(resolve(root, ".oxlintrc.json"), '{"options":{"typeAware":true}}');
    await writeFile(resolve(root, "source.js"), "debugger;\n");
    await control({ version: "1.82.0" });
    const symbols = () =>
      harness.runner
        .getToolDefinition("lsp")!
        .execute(
          "managed-oxlint",
          { operation: "document_symbols", server_id: "oxlint", file_path: "source.js" },
          undefined,
          undefined,
          harness.runner.createContext(),
        );
    let serverVersion = "1.83.0";
    let helperVersion = "8.0.2";
    vi.stubGlobal("fetch", async (input: string) => {
      const name = decodeURIComponent(new URL(input).pathname.slice(1));
      if (name === "oxlint")
        return Response.json({
          "dist-tags": { latest: serverVersion },
          versions: {
            [serverVersion]: {
              name,
              version: serverVersion,
              peerDependencies: { "oxlint-tsgolint": "^8.0.0" },
            },
          },
        });
      if (name === "oxlint-tsgolint")
        return Response.json({
          "dist-tags": { latest: "9.0.0" },
          versions: Object.fromEntries(
            ["7.0.2001", helperVersion, "9.0.0"].map((version) => [version, { name, version }]),
          ),
        });
      throw new Error(`Unexpected registry request: ${input}`);
    });
    await startExtension(harness);
    expect(JSON.stringify(await symbols())).toContain("7.0.2001");
    const command = harness.runner.getRegisteredCommands().find((value) => value.name === "lsp")!;
    await control({ version: serverVersion });
    await command.handler("update oxlint", harness.runner.createCommandContext());
    const selected = await installer.installed("lsp-oxlint");
    expect(selected?.components.server?.version).toBe("1.83.0");
    expect(selected?.components.helper?.version).toBe("8.0.2");
    expect((await installer.list()).map((installation) => installation.id)).toEqual(["lsp-oxlint"]);
    // Updating does not replace the server/helper pair of a running Instance.
    expect(JSON.stringify(await symbols())).toContain("7.0.2001");
    await shutdownExtension(harness);
    await writeFile(
      resolve(harness.agentDirectory, "settings.json"),
      JSON.stringify({ lsp: { autoInstall: false, servers: { typescript: null } } }),
    );
    const registry = fetch;
    vi.stubGlobal("fetch", () => Promise.reject(new Error("Installed-only must not fetch")));
    await startExtension(harness);
    const updated = JSON.stringify(await symbols());
    expect(updated).toContain("oxlint@1.83.0");
    expect(updated).toContain("8.0.2");
    vi.stubGlobal("fetch", registry);
    serverVersion = "1.84.0";
    helperVersion = "8.0.3";
    await control({ version: serverVersion, failTool: "npm:oxlint-tsgolint@" });
    await command.handler("update oxlint", harness.runner.createCommandContext());
    expect(await installer.installed("lsp-oxlint")).toEqual(selected);
    expect(harness.notifications.at(-1)).toContain("Fixture acquisition failed");
    expect(harness.notifications.at(-1)).toContain("previous installation retained");
    await shutdownExtension(harness);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("Installed-only must not fetch")));
    await startExtension(harness);
    expect(JSON.stringify(await symbols())).toBe(updated);
    expect(await readdir(root)).not.toContain("node_modules");
  }, 15_000);

  test("framework update command advances both external compatibility variants from another root and retains failed selections", async () => {
    const { harness, store, control } = await managedHarness();
    const installer = new ToolInstaller(store);
    vi.stubEnv(
      "PI_FRAMEWORK_PROTOCOL",
      createRequire(import.meta.url).resolve("vscode-languageserver-protocol/node"),
    );
    for (const [name, peer] of [
      ["a", "^5.9.2"],
      ["b", "^6.0.2"],
    ] as const) {
      const root = resolve(harness.sessionManager.getCwd(), name);
      const bin = resolve(root, "node_modules/.bin");
      const pkg = resolve(root, "node_modules/@astrojs/language-server");
      await mkdir(bin, { recursive: true });
      await mkdir(resolve(pkg, "bin"), { recursive: true });
      await copyFile(
        process.execPath,
        resolve(bin, process.platform === "win32" ? "node.exe" : "node"),
      );
      await copyFile(
        fileURLToPath(new URL("fixtures/framework-sdk-server.cjs", import.meta.url)),
        resolve(pkg, "bin/nodeServer.js"),
      );
      await writeFile(
        resolve(pkg, "package.json"),
        JSON.stringify({
          name: "@astrojs/language-server",
          version: "2.16.16",
          peerDependencies: { typescript: peer },
        }),
      );
      await writeFile(resolve(root, "package.json"), "{}");
      await writeFile(resolve(root, "source.astro"), "---\nconst answer = 42;\n---\n{answer}\n");
    }
    let versions = ["5.9.3", "6.0.3", "7.0.2"];
    vi.stubGlobal("fetch", async (input: string) => {
      const name = decodeURIComponent(new URL(input).pathname.slice(1));
      if (name !== "typescript") throw new Error(`Unexpected registry request: ${input}`);
      return Response.json({
        "dist-tags": { latest: "7.0.2" },
        versions: Object.fromEntries(versions.map((version) => [version, { name, version }])),
      });
    });
    const hover = (root: string) =>
      harness.runner.getToolDefinition("lsp")!.execute(
        "sdk",
        {
          operation: "hover",
          server_id: "astro",
          file_path: `${root}/source.astro`,
          line: 2,
          character: 7,
        },
        undefined,
        undefined,
        harness.runner.createContext(),
      );
    await startExtension(harness);
    expect(JSON.stringify(await hover("a"))).toContain("TypeScript SDK 5.9.3");
    expect(JSON.stringify(await hover("b"))).toContain("TypeScript SDK 6.0.3");
    versions = ["5.9.4", "6.0.4", "7.0.2"];
    const command = harness.runner.getRegisteredCommands().find((value) => value.name === "lsp")!;
    await command.handler("update astro", harness.runner.createCommandContext());
    const updated = await installer.list();
    expect(
      updated
        .map((installation) => installation.components.sdk?.version)
        .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["5.9.4", "6.0.4"]);
    expect(JSON.stringify(await hover("a"))).toContain("TypeScript SDK 5.9.3");
    expect(JSON.stringify(await hover("b"))).toContain("TypeScript SDK 6.0.3");
    versions = ["5.9.5", "6.0.5", "7.0.2"];
    await control({ fail: true });
    await command.handler("update astro", harness.runner.createCommandContext());
    expect(await installer.list()).toEqual(updated);
    expect(
      harness.notifications
        .slice(-2)
        .every((message) => message.includes("previous installation retained")),
    ).toBe(true);
    await shutdownExtension(harness);
    await writeFile(
      resolve(harness.agentDirectory, "settings.json"),
      JSON.stringify({ lsp: { autoInstall: false } }),
    );
    vi.stubGlobal("fetch", () => Promise.reject(new Error("Installed-only must not fetch")));
    await startExtension(harness);
    expect(JSON.stringify(await hover("a"))).toContain("TypeScript SDK 5.9.4");
    expect(JSON.stringify(await hover("b"))).toContain("TypeScript SDK 6.0.4");
  }, 15_000);

  test("framework updates advance the compatible SDK atomically and retain the working pair on incompatibility", async () => {
    const { harness, store } = await managedHarness();
    const installer = new ToolInstaller(store);
    await installer.ensure(
      {
        id: "lsp-astro",
        requirements: {
          node: "core:node@26.8.2",
          server: "npm:@astrojs/language-server@2.0.0",
          sdk: "npm:typescript@5.9.2",
        },
      },
      { allowDownload: true },
    );
    let serverVersion = "3.0.0";
    let peer = "^6.0.0";
    vi.stubGlobal("fetch", async (input: string) => {
      const name = decodeURIComponent(new URL(input).pathname.slice(1));
      if (name === "@astrojs/language-server")
        return Response.json({
          "dist-tags": { latest: serverVersion },
          versions: {
            [serverVersion]: {
              name,
              version: serverVersion,
              peerDependencies: { typescript: peer },
            },
          },
        });
      if (name === "typescript")
        return Response.json({
          "dist-tags": { latest: "7.0.2" },
          versions: Object.fromEntries(
            ["5.9.2", "6.0.3", "7.0.2"].map((version) => [version, { name, version }]),
          ),
        });
      throw new Error(`Unexpected registry request: ${input}`);
    });
    await startExtension(harness);
    const command = harness.runner.getRegisteredCommands().find((value) => value.name === "lsp")!;
    await command.handler("update astro", harness.runner.createCommandContext());
    const selected = await installer.installed("lsp-astro");
    expect(selected?.components.server?.version).toBe("3.0.0");
    expect(selected?.components.sdk?.version).toBe("6.0.3");
    expect(harness.notifications.join("\n")).toContain(
      "running Instances keep their existing executables",
    );
    serverVersion = "4.0.0";
    peer = "^7.0.0";
    await command.handler("update astro", harness.runner.createCommandContext());
    expect(await installer.installed("lsp-astro")).toEqual(selected);
    expect(harness.notifications.at(-1)).toContain("no compatible JavaScript TypeScript SDK");
    expect(harness.notifications.at(-1)).toContain("previous installation retained");
  });
  test.each([false, true])(
    "Deno never launches a repairing npm wrapper (downloads: %s)",
    async (allowDownload) => {
      const { harness, store } = await managedHarness({ lsp: { autoInstall: allowDownload } });
      const cwd = harness.sessionManager.getCwd();
      const pkg = resolve(cwd, "node_modules/deno");
      const bin = resolve(cwd, "node_modules/.bin");
      await mkdir(pkg, { recursive: true });
      await mkdir(bin, { recursive: true });
      const manifest = JSON.stringify({ name: "deno", version: "2.9.6", bin: { deno: "bin.cjs" } });
      const script = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(resolve(pkg, "wrapper-executed"))}, "repaired"); import(${JSON.stringify(new URL("fixtures/fake-lsp-server.mjs", import.meta.url).href)});\n`;
      await writeFile(resolve(pkg, "package.json"), manifest);
      // Shadow inherited NODE_PATH payloads so this project genuinely lacks the native closure.
      const target = `${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`;
      const optional = resolve(cwd, "node_modules/@deno", target);
      await mkdir(optional, { recursive: true });
      await writeFile(
        resolve(optional, "package.json"),
        JSON.stringify({ name: `@deno/${target}`, version: "2.9.6" }),
      );
      await writeFile(resolve(pkg, "bin.cjs"), script);
      await chmod(resolve(pkg, "bin.cjs"), 0o755);
      if (process.platform === "win32") {
        await writeFile(
          resolve(bin, "deno.cmd"),
          `@echo off\r\n"${process.execPath}" "%~dp0..\\deno\\bin.cjs" %*\r\n`,
        );
      } else {
        await symlink("../deno/bin.cjs", resolve(bin, "deno"));
      }
      await writeFile(resolve(cwd, "deno.json"), "{}");
      await writeFile(resolve(cwd, "deno.lock"), "unchanged lockfile\n");
      await writeFile(resolve(cwd, "source.ts"), "export const answer = 42;\n");
      await startExtension(harness);
      const result = harness.runner
        .getToolDefinition("lsp")!
        .execute(
          "deno-wrapper",
          { operation: "document_symbols", server_id: "deno", file_path: "source.ts" },
          undefined,
          undefined,
          harness.runner.createContext(),
        );
      if (allowDownload) {
        expect(JSON.stringify(await result)).toContain("deno-native-fixture");
        expect(
          (await new ToolInstaller(store).installed("lsp-deno"))?.components.runtime,
        ).toBeDefined();
      } else {
        await expect(result).rejects.toThrow(/unavailable|not installed/i);
        expect(await new ToolInstaller(store).installed("lsp-deno")).toBeUndefined();
      }
      expect((await readdir(pkg)).sort((a, b) => a.localeCompare(b))).toEqual([
        "bin.cjs",
        "package.json",
      ]);
      expect(await readFile(resolve(pkg, "package.json"), "utf8")).toBe(manifest);
      expect(await readFile(resolve(pkg, "bin.cjs"), "utf8")).toBe(script);
      expect(await readFile(resolve(cwd, "deno.lock"), "utf8")).toBe("unchanged lockfile\n");
      expect(await readFile(resolve(cwd, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
    },
  );

  test.each([{ nodeModulesDir: "auto" }, { vendor: true }])(
    "Deno refuses automatic dependency writes before acquisition: %j",
    async (config) => {
      const harness = await createExtensionHarness(false, { lsp: { autoInstall: false } }, true);
      const cwd = harness.sessionManager.getCwd();
      const text = JSON.stringify(config);
      await writeFile(resolve(cwd, "deno.jsonc"), `// project policy\n${text}\n`);
      await writeFile(resolve(cwd, "source.ts"), "export const answer = 42;\n");
      vi.stubEnv("PATH", "");
      await startExtension(harness);
      try {
        const tool = harness.runner.getToolDefinition("lsp");
        if (!tool) throw new Error("Expected lsp");
        await expect(
          tool.execute(
            "unsafe-deno",
            { operation: "document_symbols", file_path: "source.ts" },
            undefined,
            undefined,
            harness.runner.createContext(),
          ),
        ).rejects.toThrow("automatic dependency writes");
        expect(await readdir(harness.agentDirectory)).not.toContain("managed-tools");
        expect(await readFile(resolve(cwd, "deno.jsonc"), "utf8")).toBe(
          `// project policy\n${text}\n`,
        );
      } finally {
        await shutdownExtension(harness);
      }
    },
  );
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
      let pid: number;
      try {
        // Keep readiness below the production version probe's five-second deadline.
        await expect
          .poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 4_000 })
          .not.toBe("");
        pid = Number(await readFile(marker, "utf8"));
      } finally {
        controller.abort();
        await cancelled;
      }
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
  }, 15_000);

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

  test.each([false, true])(
    "keeps lsp usable across startup, reload, and shutdown (noSession: %s)",
    async (noSession) => {
      const harness = await createExtensionHarness(false, {}, noSession);
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
      const errors: unknown[] = [];
      await session.bindExtensions({
        mode: "rpc",
        uiContext: session.extensionRunner.getUIContext(),
        onError: (error) => errors.push(error),
      });
      expect(errors).toEqual([]);
      expect(harness.sessionManager.getSessionDir()).toBe(
        noSession ? "" : harness.sessionDirectory,
      );
      const status = async () => {
        const tool = session.getToolDefinition("lsp");
        if (tool === undefined) throw new Error("Expected LSP tool");
        return tool.execute(
          "status",
          { operation: "status" },
          undefined,
          undefined,
          session.extensionRunner.createContext(),
        );
      };
      expect(await status()).toMatchObject({ details: { operation: "status" } });
      const firstDirectories = await piLspSessionDirectories(harness.sessionDirectory);
      expect(firstDirectories).toHaveLength(1);

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
      expect(errors).toEqual([]);
      expect(await status()).toMatchObject({ details: { operation: "status" } });
      const reloadedDirectories = await piLspSessionDirectories(harness.sessionDirectory);
      expect(reloadedDirectories).toHaveLength(1);
      expect(reloadedDirectories).not.toEqual(firstDirectories);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(await piLspSessionDirectories(harness.sessionDirectory)).toEqual([]);
    },
  );

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
