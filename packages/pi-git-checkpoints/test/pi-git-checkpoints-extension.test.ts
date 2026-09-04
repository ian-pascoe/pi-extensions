import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type SessionBeforeTreeEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SessionTreeEvent,
  type TurnEndEvent,
  type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GIT_CHECKPOINT_UNDO_ENTRY_TYPE } from "../src/git-checkpoint-history.js";
import { createPiGitCheckpointsExtension } from "../src/pi-git-checkpoints-extension.js";

const temporaryDirectories: string[] = [];
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface GitCheckpointsHarness {
  readonly cwd: string;
  readonly notifications: string[];
  readonly runner: ExtensionRunner;
  readonly sessionManager: SessionManager;
  failNextUndoAppend(): void;
  selectChoice: string | undefined;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function createHarness(hasUI = true): Promise<GitCheckpointsHarness> {
  const cwd = await temporaryDirectory("pi-git-checkpoints-lifecycle-cwd-");
  const agentDirectory = await temporaryDirectory("pi-git-checkpoints-lifecycle-agent-");
  const sessionDirectory = await temporaryDirectory("pi-git-checkpoints-lifecycle-session-");
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(resolve(cwd, ".pi/settings.json"), "{}");
  await writeFile(resolve(agentDirectory, "settings.json"), "{}");

  const sessionManager = SessionManager.create(cwd, sessionDirectory);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    extensionFactories: [
      {
        name: "pi-git-checkpoints-lifecycle-test",
        factory: createPiGitCheckpointsExtension(() => agentDirectory),
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
  let failNextUndoAppend = false;
  runner.bindCore(
    {
      sendMessage: () => undefined,
      sendUserMessage: () => undefined,
      appendEntry: (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
        if (failNextUndoAppend && customType === GIT_CHECKPOINT_UNDO_ENTRY_TYPE) {
          failNextUndoAppend = false;
          throw new Error("injected session write failure after append");
        }
      },
      setSessionName: () => undefined,
      getSessionName: () => undefined,
      setLabel: () => undefined,
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
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "Git Checkpoints lifecycle test",
    },
  );
  runner.bindCommandContext({
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => undefined,
  });

  const notifications: string[] = [];
  const harness: GitCheckpointsHarness = {
    cwd,
    failNextUndoAppend: () => {
      failNextUndoAppend = true;
    },
    notifications,
    runner,
    sessionManager,
    selectChoice: undefined,
  };
  if (hasUI) {
    runner.setUIContext(
      {
        ...runner.getUIContext(),
        notify: (message) => notifications.push(message),
        select: async () => harness.selectChoice,
        confirm: async () => true,
      },
      "rpc",
    );
  }
  await runner.emit({ type: "session_start", reason: "startup" } satisfies SessionStartEvent);
  return harness;
}

async function completeModelStep(
  harness: GitCheckpointsHarness,
  turnIndex: number,
  content: string,
): Promise<{ readonly assistantId: string; readonly endEntryId: string }> {
  await harness.runner.emit({
    type: "turn_start",
    turnIndex,
    timestamp: Date.now(),
  } satisfies TurnStartEvent);
  await writeFile(resolve(harness.cwd, "code.txt"), content);
  const message = assistantMessage(`step ${turnIndex}`);
  const assistantId = harness.sessionManager.appendMessage(message);
  await harness.runner.emit({
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  } satisfies TurnEndEvent);
  const endEntryId = harness.sessionManager.getLeafId();
  if (endEntryId === null) throw new Error("Expected a Model Step end entry");
  return { assistantId, endEntryId };
}

function beforeTreeEvent(oldLeafId: string, targetId: string): SessionBeforeTreeEvent {
  return {
    type: "session_before_tree",
    preparation: {
      targetId,
      oldLeafId,
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: false,
    },
    signal: new AbortController().signal,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Pi Git Checkpoints lifecycle", () => {
  test("captures paired Model Steps, restores only after tree navigation, and supports one-level undo", async () => {
    const harness = await createHarness();
    await writeFile(resolve(harness.cwd, "code.txt"), "one\n");
    harness.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const first = await completeModelStep(harness, 0, "two\n");
    harness.sessionManager.appendMessage({
      role: "user",
      content: "second",
      timestamp: Date.now(),
    });
    const second = await completeModelStep(harness, 1, "three\n");

    harness.selectChoice = "Restore code and navigate";
    const beforeResult = await harness.runner.emit(
      beforeTreeEvent(second.endEntryId, first.assistantId),
    );
    expect(beforeResult).toBeUndefined();
    expect(await readFile(resolve(harness.cwd, "code.txt"), "utf8")).toBe("three\n");

    harness.sessionManager.branch(first.assistantId);
    await harness.runner.emit({
      type: "session_tree",
      oldLeafId: second.endEntryId,
      newLeafId: first.assistantId,
    } satisfies SessionTreeEvent);
    expect(await readFile(resolve(harness.cwd, "code.txt"), "utf8")).toBe("two\n");
    expect(
      harness.sessionManager
        .getEntries()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === GIT_CHECKPOINT_UNDO_ENTRY_TYPE,
        ),
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          record: expect.objectContaining({ paths: ["code.txt"] }),
          version: 1,
        }),
      }),
    ]);
    const sessionFile = harness.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Expected a persisted lifecycle test session");
    expect(await readFile(sessionFile, "utf8")).toContain(GIT_CHECKPOINT_UNDO_ENTRY_TYPE);

    await harness.runner.emit({
      type: "session_shutdown",
      reason: "reload",
    } satisfies SessionShutdownEvent);
    await harness.runner.emit({
      type: "session_start",
      reason: "reload",
    } satisfies SessionStartEvent);

    const command = harness.runner.getCommand("checkpoint");
    if (!command) throw new Error("Expected /checkpoint command");
    await command.handler("status", harness.runner.createCommandContext());
    harness.failNextUndoAppend();
    await command.handler("undo", harness.runner.createCommandContext());
    expect(await readFile(resolve(harness.cwd, "code.txt"), "utf8")).toBe("three\n");
    const undoEntries = harness.sessionManager
      .getEntries()
      .filter(
        (entry) => entry.type === "custom" && entry.customType === GIT_CHECKPOINT_UNDO_ENTRY_TYPE,
      );
    expect(undoEntries).toHaveLength(2);
    expect(undoEntries.at(-1)).toMatchObject({ data: { record: null, version: 1 } });
    await command.handler("undo", harness.runner.createCommandContext());
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.stringContaining("active standalone"),
        expect.stringContaining("undo restored 1 path(s)"),
        expect.stringContaining("undo unavailable"),
        expect.stringContaining("undo state remains active in memory"),
      ]),
    );
  });

  test("skips an approved Restore when a path changes before session_tree", async () => {
    const harness = await createHarness();
    await writeFile(resolve(harness.cwd, "code.txt"), "one\n");
    harness.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const first = await completeModelStep(harness, 0, "two\n");
    harness.sessionManager.appendMessage({
      role: "user",
      content: "second",
      timestamp: Date.now(),
    });
    const second = await completeModelStep(harness, 1, "three\n");

    harness.selectChoice = "Restore code and navigate";
    await harness.runner.emit(beforeTreeEvent(second.endEntryId, first.assistantId));
    await writeFile(resolve(harness.cwd, "code.txt"), "external\n");
    harness.sessionManager.branch(first.assistantId);
    await harness.runner.emit({
      type: "session_tree",
      oldLeafId: second.endEntryId,
      newLeafId: first.assistantId,
    } satisfies SessionTreeEvent);

    expect(await readFile(resolve(harness.cwd, "code.txt"), "utf8")).toBe("external\n");
    expect(harness.notifications).toContainEqual(expect.stringContaining("approved paths changed"));
  });

  test("keeps files unchanged during noninteractive tree navigation", async () => {
    const harness = await createHarness(false);
    await writeFile(resolve(harness.cwd, "code.txt"), "one\n");
    harness.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const first = await completeModelStep(harness, 0, "two\n");
    harness.sessionManager.appendMessage({
      role: "user",
      content: "second",
      timestamp: Date.now(),
    });
    const second = await completeModelStep(harness, 1, "three\n");

    await harness.runner.emit(beforeTreeEvent(second.endEntryId, first.assistantId));
    harness.sessionManager.branch(first.assistantId);
    await harness.runner.emit({
      type: "session_tree",
      oldLeafId: second.endEntryId,
      newLeafId: first.assistantId,
    } satisfies SessionTreeEvent);

    expect(await readFile(resolve(harness.cwd, "code.txt"), "utf8")).toBe("three\n");
  });
});
