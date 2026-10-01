import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type EditorComponent } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createKeybindings, createTui, editorTheme } from "./vim-pi-fixture.js";

const COMMAND_DECK = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const MINIMAL_SUBAGENTS = fileURLToPath(
  new URL("../../pi-minimal-subagents/src/index.ts", import.meta.url),
);

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

const directories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

beforeAll(() => initTheme("dark"));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

type ExtensionMode = NonNullable<Parameters<ExtensionRunner["setUIContext"]>[1]>;

async function createHarness(extensionPaths: string[], mode: ExtensionMode = "tui") {
  const cwd = await temporaryDirectory("command-deck-cwd-");
  const agentDir = await temporaryDirectory("command-deck-agent-");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: extensionPaths,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  expect(extensions.errors).toEqual([]);

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const sessionManager = SessionManager.inMemory(cwd);
  const runner = new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    cwd,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  const extensionErrors: string[] = [];
  runner.onError((error) => extensionErrors.push(error.error));
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
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "Command Deck test system prompt",
    },
  );

  const { tui } = createTui();
  const notifications: Array<{ message: string; level: string }> = [];
  const custom = vi.fn();
  let factory: EditorFactory | undefined;
  let editor: EditorComponent | undefined;
  const keybindings = createKeybindings();
  const setEditorComponent: ExtensionUIContext["setEditorComponent"] = (next) => {
    factory = next;
    editor = next?.(tui, editorTheme, keybindings);
    tui.setFocus(editor ?? null);
  };
  const footer = vi.fn();
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message, level) => notifications.push({ message, level: level ?? "info" }),
      custom: <T>() => {
        custom();
        return new Promise<T>(() => {});
      },
      getEditorComponent: () => factory,
      setEditorComponent,
      setFooter: footer,
      setWorkingVisible: () => undefined,
    },
    mode,
  );

  return {
    runner,
    notifications,
    extensionErrors,
    custom,
    footer,
    getFactory: () => factory,
    setEditorComponent,
    editor() {
      if (!editor) throw new Error("Expected an installed editor");
      return editor;
    },
    async start() {
      await runner.emit({ type: "session_start", reason: "startup" });
    },
    async shutdown() {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    },
  };
}

describe("Command Deck extension", () => {
  it("installs nothing outside the TUI", async () => {
    const harness = await createHarness([COMMAND_DECK], "rpc");
    await harness.start();
    expect(harness.getFactory()).toBeUndefined();
    expect(harness.footer).not.toHaveBeenCalled();
    await harness.shutdown();
  });

  it("frames the Vim editor with the Deck Header and Mode Rail", async () => {
    const harness = await createHarness([COMMAND_DECK]);
    await harness.start();
    const editor = harness.editor();
    expect("getModeLabel" in editor).toBe(true);
    expect(harness.footer).toHaveBeenCalledOnce();

    const lines = editor.render(60).map((line) => stripTerminalSequences(line));
    expect(lines[0]).toMatch(/^─ command-deck-cwd-\w+ .*no model · medium ─$/);
    expect(lines[1]).toContain("Type your prompt…");
    expect(lines.at(-1)).toMatch(/^─ INSERT ─+ cache \? · ctx \? ─$/);

    editor.handleInput("x");
    editor.handleInput("\x1b");
    const normal = editor.render(60).map((line) => stripTerminalSequences(line));
    expect(normal[1]).not.toContain("Type your prompt…");
    expect(normal.at(-1)).toMatch(/^─ NORMAL ─/);
    expect(harness.extensionErrors).toEqual([]);
    await harness.shutdown();
  });

  it("warns when it replaces another extension's editor but not its own", async () => {
    const harness = await createHarness([COMMAND_DECK]);
    harness.setEditorComponent((...args) => new ForeignEditor(...args));
    await harness.start();
    expect(harness.notifications).toEqual([
      expect.objectContaining({ level: "warning", message: expect.stringContaining("replaced") }),
    ]);

    await harness.shutdown();
    harness.notifications.length = 0;
    await harness.start();
    expect(harness.notifications).toEqual([]);
    await harness.shutdown();
  });

  it("keeps Minimal Subagents' viewer shortcut when it loads first", async () => {
    const harness = await createHarness([COMMAND_DECK, MINIMAL_SUBAGENTS]);
    await harness.start();
    const editor = harness.editor();
    expect(harness.notifications.filter(({ level }) => level === "warning")).toEqual([]);
    expect(
      editor
        .render(60)
        .map((line) => stripTerminalSequences(line))
        .at(-1),
    ).toMatch(/^─ INSERT ─/);

    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    editor.handleInput("\x1b[D");
    clock.mockReturnValue(1_200);
    editor.handleInput("\x1b[D");
    expect(harness.custom).toHaveBeenCalledOnce();
    await harness.shutdown();
  });

  it("warns when an editor-wrapping extension loads first", async () => {
    const harness = await createHarness([MINIMAL_SUBAGENTS, COMMAND_DECK]);
    await harness.start();
    expect(harness.notifications).toContainEqual(
      expect.objectContaining({ level: "warning", message: expect.stringContaining("replaced") }),
    );
    await harness.shutdown();
  });
});

/** A foreign editor that another extension might install. */
class ForeignEditor implements EditorComponent {
  private text = "";
  constructor(..._args: Parameters<EditorFactory>) {}
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
  }
  handleInput(): void {}
  invalidate(): void {}
  render(): string[] {
    return [];
  }
}
