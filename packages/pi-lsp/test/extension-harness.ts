import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";
import type { LspSettingsDocumentInput } from "../src/pi-lsp-settings.js";

/** One Pi session running the pi-lsp extension through Pi's own resource loader and runner. */
export interface ExtensionHarness {
  readonly agentDirectory: string;
  readonly notifications: string[];
  readonly resourceLoader: DefaultResourceLoader;
  readonly runner: ExtensionRunner;
  readonly sessionDirectory: string;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
}

/** A project and Pi agent directory that several harnesses can share, as sessions in one process do. */
export interface ExtensionHarnessDirectories {
  readonly cwd: string;
  readonly agentDirectory: string;
}

const temporaryDirectories: string[] = [];

/** Create a temporary directory that `removeHarnessDirectories` deletes. */
export async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Delete every directory the harnesses created. */
export async function removeHarnessDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
}

/**
 * Load the extension into a new Pi session. Without `directories`, the session gets a fresh
 * project, whose untrusted `.pi/settings.json` holds an unknown `lsp` field, and a fresh agent
 * directory holding `globalSettings`; with them, it joins that project and agent directory as is.
 */
export async function createExtensionHarness(
  projectTrusted: boolean,
  globalSettings: LspSettingsDocumentInput = {},
  noSession = false,
  directories?: ExtensionHarnessDirectories,
): Promise<ExtensionHarness> {
  const sessionDirectory = await makeTemporaryDirectory("pi-lsp-extension-sessions-");
  let cwd: string;
  let agentDirectory: string;
  if (directories === undefined) {
    cwd = await makeTemporaryDirectory("pi-lsp-extension-cwd-");
    agentDirectory = await makeTemporaryDirectory("pi-lsp-extension-agent-");
    await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
    await mkdir(resolve(cwd, ".pi"));
    await writeFile(
      resolve(cwd, ".pi/settings.json"),
      JSON.stringify({ lsp: { unknownField: true } }),
    );
  } else {
    ({ cwd, agentDirectory } = directories);
  }

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
      getSettings: () => ({}),
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
      getSystemPrompt: () => "Pi LSP lifecycle test",
    },
  );
  const notifications: string[] = [];
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message) => notifications.push(message),
    },
    "rpc",
  );
  return {
    agentDirectory,
    notifications,
    resourceLoader,
    runner,
    sessionDirectory,
    sessionManager,
    settingsManager,
  };
}

/** Deliver Pi's `session_start` for a startup. */
export async function startExtension(harness: ExtensionHarness): Promise<void> {
  await harness.runner.emit({
    type: "session_start",
    reason: "startup",
  } satisfies SessionStartEvent);
}

/** Deliver Pi's `session_shutdown` for a quit. */
export async function shutdownExtension(harness: ExtensionHarness): Promise<void> {
  await harness.runner.emit({
    type: "session_shutdown",
    reason: "quit",
  } satisfies SessionShutdownEvent);
}

/** The `globalThis` slot of the Server Instance pool every session in the process shares. */
const SHARED_POOL_SLOT = Symbol.for("@ian-pascoe/pi-lsp/server-instance-pool.v1");

/**
 * Forget the shared Server Instance pool, so the next test starts with an empty one, and return how
 * many instances it still held: a test that shut down every session leaves none.
 */
export function resetSharedServerInstancePool(): number {
  const slot: unknown = Object.getOwnPropertyDescriptor(globalThis, SHARED_POOL_SLOT)?.value;
  Reflect.deleteProperty(globalThis, SHARED_POOL_SLOT);
  return slot instanceof Map ? slot.size : 0;
}
