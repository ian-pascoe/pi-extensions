/**
 * SDK-level Todo proofs: real Pi sessions run offline with only the model stream scripted. They
 * cover what the mock-driven unit tests cannot: a real failed disk write quarantining the session,
 * Tasks restoring through tree navigation, reload, resume and fork, and a missing journal anchor
 * aborting the request before any provider fetch.
 */
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  withoutInitialSystemMessage,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type StreamFunction,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionError,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { recordToolOutputs } from "@ian-pascoe/pi-utils/tool-testing";
import { describe, expect, onTestFinished, test } from "vite-plus/test";
import piTodoExtension from "../src/index.js";

const SNAPSHOT_HEADER = "Todo List state from the pi-todo extension";

interface FixtureOptions {
  readonly manager?: SessionManager;
  readonly extensions?: readonly ExtensionFactory[];
}

async function createFixture({ manager, extensions = [] }: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-todo-sdk-session-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const sessionManager = manager ?? SessionManager.create(dir, dir);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const toolOutputs = recordToolOutputs((name) => session.getToolDefinition(name));
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // The extension runs after `extensions`, so a context hook there sees Todo's projections last.
    extensionFactories: [...extensions, piTodoExtension, toolOutputs.extension],
    systemPromptOverride: () => "Standing instructions: answer with the shortest correct turn.",
  });
  await loader.reload();
  const model = getModel("anthropic", "claude-sonnet-4-5");
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
    sessionManager,
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
    model,
    noTools: "builtin",
  });
  onTestFinished(() => session.dispose());
  // Every tool result must conform to the tool's declared outputSchema.
  onTestFinished(() => toolOutputs.check());
  const requests: Array<{ messages: Message[] }> = [];
  const responses: AssistantMessage[] = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    requests.push({ messages: structuredClone(withoutInitialSystemMessage(context.messages)) });
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected model request");
    const message: AssistantMessage = {
      ...next,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else if (message.stopReason !== "pending") {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    });
    return stream;
  };
  const extensionErrors: ExtensionError[] = [];
  // RPC supplies an error listener too; bindings make /reload emit session_start.
  await session.bindExtensions({ mode: "rpc", onError: (error) => extensionErrors.push(error) });
  return { dir, manager: sessionManager, session, requests, responses, extensionErrors };
}

const reply = (text: string): AssistantMessage => fauxAssistantMessage(text);

const todoCall = (input: ToolCall["arguments"]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("todo", input, { id: "call-1" })], {
    stopReason: "toolUse",
  });

const snapshots = (messages: readonly Message[]) =>
  messages.filter(
    (message) =>
      message.role === "user" && JSON.stringify(message.content).includes(SNAPSHOT_HEADER),
  );

const todoStateIds = (entries: readonly { type: string; customType?: string; id: string }[]) =>
  entries
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-todo-state")
    .map((entry) => entry.id);

