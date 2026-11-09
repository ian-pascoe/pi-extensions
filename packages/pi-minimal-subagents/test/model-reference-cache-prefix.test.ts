import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
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
import { afterEach, expect, test } from "vitest";
import { createMinimalSubagentsExtension } from "../src/minimal-subagents-extension.js";
import { PiAgentSessionFactory } from "../src/minimal-subagents-sessions.js";

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

interface ProviderRequest {
  readonly tools: string;
  readonly systemPrompt: string;
  readonly messages: AgentMessage[];
}

const MODEL = "anthropic/claude-sonnet-4-5";

/** One live Pi session whose every model request is captured as the provider receives it. */
async function startSession(): Promise<{ session: AgentSession; requests: ProviderRequest[] }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-subagents-model-reference-cache-"));
  directories.push(cwd);
  await writeFile(
    join(cwd, "settings.json"),
    JSON.stringify({ minimalSubagents: { modelRoles: { large: `${MODEL}:high` } } }),
  );
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
        name: "pi-minimal-subagents-model-reference-cache-test",
        factory: createMinimalSubagentsExtension({
          getAgentDirectory: () => cwd,
          createSessionFactory: (options) => new PiAgentSessionFactory(options),
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
  const requests: ProviderRequest[] = [];
  session.agent.streamFunction = (currentModel, context) => {
    requests.push({
      // The ordered tool definitions and history exactly as serialized for the provider.
      tools: JSON.stringify(getCurrentTools(context.messages)),
      systemPrompt: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages),
    });
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
  await session.bindExtensions({ mode: "rpc", uiContext: session.extensionRunner.getUIContext() });
  return { session, requests };
}

function userTexts(request: ProviderRequest): string[] {
  return request.messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const parts = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    return [parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
  });
}

/**
 * The earlier request's ordered messages begin the later request, byte for byte, apart from a
 * leading system message, which Pi may re-serialize with another key order; its value must match.
 */
function expectByteIdenticalPrefix(earlier: ProviderRequest, later: ProviderRequest): void {
  const first = earlier.messages[0];
  const comparedFrom = first?.role === "system" ? 1 : 0;
  if (comparedFrom === 1) expect(later.messages[0]).toEqual(first);
  expect(JSON.stringify(later.messages.slice(comparedFrom, earlier.messages.length))).toBe(
    JSON.stringify(earlier.messages.slice(comparedFrom)),
  );
  expect(later.systemPrompt).toBe(earlier.systemPrompt);
  expect(later.tools).toBe(earlier.tools);
}

test("a turn with Subagent Model References keeps tools, system prompt, and history byte-identical", async () => {
  const { session, requests } = await startSession();
  await session.prompt("Hello there");
  await session.prompt(`Plan with %large, then review with %${MODEL}:low.`);
  await session.prompt("Anything else?");
  expect(requests).toHaveLength(3);

  expect(userTexts(requests[1]!)).toEqual([
    "Hello there",
    `Plan with [%large](model-role://large "Subagent model role: role=large"), then review with [%${MODEL}:low](model://${MODEL} "Subagent model: model=${MODEL}, thinking_level=low").`,
  ]);
  expect(requests[2]!.messages.length).toBeGreaterThan(requests[1]!.messages.length);
  for (let index = 1; index < requests.length; index++) {
    expectByteIdenticalPrefix(requests[index - 1]!, requests[index]!);
  }
}, 30_000);
