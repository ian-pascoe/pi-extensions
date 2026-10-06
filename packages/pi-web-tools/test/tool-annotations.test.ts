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
import piWebToolsExtension from "../src/index.js";
import { selectSearchProvider } from "../src/web-search.js";

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
    extensionFactories: [{ name: "pi-web-tools-annotations-test", factory }],
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
  return { reported: session.getAllTools(), sessionId: session.sessionId, ...captured };
}

test("reports explicit read-only, open-world annotations without changing the provider prefix", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-tools-annotations-"));
  directories.push(cwd);
  const annotated = await captureTurn(piWebToolsExtension, cwd);
  const plain = await captureTurn(withoutAnnotations(piWebToolsExtension), cwd);

  const hints = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  expect(
    annotated.reported
      .filter(({ name }) => name === "web_search" || name === "web_fetch")
      .map(({ name, annotations }) => ({ name, annotations })),
  ).toEqual([
    { name: "web_search", annotations: hints },
    { name: "web_fetch", annotations: hints },
  ]);
  // The comparison is meaningful only if the baseline really lacks the hints.
  expect(
    plain.reported
      .filter(({ name }) => name === "web_search" || name === "web_fetch")
      .map(({ annotations }) => annotations),
  ).toEqual([undefined, undefined]);

  // Annotations are Pi-local: ordered tool definitions, system prompt, and history are identical.
  expect(JSON.stringify(annotated.tools)).toContain("web_search");
  expect(annotated.tools).toEqual(plain.tools);
  expect(JSON.stringify(annotated.tools)).not.toContain("Hint");
  expect(annotated.systemPrompt).toBe(plain.systemPrompt);
  expect(withoutTimestamps(annotated.messages)).toEqual(withoutTimestamps(plain.messages));
});

test("keeps ordered tool definitions, prompt, and history stable across sessions for both Search Providers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-tools-budgets-"));
  directories.push(cwd);
  // Pi picks the provider from the session id, so a handful of fresh sessions spans both.
  const turns = [];
  for (let run = 0; run < 6; run++) turns.push(await captureTurn(piWebToolsExtension, cwd));
  const providers = new Set(turns.map(({ sessionId }) => selectSearchProvider(sessionId)));
  expect(providers).toEqual(new Set(["exa", "parallel"]));
  const [first, ...rest] = turns;
  if (first === undefined) throw new Error("Expected a captured turn");

  const definitions = first.tools;
  if (!Array.isArray(definitions)) throw new Error("Expected an ordered tool list");
  const web = definitions.filter(
    (tool): tool is { name: string; description: string; parameters: unknown } =>
      tool?.name === "web_search" || tool?.name === "web_fetch",
  );
  expect(web.map(({ name }) => name)).toEqual(["web_search", "web_fetch"]);
  const serialized = JSON.stringify(web);
  // The output budgets are part of the static definitions the model is given.
  expect(serialized).toContain("default: 6,000");
  expect(serialized).toContain('"offset"');
  expect(serialized).toContain('"limit"');
  expect(serialized).toContain("1-indexed");
  for (const turn of rest) {
    expect(turn.tools).toEqual(first.tools);
    expect(turn.systemPrompt).toBe(first.systemPrompt);
    expect(withoutTimestamps(turn.messages)).toEqual(withoutTimestamps(first.messages));
  }
});