describe("Todo in a real Pi session", () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "quarantines a failed Todo write while disk reopen keeps the acknowledged history",
    async () => {
      const f = await createFixture();
      f.responses.push(todoCall({ action: "add", title: "Acknowledged Task A" }), reply("Saved."));
      await f.session.prompt("Start a durable session with an acknowledged Task");
      const acknowledged = f.manager
        .getBranch()
        .find((entry) => entry.type === "custom" && entry.customType === "pi-todo-state");
      if (!acknowledged) throw new Error("Missing acknowledged Todo state");
      const file = f.manager.getSessionFile();
      if (!file) throw new Error("Missing scratch session file");
      const append = f.manager.appendCustomEntry.bind(f.manager);
      let appendFailure: unknown;
      f.manager.appendCustomEntry = (customType, data) => {
        if (customType !== "pi-todo-state") return append(customType, data);
        chmodSync(file, 0o400);
        try {
          return append(customType, data);
        } catch (error) {
          appendFailure = error;
          throw error;
        } finally {
          chmodSync(file, 0o600);
        }
      };
      f.responses.push(todoCall({ action: "add", title: "Unacknowledged Task" }));
      await f.session.prompt("Attempt a failing Todo write");
      expect(appendFailure).toMatchObject({ code: "EACCES" });
      expect(f.requests).toHaveLength(3);
      // Pi rolls back an entry whose write failed, so disk keeps the acknowledged state on the
      // branch and never the unacknowledged one.
      expect(todoStateIds(f.manager.getBranch())).toEqual([acknowledged.id]);
      expect(todoStateIds(SessionManager.open(file).getBranch())).toEqual([acknowledged.id]);
      f.manager.appendCustomEntry = append;
      await f.session.prompt("Do not send poisoned state");
      expect(f.requests).toHaveLength(3);
      await f.session.reload();
      await f.session.prompt("Still do not send poisoned state after extension reload");
      expect(f.requests).toHaveLength(3);
      expect(f.extensionErrors).toContainEqual(
        expect.objectContaining({
          event: "session_start",
          error: expect.stringContaining("Todo is disabled in this loaded session"),
        }),
      );
      const reopenedManager = SessionManager.open(file);
      const persisted = reopenedManager.getEntries();
      const branch = reopenedManager.getBranch();
      // The error result's parent is the last written entry, so the acknowledged history stays on
      // the reopened branch and every entry's parent is on disk.
      expect(todoStateIds(branch)).toEqual([acknowledged.id]);
      expect(branch[0]!.parentId).toBeNull();
      const persistedIds = new Set(persisted.map((entry) => entry.id));
      expect(
        persisted.every((entry) => entry.parentId === null || persistedIds.has(entry.parentId)),
      ).toBe(true);
      const reopened = await createFixture({ manager: reopenedManager });
      reopened.responses.push(reply("Acknowledged history restored."));
      await reopened.session.prompt("Continue from the persisted session");
      expect(reopened.requests).toHaveLength(1);
      const restored = snapshots(reopened.requests[0]!.messages);
      expect(restored).toHaveLength(1);
      expect(JSON.stringify(restored[0])).toContain("Acknowledged Task A");
      expect(JSON.stringify(restored[0])).not.toContain("Unacknowledged Task");
    },
  );

  test("restores selected-branch Tasks through tree navigation, reload, resume, and fork without duplicate snapshots", async () => {
    const f = await createFixture();
    f.responses.push(todoCall({ action: "add", title: "Selected Task" }), reply("Added."));
    await f.session.prompt("Remember the selected Task");
    const firstLeaf = f.manager.getLeafId();
    if (!firstLeaf) throw new Error("Missing original branch leaf");
    const original = snapshots(f.requests[1]!.messages);
    expect(original).toHaveLength(1);
    f.responses.push(
      todoCall({ action: "update", id: 1, title: "Abandoned sibling Task" }),
      reply("Updated."),
    );
    await f.session.prompt("Change on the sibling branch");
    expect(snapshots(f.requests[3]!.messages)).toHaveLength(2);
    await f.session.navigateTree(firstLeaf, { summarize: false });
    for (const reload of [false, true]) {
      if (reload) await f.session.reload();
      f.responses.push(todoCall({ action: "list" }), reply("Selected branch restored."));
      await f.session.prompt("List the selected Tasks");
      const current = f.requests.at(-1)!.messages;
      expect(snapshots(current)).toEqual(original);
      expect(JSON.stringify(current.at(-1)), `after reload=${reload}`).toContain("Selected Task");
      expect(JSON.stringify(current)).not.toContain("Abandoned sibling Task");
    }
    const file = f.manager.getSessionFile();
    if (!file) throw new Error("Missing scratch session file");
    for (const manager of [
      SessionManager.open(file),
      SessionManager.forkFrom(file, f.dir, f.dir),
    ]) {
      const restored = await createFixture({ manager });
      restored.responses.push(todoCall({ action: "list" }), reply("Inherited selected branch."));
      await restored.session.prompt("List inherited Tasks");
      expect(restored.requests).toHaveLength(2);
      const current = restored.requests[1]!.messages;
      expect(snapshots(current)).toEqual(original);
      expect(JSON.stringify(current.at(-1))).toContain("Selected Task");
      expect(JSON.stringify(current)).not.toContain("Abandoned sibling Task");
      expect(restored.extensionErrors).toEqual([]);
    }
    expect(f.extensionErrors).toEqual([]);
  });

  test("aborts the installed Anthropic SDK before fetch when a Todo journal anchor is missing", async () => {
    const removeAnchor: ExtensionFactory = (pi) => {
      pi.on("context", (event) => ({
        messages: event.messages.filter((message) => message.role !== "toolResult"),
      }));
    };
    const f = await createFixture({ extensions: [removeAnchor] });
    const entry = import.meta.resolve("@earendil-works/pi-ai");
    const api: {
      stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }>;
    } = await import(new URL("./api/anthropic-messages.js", entry).href);
    const sdk: { default: new (options: { apiKey: string; fetch: typeof fetch }) => object } =
      await import(createRequire(entry).resolve("@anthropic-ai/sdk"));
    let fetches = 0;
    const client = new sdk.default({
      apiKey: "TEST-NOT-A-REAL-KEY",
      fetch: async () => {
        fetches++;
        throw new Error("Unexpected network attempt");
      },
    });
    let streams = 0;
    let aborted = false;
    const scripted = f.session.agent.streamFunction!;
    f.session.agent.streamFunction = (model, context, options) => {
      if (streams++ === 0) return scripted(model, context, options);
      aborted = options?.signal?.aborted ?? false;
      return api.stream(getModel("anthropic", "claude-sonnet-4-5"), context, {
        ...options,
        client,
        maxRetries: 0,
      });
    };
    f.responses.push(todoCall({ action: "add", title: "Cannot locate this snapshot" }));
    await f.session.prompt("Add a Task then continue");
    expect(streams).toBe(2);
    expect(aborted).toBe(true);
    expect(fetches).toBe(0);
    expect(f.extensionErrors).toContainEqual(
      expect.objectContaining({
        event: "context",
        error: expect.stringContaining("Todo context anchor is missing or ambiguous"),
      }),
    );
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });
});
