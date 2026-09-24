import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  type Context,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import "./fixtures/observer-extension.js";

/** Pi 0.86+ records tool declarations on system messages; compare declarations, not callbacks. */
function sessionTranscript(runtime: AgentSessionRuntime | undefined) {
  return runtime?.session.messages.map((message) =>
    message.role === "system" && message.toolsAdded
      ? {
          ...message,
          toolsAdded: message.toolsAdded.map((tool) => {
            const { name, description, parameters } = toToolDeclaration(tool);
            return { name, description, parameters };
          }),
        }
      : message,
  );
}

const isSystem = (message: { role: string }): message is SystemMessage => message.role === "system";
const conversation = <T extends { role: string }>(messages: T[] = []) =>
  messages.filter((message) => !isSystem(message));

/** Current prompt, ordered tools, and conversation after replaying Pi's system deltas. */
function sessionState(runtime: AgentSessionRuntime | undefined) {
  const transcript = sessionTranscript(runtime) ?? [];
  const system = transcript.filter(isSystem);
  return {
    systemPrompt: getCurrentSystemPrompt(system),
    tools: getCurrentTools(system),
    messages: conversation(transcript),
  };
}

it.each(["none", "direct-only", "both", "codemode-only"] as const)(
  "preserves exact main inputs and reports native errors (CodeMode exposure: %s)",
  async (codeModeExposure) => {
    const combined = codeModeExposure !== "none";
    const advisorInCodeMode = codeModeExposure === "both" || codeModeExposure === "codemode-only";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
    afterEach(() => vi.useRealTimers());
    const directory = await mkdtemp(join(tmpdir(), "advisor-extension-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    afterEach(() => vi.unstubAllEnvs());
    const runtimes: AgentSessionRuntime[] = [];
    afterEach(async () => {
      for (const runtime of runtimes) {
        await runtime.session.abort();
        await runtime.dispose();
      }
      await rm(directory, { recursive: true, force: true });
    });
    const mainRequests: Context[] = [];
    const reviewRequests: Context[] = [];
    globalThis.advisorObserverTest = {
      stream(model, context) {
        const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
        (privateRole ? reviewRequests : mainRequests).push(
          structuredClone({
            ...context,
            tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          }),
        );
        const message = {
          ...fauxAssistantMessage("Done"),
          api: model.api,
          provider: model.provider,
          model: model.id,
        };
        if (privateRole) {
          message.content = [
            {
              type: "toolCall",
              id: "report",
              name: "advisor_report",
              arguments: { severity: "none" },
            },
          ];
          message.stopReason = "toolUse";
        }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() =>
          stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
        );
        return stream;
      },
    };
    for (const enabled of [false, true]) {
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const document = {
        advisor: {
          enabled,
          catchUpThreshold: "off",
          allowedTools: [
            "read",
            "grep",
            "find",
            "ls",
            ...(combined ? ["context_notes", "context_history", "context_rollover"] : []),
          ],
        },
        codemode: {
          tools: [
            {
              pattern: codeModeExposure === "codemode-only" ? "advisor_ask" : "*",
              exposure:
                codeModeExposure === "direct-only"
                  ? "direct-only"
                  : codeModeExposure === "codemode-only"
                    ? "codemode-only"
                    : "direct-and-codemode",
            },
          ],
        },
        compaction: { enabled: false },
        retry: { enabled: false },
      };
      const services = await createAgentSessionServices({
        cwd: directory,
        agentDir: directory,
        modelRuntime,
        settingsManager: SettingsManager.inMemory(document),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noThemes: true,
          noPromptTemplates: true,
          additionalExtensionPaths: [
            fileURLToPath(new URL("./fixtures/observer-extension.ts", import.meta.url)),
            ...(combined
              ? ["pi-context-management", "pi-codemode", "pi-minimal-subagents"].map((name) =>
                  fileURLToPath(new URL(`../../${name}/src/index.ts`, import.meta.url)),
                )
              : []),
            fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          ],
        },
      });
      const model = modelRuntime.getModel("observer-fixture", "model");
      if (!model) throw new Error("Missing offline model");
      const created = await createAgentSessionFromServices({
        services,
        model,
        sessionManager: SessionManager.create(directory, join(directory, "sessions")),
      });
      const runtime = new AgentSessionRuntime(created.session, services, async () => {
        throw new Error("No replacement");
      });
      runtimes.push(runtime);
      await runtime.session.bindExtensions({ mode: "print" });
      await runtime.session.prompt("Do this task.");
      await runtime.session.prompt("/advisor status");
      expect(
        runtime.session.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
      ).toMatchObject({ data: { state: enabled ? "armed" : "disabled", backlog: 0 } });
    }
    expect(reviewRequests).toHaveLength(1);
    expect(mainRequests).toHaveLength(2);
    const disabledRequest = mainRequests[0];
    if (!disabledRequest) throw new Error("Missing disabled request");
    const askTool = {
      name: "advisor_ask",
      description:
        "Ask the enabled Advisor for analysis or a second opinion. Waits for its answer; does not delegate implementation.",
      parameters: {
        additionalProperties: false,
        properties: { message: { minLength: 1, type: "string" } },
        required: ["message"],
        type: "object",
      },
    };
    expect(mainRequests[1]).toEqual(
      codeModeExposure === "codemode-only"
        ? disabledRequest
        : { ...disabledRequest, tools: [...(disabledRequest.tools ?? []), askTool] },
    );
    const disabledTranscript = sessionTranscript(runtimes[0]);
    const [disabledSystem] = disabledTranscript ?? [];
    if (disabledSystem?.role !== "system") throw new Error("Missing initial system message");
    const expectedTranscript =
      codeModeExposure === "codemode-only"
        ? disabledTranscript
        : [
            { ...disabledSystem, toolsAdded: [...(disabledSystem.toolsAdded ?? []), askTool] },
            ...(disabledTranscript?.slice(1) ?? []),
          ];
    expect(sessionTranscript(runtimes[1])).toEqual(expectedTranscript);
    const enabledSession = runtimes[1]?.session;
    if (!enabledSession) throw new Error("Missing enabled session");
    const searchCodeMode = async (query: string) => {
      const search = enabledSession.agent.state.tools.find(
        (tool) => tool.name === "codemode_search",
      );
      if (!search) throw new Error("Missing CodeMode search tool");
      return (
        await search.execute("advisor-search", { query }, new AbortController().signal, undefined)
      ).details;
    };
    const foreignSearch = advisorInCodeMode ? await searchCodeMode("context_notes") : undefined;
    if (advisorInCodeMode) expect(await searchCodeMode("advisor_ask")).toMatchObject({ total: 1 });
    else if (combined)
      expect(JSON.stringify(await searchCodeMode("advisor_ask"))).not.toContain(
        '"name":"advisor_ask"',
      );
    for (const runtime of runtimes) await runtime.session.prompt("/advisor off");
    if (combined) {
      expect(JSON.stringify(await searchCodeMode("advisor_ask"))).not.toContain(
        '"name":"advisor_ask"',
      );
      if (advisorInCodeMode) expect(await searchCodeMode("context_notes")).toEqual(foreignSearch);
    }
    for (const runtime of runtimes)
      await runtime.session.prompt("Continue with on-demand advice disabled.");
    expect(mainRequests).toHaveLength(4);
    // Pi 0.87 declares the removed tool with an appended delta instead of rewriting the prefix.
    const [disabledFollowUp, enabledFollowUp] = mainRequests.slice(2);
    expect({ ...enabledFollowUp, messages: conversation(enabledFollowUp?.messages) }).toEqual({
      ...disabledFollowUp,
      messages: conversation(disabledFollowUp?.messages),
    });
    expect(sessionState(runtimes[1])).toEqual(sessionState(runtimes[0]));
    expect(sessionTranscript(runtimes[0])?.filter(isSystem)).toHaveLength(1);
    expect(sessionTranscript(runtimes[1])?.filter(isSystem).slice(1)).toEqual(
      codeModeExposure === "codemode-only"
        ? []
        : [
            {
              role: "system",
              content: "",
              timestamp: expect.any(Number),
              toolsRemoved: [{ name: "advisor_ask" }],
            },
          ],
    );
    await enabledSession.prompt("/advisor on");
    await enabledSession.prompt("Recreate the private Advisor session before restart.");
    expect(reviewRequests).toHaveLength(2);
    const shutdownStarted = Promise.withResolvers<void>();
    const releaseShutdown = Promise.withResolvers<void>();
    globalThis.advisorObserverTest.privateShutdown = async () => {
      shutdownStarted.resolve();
      await releaseShutdown.promise;
    };
    const rebinding = enabledSession.bindExtensions({ mode: "print" });
    await shutdownStarted.promise;
    await enabledSession.prompt("/advisor off");
    await enabledSession.prompt("/advisor on");
    releaseShutdown.resolve();
    await rebinding;
    delete globalThis.advisorObserverTest.privateShutdown;
    await enabledSession.prompt("Continue after settings changed during native restart.");
    expect(reviewRequests).toHaveLength(3);
    await enabledSession.prompt('/advisor set model "missing/model"');
    await enabledSession.prompt("Continue even if Advisor cannot resolve its model.");
    expect(
      enabledSession.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: { state: "paused", error: expect.stringContaining("model is unavailable") },
    });
  },
  20_000,
);
