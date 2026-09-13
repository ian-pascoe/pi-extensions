import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  DefaultResourceLoader,
  getPackageDir,
  createAgentSessionFromServices,
  AgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAdvisorSession,
  disposeAdvisorSession,
  isAdvisorSession,
} from "../src/advisor-session.js";
import { readAdvisorSettings } from "../src/advisor-settings.js";

const fixture = fileURLToPath(new URL("./fixtures/session-extension.ts", import.meta.url));
const adviceTool = defineTool({
  name: "advisor_report",
  label: "Advice",
  description: "Finish review",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "Done" }], details: {}, terminate: true };
  },
});

async function observedFixture(
  paths = [fixture],
  suppliedSettings?: SettingsManager,
  ownedLoader = false,
  suppliedRuntime?: ModelRuntime,
  extensionFactories: InlineExtension[] = [],
) {
  const dir = await mkdtemp(join(tmpdir(), "advisor-sdk-"));
  const settings =
    suppliedSettings ??
    SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
  const modelRuntime =
    suppliedRuntime ??
    (await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    }));
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: false,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
      additionalExtensionPaths: paths,
      extensionFactories,
    },
  });
  if (ownedLoader) {
    class FileSelectionLoader extends DefaultResourceLoader {}
    services.resourceLoader = new FileSelectionLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      additionalExtensionPaths: paths,
      extensionsOverride: (loaded) => ({
        ...loaded,
        extensions: loaded.extensions.filter(
          (extension) => !extension.path.endsWith("coordinator.ts"),
        ),
      }),
    });
    await services.resourceLoader.reload();
  }
  const model = modelRuntime.getModel("advisor-fixture", "reviewer");
  if (!model) throw new Error("Fixture provider did not load");
  services.resourceLoader.getExtensions().runtime.flagValues.set("fixture-enabled", false);
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("Fixture does not replace sessions");
  });
  await runtime.session.bindExtensions({ mode: "print" });
  afterEach(async () => {
    await runtime.session.abort();
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { observed: runtime.session, dir };
}

function entry(session: AgentSessionRuntime["session"], customType: string) {
  return session.sessionManager
    .getBranch()
    .findLast((item) => item.type === "custom" && item.customType === customType);
}

describe("private Advisor native sessions", () => {
  it("recreates the native inline llama extension with fresh handlers through private reload", async () => {
    const { default: factory } = await import(
      pathToFileURL(join(getPackageDir(), "dist", "extensions", "llama", "index.js")).href
    );
    const { observed, dir } = await observedFixture([fixture], undefined, false, undefined, [
      { name: "llama.cpp", hidden: true, factory },
    ]);
    vi.stubEnv("PI_PACKAGE_DIR", dir);
    try {
      await expect(
        createAdvisorSession(observed, {
          config: readAdvisorSettings(observed).settings,
          adviceTool,
        }),
      ).rejects.toThrow("Pi's built-in llama.cpp file is unavailable");
    } finally {
      vi.unstubAllEnvs();
    }
    const original = observed.resourceLoader.getExtensions().extensions.at(-1);
    const runtime = await createAdvisorSession(observed, {
      config: readAdvisorSettings(observed).settings,
      adviceTool,
    });
    afterEach(() => disposeAdvisorSession(runtime));
    const fresh = runtime.session.resourceLoader.getExtensions().extensions.at(-1);
    expect(fresh).toMatchObject({
      path: original?.path,
      resolvedPath: original?.resolvedPath,
      sourceInfo: original?.sourceInfo,
      hidden: true,
    });
    expect(fresh?.commands.get("llama")?.handler).not.toBe(
      original?.commands.get("llama")?.handler,
    );
    expect(runtime.session.modelRuntime.getRegisteredProviderIds()).toContain("llama.cpp");
    await runtime.session.reload();
    const reloaded = runtime.session.resourceLoader.getExtensions().extensions.at(-1);
    expect(reloaded).toMatchObject({
      path: original?.path,
      resolvedPath: original?.resolvedPath,
      sourceInfo: original?.sourceInfo,
      hidden: true,
    });
    expect(reloaded?.commands.get("llama")?.handler).not.toBe(
      fresh?.commands.get("llama")?.handler,
    );
    runtime.session.modelRuntime.unregisterProvider("llama.cpp");
    expect(observed.modelRuntime.getRegisteredProviderIds()).toContain("llama.cpp");
  });

  it.each(["custom", "llama.cpp"])(
    "rejects opaque inline resources named %s without replaying them",
    async (name) => {
      let calls = 0;
      const { observed } = await observedFixture([fixture], undefined, false, undefined, [
        {
          name,
          hidden: true,
          factory(pi) {
            calls++;
            pi.registerCommand("custom-inline", { async handler() {} });
          },
        },
      ]);
      await expect(
        createAdvisorSession(observed, {
          config: readAdvisorSettings(observed).settings,
          adviceTool,
        }),
      ).rejects.toThrow(`recreation inputs (<inline:${name}>)`);
      expect(calls).toBe(1);
    },
  );

  it("still rejects custom OAuth storage rather than copying its credentials", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("unused-offline-oauth", async () => ({
      type: "oauth",
      access: "offline-access",
      refresh: "offline-refresh",
      expires: 4102444800000,
    }));
    const models = await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const { observed } = await observedFixture([fixture], undefined, false, models);
    await expect(
      createAdvisorSession(observed, {
        config: readAdvisorSettings(observed).settings,
        adviceTool,
      }),
    ).rejects.toThrow("Unsupported Advisor custom OAuth storage");
  });

  it("reopens the actual native auth file rather than guessing or pinning a copied file credential", async () => {
    const authDir = await mkdtemp(join(tmpdir(), "advisor-auth-"));
    const authPath = join(authDir, "custom-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({ "advisor-fixture": { type: "api_key", key: "first-file-key" } }),
    );
    const models = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    afterEach(async () => {
      await rm(authDir, { recursive: true, force: true });
    });
    const { observed } = await observedFixture([fixture], undefined, false, models);
    const runtime = await createAdvisorSession(observed, {
      config: readAdvisorSettings(observed).settings,
      adviceTool,
    });
    afterEach(async () => {
      await disposeAdvisorSession(runtime);
    });
    await writeFile(
      authPath,
      JSON.stringify({ "advisor-fixture": { type: "api_key", key: "rotated-native-file-key" } }),
    );
    expect((await runtime.session.modelRuntime.getAuth("advisor-fixture"))?.auth.apiKey).toBe(
      "rotated-native-file-key",
    );
    expect((await observed.modelRuntime.getAuth("advisor-fixture"))?.auth.apiKey).toBe(
      "rotated-native-file-key",
    );
  });

  it("requires explicit owner recreation inputs for a custom file-selection loader", async () => {
    const { observed, dir } = await observedFixture([fixture], undefined, true);
    const config = readAdvisorSettings(observed).settings;
    await expect(createAdvisorSession(observed, { config, adviceTool })).rejects.toThrow(
      /owner-supplied/,
    );
    const resourceInputs = {
      agentDir: dir,
      extensions: observed.resourceLoader
        .getExtensions()
        .extensions.map(({ path, resolvedPath, sourceInfo, hidden }) => ({
          path,
          resolvedPath,
          sourceInfo,
          hidden,
        })),
      flagValues: new Map(observed.extensionRunner?.getFlagValues()),
    };
    const runtime = await createAdvisorSession(observed, { config, adviceTool, resourceInputs });
    afterEach(async () => {
      await disposeAdvisorSession(runtime);
    });
    await runtime.session.prompt("/touch-fixture");
    expect(entry(runtime.session, "fixture-touch")).toMatchObject({
      data: { touches: 1, sessionId: runtime.session.sessionId },
    });
    await expect(
      createAdvisorSession(observed, {
        config,
        adviceTool,
        resourceInputs: { ...resourceInputs, extensions: [] },
      }),
    ).rejects.toThrow(/match.*observed|ordered/i);
  });

  it("diagnoses CodeMode-only exposure without widening the grant or changing its mode", async () => {
    const codeMode = fileURLToPath(new URL("../../pi-codemode/src/index.ts", import.meta.url));
    const document = {
      codemode: { tools: [{ pattern: "*", exposure: "codemode-only" }] },
      compaction: { enabled: false },
    };
    const { observed } = await observedFixture(
      [fixture, codeMode],
      SettingsManager.inMemory(document),
    );
    const config = readAdvisorSettings(observed).settings;
    await expect(createAdvisorSession(observed, { config, adviceTool })).rejects.toThrow(
      /exposure|CodeMode/i,
    );
    const runtime = await createAdvisorSession(observed, {
      config: { ...config, allowedTools: [...config.allowedTools, "codemode_execute"] },
      adviceTool,
    });
    afterEach(async () => {
      await disposeAdvisorSession(runtime);
    });
    expect(runtime.session.getActiveToolNames()).toEqual(["codemode_execute"]);
    expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain("bash");
  });

  it("requires Context Management grants and keeps granted Notes and journals private", async () => {
    const contextManagement = fileURLToPath(
      new URL("../../pi-context-management/src/index.ts", import.meta.url),
    );
    const { observed } = await observedFixture([fixture, contextManagement]);
    const config = readAdvisorSettings(observed).settings;
    await expect(createAdvisorSession(observed, { config, adviceTool })).rejects.toThrow(
      /context_notes.*context_history.*context_rollover/,
    );
    const runtime = await createAdvisorSession(observed, {
      config: {
        ...config,
        allowedTools: [
          ...config.allowedTools,
          "context_notes",
          "context_history",
          "context_rollover",
        ],
      },
      adviceTool,
    });
    let closed = false;
    afterEach(async () => {
      globalThis.advisorSessionResponses = undefined;
      if (!closed) await disposeAdvisorSession(runtime);
    });
    globalThis.advisorSessionResponses = [
      {
        ...fauxAssistantMessage(""),
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "write-note",
            name: "context_notes",
            arguments: { action: "write", name: "Private", content: "Advisor-only note" },
          },
        ],
      },
    ];
    await runtime.session.prompt("Write a private note");
    expect(
      runtime.session.messages.some(
        (message) =>
          message.role === "toolResult" && message.toolName === "context_notes" && !message.isError,
      ),
    ).toBe(true);
    expect(observed.messages).toEqual([]);
    const file = runtime.session.sessionFile;
    if (!file) throw new Error("Native Advisor journal path missing");
    const reopened = SessionManager.open(file);
    expect(isAdvisorSession(reopened)).toBe(true);
    expect(
      reopened.buildSessionContext().messages.some((message) => message.role === "assistant"),
    ).toBe(true);
    expect(reopened.getSessionId()).not.toBe(observed.sessionId);
    await disposeAdvisorSession(runtime);
    closed = true;
    expect(entry(runtime.session, "fixture-shutdown")).toMatchObject({ data: { stopped: true } });
  });

  it("bounds cancelled creation and shuts down late startup without retaining its signal", async () => {
    const { observed } = await observedFixture();
    const config = readAdvisorSettings(observed).settings;
    await expect(
      createAdvisorSession(observed, { config, adviceTool, signal: AbortSignal.abort() }),
    ).rejects.toThrow(/abort/i);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const creating = createAdvisorSession(observed, {
      config,
      adviceTool,
      signal: cancellation.signal,
      controlExtension(pi) {
        pi.on("session_start", async () => {
          started.resolve();
          await release.promise;
        });
        pi.on("session_shutdown", () => {
          stopped.resolve();
        });
      },
    });
    await started.promise;
    cancellation.abort();
    await expect(creating).rejects.toThrow(/abort/i);
    release.resolve();
    await stopped.promise;

    const creationOnly = new AbortController();
    const runtime = await createAdvisorSession(observed, {
      config,
      adviceTool,
      signal: creationOnly.signal,
    });
    afterEach(async () => {
      await runtime.session.abort();
      await runtime.dispose();
    });
    creationOnly.abort();
    await runtime.session.prompt("/touch-fixture");
    expect(entry(runtime.session, "fixture-touch")).toMatchObject({ data: { touches: 1 } });
  });

  it("honors explicit model/thinking and runtime-only API keys without sharing provider state", async () => {
    const { observed } = await observedFixture();
    await observed.modelRuntime.setRuntimeApiKey("advisor-fixture", "runtime-only-key");
    const config = {
      ...readAdvisorSettings(observed).settings,
      model: "advisor-fixture/alternate",
      thinkingLevel: "high" as const,
    };
    const runtime = await createAdvisorSession(observed, { config, adviceTool });
    afterEach(async () => {
      await runtime.session.abort();
      await runtime.dispose();
    });
    expect(runtime.session.model?.id).toBe("alternate");
    expect(runtime.session.thinkingLevel).toBe("high");
    expect((await runtime.session.modelRuntime.getAuth("advisor-fixture"))?.auth.apiKey).toBe(
      "runtime-only-key",
    );
    runtime.session.modelRuntime.unregisterProvider("advisor-fixture");
    expect(observed.modelRuntime.getModel("advisor-fixture", "reviewer")?.id).toBe("reviewer");
    await expect(
      createAdvisorSession(observed, {
        config: { ...config, model: "missing/provider" },
        adviceTool,
      }),
    ).rejects.toThrow(/model.*unavailable/i);
  });

  it("retains native runtime settings and exact dynamic grants through reload", async () => {
    const { observed } = await observedFixture();
    observed.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 4096 } });
    const config = {
      ...readAdvisorSettings(observed).settings,
      allowedTools: ["read", "grep", "find", "ls", "allowed_dynamic", "not_installed"],
    };
    const runtime = await createAdvisorSession(observed, { config, adviceTool });
    afterEach(async () => {
      await runtime.session.abort();
      await runtime.dispose();
    });
    const definitions = runtime.session.getAllTools();
    await runtime.session.prompt("/dynamic-fixture");
    expect(runtime.session.getAllTools().map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "allowed_dynamic",
      "advisor_report",
    ]);
    expect(runtime.session.getActiveToolNames()).not.toContain("denied_dynamic");
    expect(runtime.session.getActiveToolNames()).not.toContain("bash");
    await runtime.session.reload();
    expect(runtime.session.settingsManager.getCompactionEnabled()).toBe(true);
    expect(runtime.session.settingsManager.getCompactionSettings().reserveTokens).toBe(4096);
    expect(runtime.session.getAllTools().filter((tool) => tool.name !== "allowed_dynamic")).toEqual(
      definitions,
    );
    expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain("denied_dynamic");
    await runtime.session.prompt("/touch-fixture");
    expect(entry(runtime.session, "fixture-touch")).toMatchObject({
      data: { touches: 1, flag: false },
    });
  });

  it("loads fresh session-bound factories with inherited provenance and false flags", async () => {
    const { observed } = await observedFixture(
      [],
      SettingsManager.inMemory({ extensions: [fixture], compaction: { enabled: false } }),
    );
    await observed.prompt("/touch-fixture");
    const before = structuredClone(observed.messages);
    const runtime = await createAdvisorSession(observed, {
      config: readAdvisorSettings(observed).settings,
      adviceTool,
    });
    afterEach(async () => {
      await runtime.session.abort();
      await runtime.dispose();
    });
    await runtime.session.prompt("/touch-fixture");
    expect(entry(runtime.session, "fixture-touch")).toMatchObject({
      data: { touches: 1, flag: false, sessionId: runtime.session.sessionId },
    });
    expect(entry(observed, "fixture-touch")).toMatchObject({
      data: { touches: 1, sessionId: observed.sessionId },
    });
    expect(entry(runtime.session, "fixture-start")).toMatchObject({ data: { privateRole: true } });
    expect(runtime.session.messages).toEqual([]);
    expect(observed.messages).toEqual(before);
    expect(runtime.session.modelRuntime).not.toBe(observed.modelRuntime);
    expect(
      runtime.session.resourceLoader
        .getExtensions()
        .extensions.map(({ path, resolvedPath, sourceInfo, hidden }) => ({
          path,
          resolvedPath,
          sourceInfo,
          hidden,
        })),
    ).toEqual(
      observed.resourceLoader
        .getExtensions()
        .extensions.map(({ path, resolvedPath, sourceInfo, hidden }) => ({
          path,
          resolvedPath,
          sourceInfo,
          hidden,
        })),
    );
  });
});
