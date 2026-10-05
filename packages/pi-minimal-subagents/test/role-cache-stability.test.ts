import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface ProviderRequest {
  readonly tools: string;
  readonly systemPrompt: string;
}

/** One live Pi session whose every model request is captured as the provider receives it. */
async function startSession(cwd: string) {
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
        name: "pi-minimal-subagents-role-cache-test",
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
  let captured: ProviderRequest | undefined;
  session.agent.streamFunction = (currentModel, context) => {
    captured = {
      // The ordered tool definitions exactly as serialized for the provider.
      tools: JSON.stringify(getCurrentTools(context.messages)),
      systemPrompt: getCurrentSystemPrompt(context.messages),
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
  await session.bindExtensions({
    mode: "rpc",
    uiContext: session.extensionRunner.getUIContext(),
  });
  return {
    session,
    request: async (prompt: string): Promise<ProviderRequest> => {
      captured = undefined;
      await session.prompt(prompt);
      if (captured === undefined) throw new Error("No model request was captured");
      return captured;
    },
  };
}

const MODEL = "anthropic/claude-sonnet-4-5";

type ModelRolesSetting = Record<string, string | { model: string; hint: string }>;

test("keeps the provider's tools and system prompt byte-equal when modelRoles change mid-session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-subagents-role-cache-"));
  directories.push(cwd);
  const writeRoles = (modelRoles: ModelRolesSetting) =>
    writeFile(join(cwd, "settings.json"), JSON.stringify({ minimalSubagents: { modelRoles } }));
  await writeRoles({ explore: `${MODEL}:low`, plan: { model: MODEL, hint: "Design work" } });
  const { request } = await startSession(cwd);

  const first = await request("First");
  expect(first.tools).toContain('"role"');
  expect(first.systemPrompt).toContain(`explore → model=${MODEL}, thinking_level=low`);

  await writeRoles({ review: `${MODEL}:high` });
  const second = await request("Second");

  expect(second.tools).toBe(first.tools);
  expect(second.systemPrompt).toBe(first.systemPrompt);
});

test("keeps the provider's ordered tools byte-equal across a reload that changes modelRoles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-minimal-subagents-role-reload-"));
  directories.push(cwd);
  const writeRoles = (modelRoles: ModelRolesSetting) =>
    writeFile(join(cwd, "settings.json"), JSON.stringify({ minimalSubagents: { modelRoles } }));
  await writeRoles({ explore: `${MODEL}:low`, plan: { model: MODEL, hint: "Design work" } });
  const { session, request } = await startSession(cwd);
  const before = await request("First");

  await writeRoles({ review: `${MODEL}:high` });
  await session.reload();
  const after = await request("Second");

  expect(after.tools).toBe(before.tools);
  expect(after.systemPrompt).not.toBe(before.systemPrompt);
  const roleLine = /→ model=/;
  const lines = (prompt: string) => prompt.split("\n");
  const changed = [
    ...lines(before.systemPrompt).filter((line) => !lines(after.systemPrompt).includes(line)),
    ...lines(after.systemPrompt).filter((line) => !lines(before.systemPrompt).includes(line)),
  ];
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every((line) => roleLine.test(line))).toBe(true);
  expect(after.systemPrompt).toContain(`review → model=${MODEL}, thinking_level=high`);
  expect(after.systemPrompt).not.toContain("explore → model=");
});
