import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
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
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";
import { POST_EDIT_DIAGNOSTICS_ENTRY_TYPE } from "../src/lsp-post-edit-diagnostics-rendering.js";
import { LspWorkspaceEditStore } from "../src/lsp-workspace-edit.js";
import type { LspSettingsDocumentInput } from "../src/pi-lsp-settings.js";

const temporaryDirectories: string[] = [];
const agentSessions: AgentSession[] = [];

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
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createExtensionHarness(
  projectTrusted: boolean,
  globalSettings: LspSettingsDocumentInput = {},
  noSession = false,
): Promise<ExtensionHarness> {
  const cwd = await makeTemporaryDirectory("pi-lsp-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-lsp-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-lsp-extension-sessions-");
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
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

afterEach(async () => {
  vi.unstubAllEnvs();
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

  test("stops only the selected root and accepts quoted paths without changing enablement", async () => {
    const fakeServerPath = fileURLToPath(new URL("fixtures/fake-lsp-server.mjs", import.meta.url));
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
    const firstRoot = resolve(harness.sessionManager.getCwd(), "first root");
    const secondRoot = resolve(harness.sessionManager.getCwd(), "second");
    for (const root of [firstRoot, secondRoot]) {
      await mkdir(root);
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
    expect(await command.getArgumentCompletions?.(`stop fake "${firstRoot.slice(0, -2)}`)).toEqual([
      { value: `stop fake ${JSON.stringify(firstRoot)}`, label: firstRoot },
    ]);
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
      { operation: "capabilities", server_id: "fake", file_path: resolve(firstRoot, "source.ts") },
      undefined,
      undefined,
      harness.runner.createContext(),
    );
    await shutdownExtension(harness);
  });

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
