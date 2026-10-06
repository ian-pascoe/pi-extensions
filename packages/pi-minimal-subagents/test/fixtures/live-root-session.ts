// Live root Pi sessions: the extension's registered tools and root delivery, with Recording
// children and a test-supplied model, all offline.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import { expect } from "vitest";
import { createMinimalSubagentsExtension } from "../../src/minimal-subagents-extension.js";
import { replayRegistryEntries } from "../../src/minimal-subagents-registry.js";
import { RecordingAgentSessionFactory } from "./recording-sessions.js";

/** Answers every root model request; Pi passes the requesting model, context, and options. */
export type RootStreamFunction = AgentSession["agent"]["streamFunction"];

const directories: string[] = [];
const sessions: AgentSession[] = [];

/**
 * Start one live root session whose model requests `createStreamFunction` answers. The stream
 * function is installed before the extension binds, so it may read the session it answers.
 */
export async function startLiveRootSession(
  name: string,
  createStreamFunction: (session: AgentSession) => RootStreamFunction,
): Promise<AgentSession> {
  const cwd = await mkdtemp(join(tmpdir(), `pi-minimal-subagents-${name}-`));
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
        name: `pi-minimal-subagents-${name}-test`,
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
  session.agent.streamFunction = createStreamFunction(session);
  await session.bindExtensions({
    mode: "rpc",
    uiContext: session.extensionRunner.getUIContext(),
  });
  return session;
}

/** Shut down every live root session started so far and remove its directory. */
export async function disposeLiveRootSessions(): Promise<void> {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

/** Stamp a scripted assistant message with the requesting model's API, provider, and ID. */
export function asModelResponse(
  model: Parameters<RootStreamFunction>[0],
  message: AssistantMessage,
): AssistantMessage {
  return { ...message, api: model.api, provider: model.provider, model: model.id };
}

/** The automatic result messages on the root session's selected branch. */
export function rootResultEntries(session: AgentSession) {
  return session.sessionManager
    .getBranch()
    .filter(
      (entry) => entry.type === "custom_message" && entry.customType === "minimal-subagents.result",
    );
}

/** The terminal Delivery Ledger items still pending on the root session's selected branch. */
export function pendingRootDeliveries(session: AgentSession) {
  return replayRegistryEntries(
    session.sessionManager.getBranch(),
    session.sessionManager.getSessionId(),
  ).deliveries;
}
