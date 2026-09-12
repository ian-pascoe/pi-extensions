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
  type Context,
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

it.each([false, true])(
  "preserves exact main inputs and reports native errors (combined siblings: %s)",
  async (combined) => {
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
        codemode: { tools: [{ pattern: "*", exposure: "direct-and-codemode" }] },
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
    expect(mainRequests[1]).toEqual(mainRequests[0]);
    expect(runtimes[1]?.session.messages).toEqual(runtimes[0]?.session.messages);
    const enabledSession = runtimes[1]?.session;
    if (!enabledSession) throw new Error("Missing enabled session");
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
    expect(reviewRequests).toHaveLength(2);
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
);
