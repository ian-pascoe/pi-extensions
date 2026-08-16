import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";
import { LspWorkspaceEditStore } from "../src/lsp-workspace-edit.js";

const temporaryDirectories: string[] = [];

interface ExtensionHarness {
  readonly notifications: string[];
  readonly runner: ExtensionRunner;
  readonly sessionDirectory: string;
  readonly sessionManager: SessionManager;
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createExtensionHarness(projectTrusted: boolean): Promise<ExtensionHarness> {
  const cwd = await makeTemporaryDirectory("pi-lsp-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-lsp-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-lsp-extension-sessions-");
  await writeFile(resolve(agentDirectory, "settings.json"), "{}\n");
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(
    resolve(cwd, ".pi/settings.json"),
    JSON.stringify({ lsp: { unknownField: true } }),
  );

  const sessionManager = SessionManager.create(cwd, sessionDirectory);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
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
  return { notifications, runner, sessionDirectory, sessionManager };
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

async function piLspSessionDirectories(sessionDirectory: string): Promise<string[]> {
  return (await readdir(sessionDirectory)).filter((entry) => entry.startsWith("pi-lsp-"));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi LSP extension lifecycle", () => {
  test("registers lazily, replays only the active branch, augments writes, and shuts down idempotently", async () => {
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

    expect(harness.runner.getAllRegisteredTools()).toEqual([]);
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

  test("reports malformed trusted project settings without starting a server", async () => {
    const harness = await createExtensionHarness(true);
    await startExtension(harness);
    expect(harness.notifications).toContainEqual(expect.stringContaining("project lsp"));
    expect(harness.runner.getAllRegisteredTools()).toHaveLength(1);
    await shutdownExtension(harness);
  });
});
