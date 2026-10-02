import { afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import "./observer-extension.js";
import "./review-regression-extension.js";

/** Scripted provider response, held until `gate` settles and aborted with its request. */
export function response(
  model: Model<Api>,
  answer: AssistantMessage,
  options?: SimpleStreamOptions,
  gate: Promise<void> = Promise.resolve(),
) {
  const stream = createAssistantMessageEventStream();
  let finished = false;
  const publish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    options?.signal?.removeEventListener("abort", abort);
    const message = { ...answer, provider: model.provider, model: model.id, api: model.api };
    if (aborted)
      stream.push({
        type: "error",
        reason: "aborted",
        error: { ...message, stopReason: "aborted" },
      });
    else
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
  };
  const abort = () => publish(true);
  if (options?.signal?.aborted) abort();
  else options?.signal?.addEventListener("abort", abort, { once: true });
  void gate.then(() => publish(false));
  return stream;
}

/** Offline observed runtime with the Advisor loaded; `ui` overrides interactive UI methods. */
export async function fixture({
  enabled = true,
  interactive = false,
  ui = {},
}: { enabled?: boolean; interactive?: boolean; ui?: Partial<ExtensionUIContext> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "advisor-runtime-"));
  const cleanupGates: Array<() => void> = [];
  globalThis.advisorReviewRegression = {};
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const document = {
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
    advisor: { enabled, catchUpThreshold: "off" },
  };
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    modelRuntime: models,
    settingsManager: SettingsManager.inMemory(document),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./observer-extension.ts", import.meta.url)),
        fileURLToPath(new URL("./review-regression-extension.ts", import.meta.url)),
        fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
      ],
    },
  });
  const model = models.getModel("observer-fixture", "model");
  if (!model) throw new Error("Missing offline fixture model");
  const created = await createAgentSessionFromServices({
    services,
    model,
    thinkingLevel: "low",
    sessionManager: SessionManager.create(directory, join(directory, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("Fixture does not replace sessions");
  });
  afterEach(async () => {
    for (const release of cleanupGates) release();
    await runtime.session.abort();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const session = runtime.session;
  await session.bindExtensions(
    interactive
      ? { mode: "rpc", uiContext: { ...session.extensionRunner!.getUIContext(), ...ui } }
      : { mode: "print" },
  );
  return { session, cleanupGates };
}
