import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  getPackageDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  type SourceInfo,
  type CreateModelRuntimeOptions,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionFromServicesOptions,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AdvisorConfig } from "./advisor-settings.js";

/** Explicit file-selection recipe supplied by the resource owner, never inferred from opaque loaders. */
export interface AdvisorResourceInputs {
  agentDir: string;
  extensions: readonly {
    readonly path: string;
    readonly resolvedPath: string;
    readonly sourceInfo: SourceInfo;
    readonly hidden?: boolean | undefined;
  }[];
  flagValues: ReadonlyMap<string, boolean | string>;
}

/** Fresh factories and native services; the observed session supplies data, never bound handlers. */
export interface AdvisorSessionOptions {
  config: AdvisorConfig;
  adviceTool: ToolDefinition;
  controlExtension?: ExtensionFactory;
  signal?: AbortSignal;
  resourceInputs?: AdvisorResourceInputs;
}

const roleSchema = Type.Object({
  role: Type.Literal("advisor"),
  observedSessionId: Type.String({ minLength: 1 }),
});

/** Private role is native journal state and is installed before session_start. */
export function isAdvisorSession(manager: Pick<SessionManager, "getBranch">): boolean {
  return manager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-advisor-role" &&
        Value.Check(roleSchema, entry.data),
    );
}

/** Abort owned work before emitting the native extension shutdown lifecycle. */
export async function disposeAdvisorSession(runtime: AgentSessionRuntime): Promise<void> {
  try {
    await runtime.session.abort();
  } finally {
    await runtime.dispose();
  }
}

// Pi 0.85.1 keeps these plain constructor inputs private; public scoped getters omit applyOverrides.
/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: Capability-check native SDK data before copying; offline SDK creation tests cover these inputs. */
function recreationInputs(
  loader: unknown,
  settings: unknown,
  models: unknown,
  owner?: AdvisorResourceInputs,
) {
  const loaderSchema = Type.Object({
    agentDir: Type.String(),
    extensionsOverride: Type.Optional(Type.Undefined()),
  });
  const settingsSchema = Type.Object({ settings: Type.Object({}, { additionalProperties: true }) });
  const modelsSchema = Type.Object({
    modelsPath: Type.Optional(Type.String()),
    credentials: Type.Object({ store: Type.Unknown(), overrides: Type.Unknown() }),
  });
  if (
    (!owner && !Value.Check(loaderSchema, loader)) ||
    !Value.Check(settingsSchema, settings) ||
    !Value.Check(modelsSchema, models)
  ) {
    throw new Error(
      "Unsupported Advisor SDK/resources: native recreation inputs or custom transformations cannot be reproduced",
    );
  }
  const agentDir =
    owner?.agentDir ?? (Value.Check(loaderSchema, loader) ? loader.agentDir : undefined);
  if (!Value.Check(Type.String({ minLength: 1 }), agentDir))
    throw new Error("Advisor resource owner did not supply an agent directory");
  const fileAuthSchema = Type.Object({
    authPath: Type.String(),
    storage: Type.Object({ authPath: Type.String() }),
  });
  const store = models.credentials.store;
  let authPath: string | undefined;
  if (
    Value.Check(fileAuthSchema, store) &&
    store.authPath === store.storage.authPath &&
    // Pi 0.85.1's bundled CLI names the same native class _AuthStorage.
    ["AuthStorage", "_AuthStorage"].includes(Object.getPrototypeOf(store)?.constructor.name) &&
    Object.getPrototypeOf(store.storage)?.constructor.name === "FileAuthStorageBackend"
  )
    authPath = store.authPath;
  if (!(models.credentials.overrides instanceof Map))
    throw new Error("Unsupported Advisor native credential overrides");
  const overrides = [...models.credentials.overrides];
  if (!Value.Check(Type.Array(Type.Tuple([Type.String(), Type.String()])), overrides))
    throw new Error("Unsupported Advisor native credential override values");
  return {
    agentDir,
    modelsPath: models.modelsPath ?? null,
    authPath,
    runtimeApiKeys: new Map(overrides),
    settingsSnapshot: structuredClone(settings.settings),
  };
}
/* oxlint-enable anti-slop/no-unknown-parameters */

