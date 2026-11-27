/**
 * Combined-mode test: Pi Todo and Pi Secret loaded together, in the order the root `package.json`
 * lists them.
 *
 * Why this lives at the repository root: see `formatter-lsp-combined-order.test.ts`. Neither
 * package depends on the other; both rewrite the request on Pi's `context_with_system` event.
 *
 * What it pins: Pi Todo projects a Todo List Snapshot and Pi Secret then redacts the held value
 * in it, while neither rewrites Pi's system messages. A prompt change after the Snapshot arrives as
 * a system message after the history, so the earlier request stays the later one's prefix.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import rootManifest from "../package.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TODO_ENTRYPOINT = "./packages/pi-todo/src/index.ts";
const SECRET_ENTRYPOINT = "./packages/pi-secret/src/index.ts";
const SNAPSHOT_HEADER = "Todo List state from the pi-todo extension (not a user message):";

/** The two extensions in the order the root `package.json` lists them, which Pi loads in. */
const collectionOrder = rootManifest.pi.extensions.filter(
  (entrypoint) => entrypoint === TODO_ENTRYPOINT || entrypoint === SECRET_ENTRYPOINT,
);

const directories: string[] = [];
const sessions: AgentSession[] = [];

function loaderFor(cwd: string, settingsManager: SettingsManager, prompt: () => string) {
  return new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: collectionOrder.map((entrypoint) =>
      resolve(repositoryRoot, entrypoint),
    ),
    systemPromptOverride: prompt,
  });
}

/**
 * Pi compiles extension TypeScript with jiti and caches it on disk; loading both once here keeps
 * that one-time cost out of the test's own timeout (see `secret-guardian-combined.test.ts`).
 */
beforeAll(async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-todo-secret-warm-up-"));
  try {
    const loader = loaderFor(cwd, SettingsManager.inMemory(), () => "Warm up.");
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function toolCall(name: string, args: ToolCall["arguments"], id: string): AssistantMessage {
  return {
    ...fauxAssistantMessage(""),
    content: [{ type: "toolCall", name, arguments: args, id }],
    stopReason: "toolUse",
  };
}

function snapshotTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return [];
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    return text[0]?.startsWith(SNAPSHOT_HEADER) ? [text.join("")] : [];
  });
}

describe("Pi Todo with Pi Secret", () => {
  test("the collection loads Pi Todo before Pi Secret", () => {
    expect(collectionOrder).toEqual([TODO_ENTRYPOINT, SECRET_ENTRYPOINT]);
  });

  test("a Snapshot holds only the Secret Reference, and a later prompt change keeps the request prefix", async () => {
    const value = "tok-todo-secret-8e21";
    const dir = await mkdtemp(join(tmpdir(), "pi-todo-secret-"));
    directories.push(dir);
    let prompt = "Standing instructions: work in the first checkout.";
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = loaderFor(dir, settingsManager, () => prompt);
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      sessionManager: SessionManager.create(dir, join(dir, "sessions")),
      settingsManager,
      resourceLoader: loader,
      modelRuntime,
      model: getModel("anthropic", "claude-sonnet-4-5"),
      noTools: "builtin",
    });
    sessions.push(session);

    const responses = [
      toolCall("secret_ask", { names: ["STAGING"] }, "call-ask"),
      fauxAssistantMessage("Stored."),
      // The reference resolves to the value before `todo` runs, so the Todo journal holds it.
      toolCall(
        "todo",
        { action: "add", tasks: [{ title: "Rotate {{secret:STAGING}}" }, { title: "Verify" }] },
        "call-add",
      ),
      toolCall("todo", { action: "update", id: 2, status: "active" }, "call-update"),
      // The session keeps this reply as written; only the request carries the Secret Reference.
      fauxAssistantMessage(`Planned the rotation of ${value}.`),
      fauxAssistantMessage("Moved."),
    ];
    const requests: Message[][] = [];
    session.agent.streamFunction = (model, context) => {
      requests.push(structuredClone(context.messages));
      const next = responses.shift();
      if (next === undefined) throw new Error("Unexpected model request");
      const message = { ...next, api: model.api, provider: model.provider, model: model.id };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    };
    const errors: string[] = [];
    session.extensionRunner.onError((error) => errors.push(`${error.event}: ${error.error}`));
    const runner = session.extensionRunner;
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...runner.getUIContext(),
        // Accepts `/todo clear`'s confirmation.
        confirm: async () => true,
        custom: (factory) =>
          new Promise((resolveDialog) => {
            void (async () => {
              const dialog: Component = await factory(
                // SAFETY: the dialog only asks the TUI to re-render.
                { requestRender: () => {} } as never,
                // SAFETY: the dialog styles only through `fg`, `bg`, and `bold`.
                {
                  fg: (_color: string, text: string) => text,
                  bold: (text: string) => text,
                } as never,
                // SAFETY: the dialog matches keys through the keybindings manager only.
                getKeybindings() as never,
                resolveDialog,
              );
              dialog.handleInput?.(`\x1b[200~${value}\x1b[201~`);
              dialog.handleInput?.("\r");
            })();
          }),
      },
    });

    await session.prompt("Store my staging token.");
    await session.prompt("Plan the rotation.");
    // Todo state outside a tool group, anchored on the reply that holds the raw value.
    await session.prompt("/todo clear");
    // Like moving the session to another worktree: only the prompt text changes.
    prompt = "Standing instructions: work in the second checkout.";
    await session.reload();
    await session.prompt("Continue here.");

    expect(errors).toEqual([]);
    expect(responses).toHaveLength(0);
    expect(requests).toHaveLength(6);
    const before = requests[4]!;
    const after = requests[5]!;
    // The redacted `add` result no longer shows the stored list, so it gets a Snapshot too.
    expect(snapshotTexts(after)).toEqual([
      `${SNAPSHOT_HEADER}\n[ ] #1 Rotate {{secret:STAGING}}\n[ ] #2 Verify`,
      `${SNAPSHOT_HEADER}\n[ ] #1 Rotate {{secret:STAGING}}\n[>] #2 Verify`,
      `${SNAPSHOT_HEADER}\nTodo List is empty`,
    ]);
    const cleared = after.findIndex((message) =>
      snapshotTexts([message])[0]?.endsWith("Todo List is empty"),
    );
    expect(JSON.stringify(after[cleared - 1])).toContain(
      "Planned the rotation of {{secret:STAGING}}.",
    );
    expect(JSON.stringify(requests)).not.toContain(value);

    // The earlier request is the later one's prefix. Pi may re-serialize the leading system message
    // with another key order, so it is compared structurally (see pi-todo's cache-prefix test).
    expect(after[0]).toEqual(before[0]);
    expect(JSON.stringify(after.slice(1, before.length))).toBe(JSON.stringify(before.slice(1)));
    // The prompt change follows the history, and both system messages are Pi's own: the update
    // byte for byte, the leading one structurally for the reason above.
    const system = after.filter((message) => message.role === "system");
    const recorded = session.messages.filter((message) => message.role === "system");
    expect(system).toHaveLength(2);
    expect(after.indexOf(system[1]!)).toBeGreaterThanOrEqual(before.length);
    expect(system[0]).toEqual(recorded[0]);
    expect(JSON.stringify(system[1])).toBe(JSON.stringify(recorded[1]));
    // Six model requests through two real extensions, beyond the 20 s default under a cold
    // `vp run verify`; `beforeAll` takes the compile cost, this only guards against a hang.
  }, 60_000);
});
