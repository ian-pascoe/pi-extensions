import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
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
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { createMinimalSubagentsExtension } from "../src/minimal-subagents-extension.js";
import { PiAgentSessionFactory } from "../src/minimal-subagents-sessions.js";

const directories: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Register the same tools without `annotations`, as an unannotated build of the extension would. */
function withoutAnnotations(factory: ExtensionFactory): ExtensionFactory {
  return (pi) => {
    const unannotated: ExtensionAPI = Object.create(pi);
    Object.defineProperty(unannotated, "registerTool", {
      value: (tool: ToolDefinition) => {
        const { annotations: _omitted, ...rest } = tool;
        pi.registerTool(rest);
      },
    });
    return factory(unannotated);
  };
}

/** Message timestamps are wall-clock noise between two otherwise identical runs. */
function withoutTimestamps(messages: readonly Message[]): readonly Message[] {
  return JSON.parse(
    JSON.stringify(messages, (key, value) => (key === "timestamp" ? undefined : value)),
  );
}

/** One real offline Pi turn: tools, system prompt, and transcript exactly as handed to the model. */
async function captureTurn(factory: ExtensionFactory, cwd: string) {
  // The system prompt embeds the cwd, so both runs share one; only the session directory differs.
  const sessionDirectory = await mkdtemp(join(cwd, "sessions-"));
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
    extensionFactories: [{ name: "pi-minimal-subagents-annotations-test", factory }],
    systemPromptOverride: () => "Standing instructions: answer with the shortest correct turn.",
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
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
    agentDir: cwd,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, sessionDirectory),
    settingsManager,
    noTools: "builtin",
  });
  sessions.push(session);
  let captured: { tools: unknown; systemPrompt: string; messages: Message[] } | undefined;
  session.agent.streamFunction = (currentModel, context) => {
    captured = {
      tools: structuredClone(getCurrentTools(context.messages)),
      systemPrompt: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages),
    };
    const message = {
      ...fauxAssistantMessage("Done."),
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  await session.prompt("Hello");
  if (captured === undefined) throw new Error("No model request was captured");
  return { reported: session.getAllTools(), ...captured };
}

const COORDINATOR_TOOLS = [
  "subagent",
  "agent_message",
  "subagent_wait",
  "subagent_status",
  "subagent_cancel",
  "subagent_delete",
];

function extension(agentDirectory: string): ExtensionFactory {
  return createMinimalSubagentsExtension({
    getAgentDirectory: () => agentDirectory,
    createSessionFactory: (options) => new PiAgentSessionFactory(options),
  });
}

const hints = (
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

test("reports explicit annotations without changing the provider prefix", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-subagents-annotations-"));
  directories.push(cwd);
  const annotated = await captureTurn(extension(cwd), cwd);
  const plain = await captureTurn(withoutAnnotations(extension(cwd)), cwd);

  const coordinator = (turn: typeof annotated) =>
    turn.reported
      .filter(({ name }) => COORDINATOR_TOOLS.includes(name))
      .map(({ name, annotations }) => ({ name, annotations }));
  expect(coordinator(annotated)).toEqual([
    // A Child Agent can use any tool it is granted, so spawning is as powerful as its grant.
    { name: "subagent", annotations: hints(false, true, false, true) },
    { name: "agent_message", annotations: hints(false, false, false, false) },
    { name: "subagent_wait", annotations: hints(true, false, false, false) },
    { name: "subagent_status", annotations: hints(true, false, true, false) },
    { name: "subagent_cancel", annotations: hints(false, false, true, false) },
    { name: "subagent_delete", annotations: hints(false, true, true, false) },
  ]);
  // The comparison is meaningful only if the baseline really lacks the hints.
  expect(coordinator(plain)).toEqual(
    COORDINATOR_TOOLS.map((name) => ({ name, annotations: undefined })),
  );

  // Annotations are Pi-local: ordered tool definitions, system prompt, and history are identical.
  expect(JSON.stringify(annotated.tools)).toContain("subagent_delete");
  expect(annotated.tools).toEqual(plain.tools);
  expect(JSON.stringify(annotated.tools)).not.toContain("Hint");
  expect(annotated.systemPrompt).toBe(plain.systemPrompt);
  expect(withoutTimestamps(annotated.messages)).toEqual(withoutTimestamps(plain.messages));
});
