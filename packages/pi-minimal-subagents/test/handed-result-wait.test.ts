import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
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
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, test, vi } from "vitest";
import { createMinimalSubagentsExtension } from "../src/minimal-subagents-extension.js";
import { replayRegistryEntries } from "../src/minimal-subagents-registry.js";
import { RecordingAgentSessionFactory } from "./fixtures/recording-sessions.js";

const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** The Recording child's outputs for a spawned turn and for a turn started by `agent_message`. */
const SPAWN_OUTPUT = "completed child turn";
const MESSAGE_OUTPUT = "completed child message";
/** Covers the 1 s wait-claim grace period before automatic fallback, plus scheduling slack. */
const GRACE_TIMEOUT = { timeout: 5_000 };

/** One scripted root response; it may wait on the live session before answering. */
type RootStep = (session: AgentSession) => AssistantMessage | Promise<AssistantMessage>;

type ToolArguments = Parameters<typeof fauxToolCall>[1];

const toolCall =
  (name: string, args: ToolArguments, id: string): RootStep =>
  () =>
    fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
/** A tool call whose arguments are read from the live session when the model answers. */
const lateToolCall =
  (name: string, args: (session: AgentSession) => ToolArguments, id: string): RootStep =>
  (session) =>
    toolCall(name, args(session), id)(session);
const reply =
  (text: string): RootStep =>
  () =>
    fauxAssistantMessage(text);
/** Keep the root turn running until automatic fallback has steered a result into Pi's queue. */
const afterResultQueued =
  (step: RootStep): RootStep =>
  async (session) => {
    await vi.waitFor(() => expect(session.agent.hasQueuedMessages()).toBe(true), GRACE_TIMEOUT);
    return step(session);
  };

/** The model-visible text and the details of one root tool result. */
function toolResult(session: AgentSession, toolCallId: string) {
  for (const entry of session.sessionManager.getBranch()) {
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === toolCallId
    ) {
      return { text: JSON.stringify(entry.message.content), details: entry.message.details };
    }
  }
  throw new Error(`Expected a tool result for ${toolCallId}`);
}

const TurnIdDetailsSchema = Type.Object({ turn_id: Type.String() });

/** The turn ID one `subagent` or `agent_message` tool result reported. */
function reportedTurnId(session: AgentSession, toolCallId: string): string {
  return Value.Parse(TurnIdDetailsSchema, toolResult(session, toolCallId).details).turn_id;
}

/** The turn ID `subagent` reported for the spawn call `spawn`. */
function spawnedTurnId(session: AgentSession): string {
  return reportedTurnId(session, "spawn");
}

/** One live root Pi session with the extension's registered tools and a scripted model. */
async function startScriptedRoot(steps: RootStep[]) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-subagents-handed-"));
  directories.push(cwd);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "pi-minimal-subagents-handed-result-test",
        factory: createMinimalSubagentsExtension({
          getAgentDirectory: () => cwd,
          createSessionFactory: () => new RecordingAgentSessionFactory(),
        }),
      },
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(cwd, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model: getModel("anthropic", "claude-sonnet-4-5"),
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, await mkdtemp(join(cwd, "sessions-"))),
    settingsManager,
    noTools: "builtin",
  });
  sessions.push(session);

  /** The serialized context of every answered model request, in order. */
  const requests: string[] = [];
  session.agent.streamFunction = (currentModel, context, options) => {
    const stream = createAssistantMessageEventStream();
    const respond = (message: AssistantMessage): AssistantMessage => ({
      ...message,
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    });
    if (options?.signal?.aborted) {
      queueMicrotask(() =>
        stream.push({
          type: "error",
          reason: "aborted",
          error: respond(fauxAssistantMessage("", { stopReason: "aborted" })),
        }),
      );
      return stream;
    }
    const step = steps[requests.length] ?? reply("Done.");
    requests.push(JSON.stringify(context.messages));
    void Promise.resolve(step(session)).then((message) =>
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message: respond(message),
      }),
    );
    return stream;
  };
  await session.bindExtensions({
    mode: "rpc",
    uiContext: session.extensionRunner.getUIContext(),
  });

  return {
    session,
    requests,
    resultEntries: () =>
      session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "minimal-subagents.result",
        ),
    pendingDeliveries: () =>
      replayRegistryEntries(
        session.sessionManager.getBranch(),
        session.sessionManager.getSessionId(),
      ).deliveries,
    toolResult: (toolCallId: string) => toolResult(session, toolCallId),
  };
}

/** Assert one wait reported its result as already delivered, without repeating the output. */
function expectAlreadyDelivered(
  wait: ReturnType<typeof toolResult>,
  turnId: string,
  output: string,
): void {
  expect(wait.text).not.toContain(output);
  expect(wait.text).toContain("already delivered automatically");
  expect(wait.text).toContain(turnId);
  expect(wait.details).toEqual({
    event: "turn",
    agent_id: "worker",
    turn_id: turnId,
    status: "completed",
    already_delivered: true,
    source_agent_id: "worker",
    source_turn_id: turnId,
  });
}