/** Create a private native journal without starting model inference. */
export async function createAdvisorSession(
  observed: AgentSession,
  options: AdvisorSessionOptions,
): Promise<AgentSessionRuntime> {
  if (VERSION !== "0.85.1")
    throw new Error(
      `Unsupported Pi ${VERSION}: Advisor's native tool ceiling and session lifecycle are verified on Pi 0.85.1`,
    );
  options.signal?.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () =>
    cancelled.reject(
      options.signal?.reason ?? new DOMException("Advisor creation aborted", "AbortError"),
    );
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([buildAdvisorSession(observed, options), cancelled.promise]);
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function buildAdvisorSession(
  observed: AgentSession,
  options: AdvisorSessionOptions,
): Promise<AgentSessionRuntime> {
  const source = observed.resourceLoader;
  if (
    !options.resourceInputs &&
    Object.getPrototypeOf(source) !== DefaultResourceLoader.prototype
  ) {
    throw new Error(
      "Unsupported Advisor resources: custom loaders/transformations require fresh owner-supplied recreation inputs",
    );
  }
  const { agentDir, modelsPath, authPath, runtimeApiKeys, settingsSnapshot } = recreationInputs(
    source,
    observed.settingsManager,
    observed.modelRuntime,
    options.resourceInputs,
  );
  const inherited = source
    .getExtensions()
    .extensions.map(({ path, resolvedPath, sourceInfo, hidden }) => ({
      path,
      resolvedPath,
      sourceInfo: structuredClone(sourceInfo),
      hidden,
    }));
  if (options.resourceInputs) {
    const supplied = options.resourceInputs.extensions.map(
      ({ path, resolvedPath, sourceInfo, hidden }) => ({
        path,
        resolvedPath,
        sourceInfo: structuredClone(sourceInfo),
        hidden,
      }),
    );
    if (!isDeepStrictEqual(supplied, inherited))
      throw new Error("Advisor resource owner inputs do not match the observed ordered extensions");
    if (
      !isDeepStrictEqual(
        new Map(options.resourceInputs.flagValues),
        new Map(observed.extensionRunner?.getFlagValues()),
      )
    )
      throw new Error("Advisor resource owner flags do not match the observed flags");
  }
  const extensionPaths = source.getExtensions().extensions.map((extension) => {
    if (extension.resolvedPath && !extension.resolvedPath.startsWith("<"))
      return extension.resolvedPath;
    // Pi 0.85.1 injects this built-in inline, but ships a fresh file-backed factory.
    // Match its registration shape, not arbitrary inline closures or hidden extensions.
    if (
      extension.path === "<inline:llama.cpp>" &&
      extension.resolvedPath === extension.path &&
      extension.hidden === true &&
      extension.commands.size === 1 &&
      extension.commands.has("llama") &&
      [
        extension.handlers,
        extension.tools,
        extension.messageRenderers,
        extension.entryRenderers,
        extension.flags,
        extension.shortcuts,
      ].every((registrations) => !registrations?.size) &&
      !extension.markdownTransformer
    ) {
      const path = join(getPackageDir(), "dist", "extensions", "llama", "index.js");
      if (!existsSync(path))
        throw new Error(
          `Unsupported Advisor resources: Pi's built-in llama.cpp file is unavailable (${path})`,
        );
      return path;
    }
    throw new Error(
      `Unsupported Advisor resources: inline factories require fresh owner-supplied recreation inputs (${extension.path})`,
    );
  });
  const flags = new Map(observed.extensionRunner?.getFlagValues());
  const global = JSON.stringify(observed.settingsManager.getGlobalSettings());
  const project = JSON.stringify(observed.settingsManager.getProjectSettings());
  const config = structuredClone(options.config);
  const contextTools = ["context_notes", "context_history", "context_rollover"];
  const hasContextManagement = source
    .getExtensions()
    .extensions.some((extension) => contextTools.every((name) => extension.tools.has(name)));
  const missingContextGrants = hasContextManagement
    ? contextTools.filter((name) => !config.allowedTools.includes(name))
    : [];
  if (missingContextGrants.length)
    throw new Error(
      `Advisor requires Context Management grants: ${missingContextGrants.join(", ")}`,
    );
  if (
    source
      .getExtensions()
      .extensions.some((extension) => extension.tools.has(options.adviceTool.name))
  )
    throw new Error(
      `Advisor intrinsic advice tool conflicts with an inherited extension: ${options.adviceTool.name}`,
    );
  let selectedModel = observed.model;
  if (config.model) {
    const separator = config.model.indexOf("/");
    selectedModel = observed.modelRuntime.getModel(
      config.model.slice(0, separator),
      config.model.slice(separator + 1),
    );
  }
  if (!selectedModel)
    throw new Error(`Advisor model is unavailable: ${config.model ?? "observed model"}`);
  const model = structuredClone(selectedModel);
  const operation = options.signal ? { signal: options.signal } : undefined;
  const parentAuth = await observed.modelRuntime.getAuth(model, operation);
  if (!parentAuth) throw new Error(`Advisor authentication is unavailable for ${model.provider}`);
  const authSnapshot = structuredClone({ auth: parentAuth.auth, env: parentAuth.env ?? {} });
  if (!authPath) {
    for (const credential of await observed.modelRuntime.listCredentials(operation)) {
      if (credential.type === "oauth")
        throw new Error(
          "Unsupported Advisor custom OAuth storage: a native auth-file recreation input is required",
        );
      const resolved = await observed.modelRuntime.getAuth(credential.providerId, operation);
      if (resolved?.auth.apiKey !== undefined)
        runtimeApiKeys.set(credential.providerId, resolved.auth.apiKey);
    }
    if (parentAuth.auth.apiKey !== undefined)
      runtimeApiKeys.set(model.provider, parentAuth.auth.apiKey);
  }
  let constructionSignal = options.signal;
  const factory: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    constructionSignal?.throwIfAborted();
    if (!isAdvisorSession(sessionManager))
      sessionManager.appendCustomEntry("pi-advisor-role", {
        role: "advisor",
        observedSessionId: observed.sessionId,
      });
    const scopes = new Map([
      ["global", global],
      ["project", project],
    ]);
    const settingsManager = SettingsManager.fromStorage(
      {
        withLock(scope, update) {
          const next = update(scopes.get(scope));
          if (next !== undefined) scopes.set(scope, next);
        },
      },
      { projectTrusted: observed.settingsManager.isProjectTrusted() },
    );
    settingsManager.applyOverrides(settingsSnapshot);
    const reloadSettings = settingsManager.reload.bind(settingsManager);
    settingsManager.reload = async () => {
      await reloadSettings();
      settingsManager.applyOverrides(settingsSnapshot);
    };
    const modelInputs: CreateModelRuntimeOptions = {
      modelsPath,
      refreshOnCreate: false,
    };
    if (constructionSignal) modelInputs.signal = constructionSignal;
    if (authPath) modelInputs.authPath = authPath;
    else modelInputs.credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create(modelInputs);
    const operation = constructionSignal ? { signal: constructionSignal } : undefined;
    for (const [provider, apiKey] of runtimeApiKeys)
      await modelRuntime.setRuntimeApiKey(provider, apiKey, operation);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noContextFiles: true,
        additionalExtensionPaths: extensionPaths,
        extensionFactories: options.controlExtension
          ? [{ name: "advisor-control", factory: options.controlExtension }]
          : [],
        systemPromptOverride: () => config.prompt,
        appendSystemPromptOverride: () => [],
      },
    });
    if (!modelRuntime.getModel(model.provider, model.id))
      throw new Error(
        `Advisor model is unavailable in recreated providers: ${model.provider}/${model.id}`,
      );
    const missingProviders = observed.modelRuntime
      .getRegisteredProviderIds()
      .filter((provider) => !modelRuntime.getRegisteredProviderIds().includes(provider));
    if (missingProviders.length)
      throw new Error(`Unsupported Advisor runtime-only providers: ${missingProviders.join(", ")}`);
    let privateAuth = await modelRuntime.getAuth(model, operation);
    if (
      !isDeepStrictEqual({ auth: privateAuth?.auth, env: privateAuth?.env ?? {} }, authSnapshot) &&
      parentAuth.auth.apiKey !== undefined &&
      !observed.modelRuntime.isUsingOAuth(model.provider)
    ) {
      await modelRuntime.setRuntimeApiKey(model.provider, parentAuth.auth.apiKey, operation);
      privateAuth = await modelRuntime.getAuth(model, operation);
    }
    if (
      !isDeepStrictEqual({ auth: privateAuth?.auth, env: privateAuth?.env ?? {} }, authSnapshot)
    ) {
      throw new Error(
        `Unsupported Advisor authentication recreation for ${model.provider}; no credential fallback was selected`,
      );
    }
    const restoreResources = () => {
      const loaded = services.resourceLoader.getExtensions();
      if (
        loaded.extensions.length !== inherited.length + (options.controlExtension ? 1 : 0) ||
        extensionPaths.some((path, index) => path !== loaded.extensions[index]?.resolvedPath)
      ) {
        throw new Error("Advisor could not reproduce the ordered inherited extension resources");
      }
      inherited.forEach((original, index) => {
        const fresh = loaded.extensions[index];
        if (!fresh) throw new Error("Advisor inherited extension is unavailable");
        fresh.path = original.path;
        fresh.resolvedPath = original.resolvedPath;
        if (original.hidden === undefined) delete fresh.hidden;
        else fresh.hidden = original.hidden;
        fresh.sourceInfo = structuredClone(original.sourceInfo);
        for (const tool of fresh.tools.values()) tool.sourceInfo = fresh.sourceInfo;
        for (const command of fresh.commands.values()) command.sourceInfo = fresh.sourceInfo;
      });
      for (const [name, value] of flags) loaded.runtime.flagValues.set(name, value);
    };
    restoreResources();
    const reload = services.resourceLoader.reload.bind(services.resourceLoader);
    services.resourceLoader.reload = async (reloadOptions) => {
      await reload(reloadOptions);
      restoreResources();
    };
    const sessionOptions: CreateAgentSessionFromServicesOptions = {
      services,
      sessionManager,
      model,
      thinkingLevel: config.thinkingLevel ?? observed.thinkingLevel,
      tools: [...config.allowedTools, options.adviceTool.name],
      customTools: [options.adviceTool],
    };
    if (sessionStartEvent) sessionOptions.sessionStartEvent = sessionStartEvent;
    const created = await createAgentSessionFromServices(sessionOptions);
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: observed.sessionManager.getCwd(),
    agentDir,
    sessionManager: SessionManager.create(
      observed.sessionManager.getCwd(),
      join(observed.sessionManager.getSessionDir(), "advisors", observed.sessionId),
    ),
  });
  const bind = async (session: AgentSession) =>
    session.bindExtensions({
      mode: "print",
      onError: (error) => {
        runtime.services.diagnostics.push({
          type: "error",
          message: `Advisor extension ${error.extensionPath}: ${error.error}`,
        });
      },
    });
  runtime.setRebindSession(bind);
  let bindingStarted = false;
  try {
    options.signal?.throwIfAborted();
    bindingStarted = true;
    await bind(runtime.session);
    const active = runtime.session.getActiveToolNames();
    const bridgeAvailable =
      config.allowedTools.includes("codemode_execute") && active.includes("codemode_execute");
    const codeModeLoaded = source
      .getExtensions()
      .extensions.some((extension) => extension.tools.has("codemode_execute"));
    const hiddenGrants = runtime.session
      .getAllTools()
      .filter((tool) => config.allowedTools.includes(tool.name) && !active.includes(tool.name));
    if (
      (!active.includes(options.adviceTool.name) || (codeModeLoaded && hiddenGrants.length > 0)) &&
      !bridgeAvailable
    ) {
      throw new Error(
        "Advisor tools are hidden by inherited exposure policy; grant the CodeMode execution tool explicitly or configure direct exposure",
      );
    }
    options.signal?.throwIfAborted();
    const failure = runtime.diagnostics.find((item) => item.type === "error");
    if (failure) throw new Error(failure.message);
    constructionSignal = undefined;
    return runtime;
  } catch (cause) {
    if (bindingStarted) await disposeAdvisorSession(runtime);
    // No session_start ran, so no session-scoped resources exist to notify on this path.
    else runtime.session.dispose();
    throw cause;
  }
}
