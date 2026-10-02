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
  createCodemodeExtension,
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

it.each(["none", "on", "only"] as const)(
  "preserves exact main inputs and reports native errors (built-in codemode: %s)",
  async (codemodeMode) => {
    const combined = codemodeMode !== "none";
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
    const reportHints: unknown[] = [];
    globalThis.advisorObserverTest = {
      privateTools: (tools) =>
        reportHints.push(tools.find((tool) => tool.name === "advisor_report")?.annotations),
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
        defaultTools: [combined ? "+codemode" : "-codemode"],
        codemode: { mode: codemodeMode === "only" ? ("only" as const) : ("on" as const) },
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
              ? [
                  ...["pi-context-management", "pi-minimal-subagents"].map((name) =>
                    fileURLToPath(new URL(`../../${name}/src/index.ts`, import.meta.url)),
                  ),
                  "builtin:codemode",
                ]
              : []),
            fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          ],
          extensionFactories: combined
            ? [{ name: "codemode", factory: createCodemodeExtension(), builtin: true }]
            : [],
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
    // Built-in codemode says how scripts call the tools they can reach.
    const askCall = `${askTool.description}\n\nCodemode: \`tools.advisor_ask(args)\` resolves to a string.`;
    // `only` lists the full script declaration in the codemode description.
    const askSample = `${askTool.description}\n\ncodemode tool declaration:\n\`\`\`ts\ndeclare const tools: { advisor_ask(args: { message: string; }): Promise<string>; };\n\`\`\``;
    const declaredAsk = codemodeMode === "on" ? { ...askTool, description: askCall } : askTool;
    // `only` hides direct declarations and lists them in the codemode description instead.
    const withScriptedAsk = (tools: NonNullable<Context["tools"]> = []) =>
      tools.map((tool) =>
        codemodeMode === "only" && tool.name === "codemode"
          ? { ...tool, description: expect.stringContaining(`### \`advisor_ask\`\n${askSample}`) }
          : tool,
      );
    expect(mainRequests[1]).toEqual({
      ...disabledRequest,
      tools:
        codemodeMode === "only"
          ? withScriptedAsk(disabledRequest.tools)
          : [...(disabledRequest.tools ?? []), declaredAsk],
    });
    const disabledTranscript = sessionTranscript(runtimes[0]);
    const [disabledSystem] = disabledTranscript ?? [];
    if (disabledSystem?.role !== "system") throw new Error("Missing initial system message");
    expect(sessionTranscript(runtimes[1])).toEqual([
      {
        ...disabledSystem,
        toolsAdded: [...withScriptedAsk(disabledSystem.toolsAdded), declaredAsk],
      },
      ...(disabledTranscript?.slice(1) ?? []),
    ]);
    const enabledSession = runtimes[1]?.session;
    if (!enabledSession) throw new Error("Missing enabled session");
    const codemodeDescription = (runtime: AgentSessionRuntime | undefined) =>
      runtime?.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description;
    expect(codemodeDescription(runtimes[1]) === undefined).toBe(!combined);
    // Annotations are reported to permission extensions only; the exact provider-facing
    // declarations above are unchanged. advisor_ask only consults; advisor_report records findings.
    expect(enabledSession.getAllTools().find((tool) => tool.name === "advisor_ask")).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(reportHints).toEqual([
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    ]);
    for (const runtime of runtimes) await runtime.session.prompt("/advisor off");
    // Disabling withdraws advisor_ask from scripts too, leaving other listings unchanged.
    expect(codemodeDescription(runtimes[1])).toEqual(codemodeDescription(runtimes[0]));
    for (const runtime of runtimes)
      await runtime.session.prompt("Continue with on-demand advice disabled.");
    expect(mainRequests).toHaveLength(4);
    // Pi 0.99 declares the removed tool with an appended delta instead of rewriting the prefix.
    const [disabledFollowUp, enabledFollowUp] = mainRequests.slice(2);
    // Under `only`, withdrawing advisor_ask changes the codemode listing, so Pi redeclares codemode
    // after the other declared tools, including model-only context_rollover.
    const codemodeLast = (tools: NonNullable<Context["tools"]> = []) => [
      ...tools.filter((tool) => tool.name !== "codemode"),
      ...tools.filter((tool) => tool.name === "codemode"),
    ];
    expect({ ...enabledFollowUp, messages: conversation(enabledFollowUp?.messages) }).toEqual({
      ...disabledFollowUp,
      messages: conversation(disabledFollowUp?.messages),
      ...(codemodeMode === "only" && { tools: codemodeLast(disabledFollowUp?.tools) }),
    });
    const disabledState = sessionState(runtimes[0]);
    const disabledCodemode = disabledState.tools.find((tool) => tool.name === "codemode");
    // Under `only`, withdrawing advisor_ask changes the codemode listing, so Pi redeclares codemode last.
    expect(sessionState(runtimes[1])).toEqual(
      codemodeMode === "only"
        ? {
            ...disabledState,
            tools: [
              ...disabledState.tools.filter((tool) => tool !== disabledCodemode),
              disabledCodemode,
            ],
          }
        : disabledState,
    );
    expect(sessionTranscript(runtimes[0])?.filter(isSystem)).toHaveLength(1);
    expect(sessionTranscript(runtimes[1])?.filter(isSystem).slice(1)).toEqual([
      {
        role: "system",
        content: "",
        timestamp: expect.any(Number),
        ...(codemodeMode === "only"
          ? {
              toolsAdded: [disabledCodemode],
              toolsRemoved: [{ name: "codemode" }, { name: "advisor_ask" }],
            }
          : { toolsRemoved: [{ name: "advisor_ask" }] }),
      },
    ]);
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
