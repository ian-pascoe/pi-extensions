/**
 * Cache proof: real Pi sessions run offline with only the model stream scripted. Converting an
 * Issue Reference rewrites the user message it is typed in, so the ordered tool definitions and the
 * system prompt must stay byte-identical between a turn without and a turn with a reference, and
 * each later request must begin with the byte-identical serialized history of the earlier one.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
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
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import issuesSelectorExtension from "../src/index.js";

interface CapturedRequest {
  readonly systemPrompt: string;
  readonly tools: string;
  readonly messages: Message[];
}

interface Fixture {
  readonly session: AgentSession;
  readonly requests: CapturedRequest[];
  readonly responses: AssistantMessage[];
}

const run = promisify(execFile);
const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture({ defaultSystemPrompt = false } = {}): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-issues-selector-sdk-"));
  directories.push(cwd);
  // A real checkout, so the extension reads the Issue Repository the way it does in Pi.
  await run("git", ["init", "-q"], { cwd });
  await run("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd });
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
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
    extensionFactories: [issuesSelectorExtension],
    systemPromptOverride: (base) =>
      defaultSystemPrompt ? base : "Standing instructions: answer with the shortest correct turn.",
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

function userTexts(request: CapturedRequest): string[] {
  return request.messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const parts = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    return [parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
  });
}

/**
 * The earlier request's ordered messages begin the later request, byte for byte. The one exception
 * is the leading system message: Pi re-serializes it with the same value but a different key order
 * the first time it rebuilds the context after a persisted turn, so it is compared structurally.
 */
function expectByteIdenticalPrefix(earlier: CapturedRequest, later: CapturedRequest): void {
  const first = earlier.messages[0];
  const comparedFrom = first?.role === "system" ? 1 : 0;
  if (comparedFrom === 1) expect(later.messages[0]).toEqual(first);
  expect(JSON.stringify(later.messages.slice(comparedFrom, earlier.messages.length))).toBe(
    JSON.stringify(earlier.messages.slice(comparedFrom)),
  );
  expect(later.systemPrompt).toBe(earlier.systemPrompt);
  expect(later.tools).toBe(earlier.tools);
}

describe.each([
  ["a fixed system prompt", false],
  ["Pi's default system prompt", true],
])("Issue References under %s", (_name, defaultSystemPrompt) => {
  test("a turn with references keeps the tool definitions, system prompt, and earlier history byte-identical", async () => {
    const { session, requests, responses } = await createFixture({ defaultSystemPrompt });
    responses.push(
      fauxAssistantMessage("Hello."),
      fauxAssistantMessage("Looked."),
      fauxAssistantMessage("Still here."),
    );
    await session.prompt("Hello there");
    await session.prompt("Please fix #12 and compare with acme/other#3.");
    await session.prompt("Anything else?");
    expect(requests).toHaveLength(3);

    expect(userTexts(requests[1]!)).toEqual([
      "Hello there",
      "Please fix [#12](https://github.com/acme/widgets/issues/12) and compare with [acme/other#3](https://github.com/acme/other/issues/3).",
    ]);
    expect(requests[1]!.messages.length).toBeGreaterThan(requests[0]!.messages.length);
    // The history only extends: the converted message is stored as sent, not rewritten later.
    expect(requests[2]!.messages.length).toBeGreaterThan(requests[1]!.messages.length);
    for (let index = 1; index < requests.length; index++) {
      expectByteIdenticalPrefix(requests[index - 1]!, requests[index]!);
    }
    expect(requests[0]!.tools).toBe(requests[2]!.tools);
    expect(requests[0]!.systemPrompt).toBe(requests[2]!.systemPrompt);
  }, 30_000);

  test("literal text sends the user message untouched", async () => {
    const { session, requests, responses } = await createFixture({ defaultSystemPrompt });
    responses.push(fauxAssistantMessage("Ok."), fauxAssistantMessage("Ok."));
    await session.prompt("Look at `#12` and issue#13");
    await session.prompt("Again");
    expect(userTexts(requests[1]!)[0]).toBe("Look at `#12` and issue#13");
    expectByteIdenticalPrefix(requests[0]!, requests[1]!);
  }, 30_000);
});