test("a default wait does not repeat a spawned result automatic fallback already handed", async () => {
  const { session, resultEntries, toolResult } = await startScriptedRoot([
    toolCall("subagent", { task: "Report back", agent_id: "worker" }, "spawn"),
    // The root keeps working; the child's result is steered into Pi's queue before it waits.
    afterResultQueued(toolCall("subagent_wait", { agent_id: "worker" }, "wait")),
  ]);

  await session.prompt("Spawn a worker");
  await session.waitForIdle();

  expect(resultEntries()).toHaveLength(1);
  expectAlreadyDelivered(toolResult("wait"), spawnedTurnId(session), SPAWN_OUTPUT);
});

test("a default wait does not repeat a started-turn result automatic fallback already handed", async () => {
  const { session, resultEntries, toolResult } = await startScriptedRoot([
    toolCall("subagent", { task: "Report back", agent_id: "worker" }, "spawn"),
    reply("Spawned."),
    // The idle root takes the first result as a new turn.
    reply("Noted."),
    toolCall("agent_message", { agent_id: "worker", message: "Continue" }, "continue"),
    afterResultQueued(toolCall("subagent_wait", { agent_id: "worker" }, "wait")),
  ]);

  await session.prompt("Spawn a worker");
  await vi.waitFor(() => expect(resultEntries()).toHaveLength(1), GRACE_TIMEOUT);
  await session.waitForIdle();
  await session.prompt("Continue the worker");
  await session.waitForIdle();

  expect(resultEntries()).toHaveLength(2);
  expectAlreadyDelivered(toolResult("wait"), reportedTurnId(session, "continue"), MESSAGE_OUTPUT);
});

test("a default wait does not repeat a result automatic fallback already delivered", async () => {
  const { session, resultEntries, pendingDeliveries, toolResult } = await startScriptedRoot([
    toolCall("subagent", { task: "Report back", agent_id: "worker" }, "spawn"),
    reply("Spawned."),
    // The idle root takes the result as a new turn.
    reply("Noted."),
    // A later tool result reconciles the result's Delivery Evidence and settles it.
    toolCall("subagent_status", { agent_id: "worker" }, "status"),
    reply("Checked."),
    toolCall("subagent_wait", { agent_id: "worker" }, "wait"),
  ]);

  await session.prompt("Spawn a worker");
  await vi.waitFor(() => expect(resultEntries()).toHaveLength(1), GRACE_TIMEOUT);
  await session.waitForIdle();
  await session.prompt("Check the worker");
  await session.waitForIdle();
  expect(pendingDeliveries()).toEqual([]);
  await session.prompt("Wait for the worker");
  await session.waitForIdle();

  expect(resultEntries()).toHaveLength(1);
  expectAlreadyDelivered(toolResult("wait"), spawnedTurnId(session), SPAWN_OUTPUT);
});

test("an explicit turn_id rereads a result automatic fallback already handed", async () => {
  const { session, toolResult } = await startScriptedRoot([
    toolCall("subagent", { task: "Report back", agent_id: "worker" }, "spawn"),
    afterResultQueued(toolCall("subagent_wait", { agent_id: "worker" }, "wait")),
    lateToolCall(
      "subagent_wait",
      (current) => ({ agent_id: "worker", turn_id: spawnedTurnId(current) }),
      "reread",
    ),
  ]);

  await session.prompt("Spawn a worker");
  await session.waitForIdle();

  expectAlreadyDelivered(toolResult("wait"), spawnedTurnId(session), SPAWN_OUTPUT);
  const reread = toolResult("reread");
  expect(reread.text).toContain(SPAWN_OUTPUT);
  expect(reread.details).toMatchObject({
    event: "turn",
    turn_id: spawnedTurnId(session),
    status: "completed",
    output: SPAWN_OUTPUT,
  });
  expect(reread.details).not.toHaveProperty("already_delivered");
});

test("an already-delivered wait is not Delivery Evidence, so a result Esc discards is recovered", async () => {
  const { session, requests, resultEntries, pendingDeliveries, toolResult } =
    await startScriptedRoot([
      toolCall("subagent", { task: "Report back", agent_id: "worker" }, "spawn"),
      afterResultQueued(toolCall("subagent_wait", { agent_id: "worker" }, "wait")),
      // The root's next run: it receives the recovered result, so a default wait does not repeat it.
      toolCall("subagent_wait", { agent_id: "worker" }, "rewait"),
    ]);
  // Pi's Esc lands right after the wait returns, before Pi takes the queued result steer.
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolCallId === "wait") {
      session.clearQueue();
      void session.abort();
    }
  });

  await session.prompt("Spawn a worker");
  await session.waitForIdle();
  unsubscribe();
  expectAlreadyDelivered(toolResult("wait"), spawnedTurnId(session), SPAWN_OUTPUT);
  expect(requests).toHaveLength(2);
  expect(resultEntries()).toHaveLength(0);
  // The wait's own tool result did not settle the discarded result.
  expect(pendingDeliveries()).toEqual([
    expect.objectContaining({ source_agent_id: "worker", source_turn_id: spawnedTurnId(session) }),
  ]);

  await session.prompt("next");
  await session.waitForIdle();

  expect(requests[2]).toContain(SPAWN_OUTPUT);
  expect(resultEntries()).toHaveLength(1);
  expectAlreadyDelivered(toolResult("rewait"), spawnedTurnId(session), SPAWN_OUTPUT);
  await vi.waitFor(() => expect(pendingDeliveries()).toEqual([]), GRACE_TIMEOUT);
});
