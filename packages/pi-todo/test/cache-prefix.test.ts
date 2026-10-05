/**
 * Cache proof: real Pi sessions run offline with only the model stream scripted. Each captured
 * request holds the ordered messages exactly as Pi hands them to the provider, so a later
 * request must begin with the byte-identical serialized history of the earlier one, and one tool
 * group must contribute exactly one labelled Todo List snapshot.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import piTodoExtension from "../src/index.js";

const SNAPSHOT_HEADER = "Todo List state from the pi-todo extension (not a user message):";

interface CapturedRequest {
  readonly isFirstRequest: boolean;
  readonly systemPrompt: string;
  readonly tools: string;
  readonly messages: Message[];
}

interface Fixture {
  readonly session: AgentSession;
  readonly requests: CapturedRequest[];
  readonly responses: AssistantMessage[];
}

const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-todo-sdk-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    codemode: { mode: "on" },
    defaultTools: ["read", "bash", "edit", "write", "codemode"],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createCodemodeExtension(), piTodoExtension],
    systemPromptOverride: () => "Standing instructions: answer with the shortest correct turn.",
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length > 0) throw new Error(`extension load failed: ${JSON.stringify(errors)}`);

  const model = getModel("anthropic", "claude-sonnet-4-5");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(cwd, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "TEST-NOT-A-REAL-KEY");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
    settingsManager,
  });
  sessions.push(session);

  const requests: CapturedRequest[] = [];
  const responses: AssistantMessage[] = [];
  session.agent.streamFunction = (currentModel, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    requests.push({
      isFirstRequest: requests.length === 0,
      systemPrompt: getCurrentSystemPrompt(context.messages),
      tools: JSON.stringify(getCurrentTools(context.messages)),
      messages: structuredClone(context.messages),
    });
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
  await session.bindExtensions({ mode: "rpc" });
  return { session, requests, responses };
}

function toolCalls(...calls: Array<ReturnType<typeof fauxToolCall>>): AssistantMessage {
  return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

/** Text of a hidden snapshot after Pi converts it to a provider-facing user message. */
function messageText(message: Message | undefined): string {
  return message?.role === "user" && Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : "";
}

function snapshotIndexes(messages: readonly Message[]): number[] {
  return messages.flatMap((message, index) =>
    message.role === "user" && messageText(message).startsWith(SNAPSHOT_HEADER) ? [index] : [],
  );
}

/**
 * The earlier request's ordered messages begin the later request, byte for byte. The one exception
 * is the leading system message when `earlier` is the session's first request: Pi serializes it
 * again afterwards with the same value but a different key order, so that pair is compared
 * structurally.
 */
function expectByteIdenticalPrefix(earlier: CapturedRequest, later: CapturedRequest): void {
  const first = earlier.messages[0];
  const comparedFrom = first !== undefined && earlier.isFirstRequest ? 1 : 0;
  if (comparedFrom === 1) expect(later.messages[0]).toEqual(first);
  expect(JSON.stringify(later.messages.slice(comparedFrom, earlier.messages.length))).toBe(
    JSON.stringify(earlier.messages.slice(comparedFrom)),
  );
  expect(later.systemPrompt).toBe(earlier.systemPrompt);
  expect(later.tools).toBe(earlier.tools);
}

describe("one Todo List snapshot per tool group", () => {
  test("a codemode script with several todo calls projects one labelled snapshot after its result", async () => {
    const { session, requests, responses } = await createFixture();
    responses.push(
      toolCalls(
        fauxToolCall("codemode", {
          code: [
            'await tools.todo({ action: "add", title: "Write tests" });',
            'await tools.todo({ action: "add", title: "Ship it" });',
            'await tools.todo({ action: "update", id: 1, status: "active" });',
            'await tools.todo({ action: "update", id: 1, status: "completed" });',
            'await tools.todo({ action: "update", id: 2, status: "active" });',
            "return 5;",
          ].join("\n"),
        }),
      ),
      fauxAssistantMessage("Script done."),
    );
    await session.prompt("Plan the work");
    expect(requests).toHaveLength(2);
    const messages = requests[1]!.messages;
    const indexes = snapshotIndexes(messages);
    expect(indexes).toHaveLength(1);
    const snapshot = messages[indexes[0]!];
    expect(messageText(snapshot)).toBe(`${SNAPSHOT_HEADER}\n[x] #1 Write tests\n[>] #2 Ship it`);
    expect(messages[indexes[0]! - 1]).toMatchObject({ role: "toolResult", toolName: "codemode" });
    expect(indexes[0]).toBe(messages.length - 1);
  }, 30_000);

  test("earlier projected messages stay byte-identical across later requests and groups", async () => {
    const { session, requests, responses } = await createFixture();
    responses.push(
      toolCalls(
        fauxToolCall("codemode", {
          code: 'await tools.todo({ action: "add", title: "First" }); await tools.todo({ action: "add", title: "Second" }); return "ok";',
        }),
      ),
      fauxAssistantMessage("Planned."),
      // A routine "complete #1, start #2" group of direct calls, separate from the script.
      toolCalls(
        fauxToolCall("todo", { action: "update", id: 1, status: "completed" }, { id: "direct-1" }),
        fauxToolCall("todo", { action: "update", id: 2, status: "active" }, { id: "direct-2" }),
      ),
      fauxAssistantMessage("Advanced."),
      fauxAssistantMessage("Unchanged."),
    );
    await session.prompt("Plan");
    await session.prompt("Advance");
    await session.prompt("Anything else?");
    expect(requests).toHaveLength(5);

    const snapshotsOf = (request: CapturedRequest) =>
      snapshotIndexes(request.messages).map((index) => messageText(request.messages[index]));
    expect(snapshotsOf(requests[1]!)).toEqual([`${SNAPSHOT_HEADER}\n[ ] #1 First\n[ ] #2 Second`]);
    // The later request keeps the first group's snapshot and adds exactly one for the second group.
    expect(snapshotsOf(requests[3]!)).toEqual([
      `${SNAPSHOT_HEADER}\n[ ] #1 First\n[ ] #2 Second`,
      `${SNAPSHOT_HEADER}\n[x] #1 First\n[>] #2 Second`,
    ]);
    expect(snapshotsOf(requests[4]!)).toEqual(snapshotsOf(requests[3]!));

    for (let index = 1; index < requests.length; index++)
      expectByteIdenticalPrefix(requests[index - 1]!, requests[index]!);
  }, 30_000);
});
