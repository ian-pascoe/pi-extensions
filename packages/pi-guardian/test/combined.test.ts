import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import "./fixtures/combined-extension.js";

it("makes a real Minimal Subagents Child Agent follow its root's Guardian settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-guardian-combined-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const fixture = fileURLToPath(new URL("./fixtures/combined-extension.ts", import.meta.url));
  const guardian = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  // Child Agents load the extensions listed in the agent directory's settings.
  await writeFile(
    join(directory, "settings.json"),
    JSON.stringify({
      extensions: [fixture, guardian],
      minimalSubagents: { enabled: true },
      guardian: { model: "guardian-combined/reviewer" },
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const reviewedCalls: string[] = [];
  const childResults: string[] = [];
  let mainCalls = 0;
  globalThis.guardianCombinedTest = {
    executed: [],
    stream(role, model, context) {
      const message = {
        ...fauxAssistantMessage("Done"),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      const call = (name: string, args: ToolCall["arguments"]) => {
        message.content = [{ type: "toolCall", id: `${role}-${name}`, name, arguments: args }];
        message.stopReason = "toolUse";
      };
      const lastUser = context.messages.at(-1);
      if (model.id === "reviewer") {
        const blocks =
          lastUser?.role === "user" && Array.isArray(lastUser.content) ? lastUser.content : [];
        const last = blocks.at(-1);
        reviewedCalls.push(last?.type === "text" ? last.text : "");
        message.content = [
          {
            type: "text",
            text: JSON.stringify({
              risk_level: "low",
              user_authorization: "high",
              rationale: "Requested.",
            }),
          },
        ];
      } else if (role === "main") {
        mainCalls++;
        if (mainCalls === 1)
          call("subagent", {
            agent_id: "worker",
            task: "Deploy x.",
            tools: ["deploy"],
            delegation: "none",
            session_context: "omit",
            project_context: "omit",
          });
        else if (mainCalls === 2) call("subagent_wait", { agent_id: "worker", timeout_ms: 10_000 });
      } else {
        const result = context.messages.find(
          (entry) => entry.role === "toolResult" && entry.toolName === "deploy",
        );
        if (result?.role === "toolResult")
          childResults.push(
            result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          );
        else call("deploy", { target: "x" });
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    settingsManager: SettingsManager.create(directory, directory),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fixture,
        fileURLToPath(new URL("../../pi-minimal-subagents/src/index.ts", import.meta.url)),
        guardian,
      ],
    },
  });
  const model = modelRuntime.getModel("guardian-combined", "model");
  if (!model) throw new Error("Missing offline model");
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(directory, join(directory, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("No replacement");
  });
  onTestFinished(async () => {
    await runtime.session.abort();
    await runtime.dispose();
  });
  await runtime.session.bindExtensions({ mode: "print" });

  // A root session override the child's own settings do not have.
  await runtime.session.prompt("/guardian tool deploy deny");
  await runtime.session.prompt("Delegate deploying x and wait for the result.");

  const wait = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "subagent_wait",
  );
  expect(wait).toMatchObject({ isError: false });
  // The child's deploy was denied by the root's Tool Policy without a Guardian Review.
  expect(globalThis.guardianCombinedTest.executed).toEqual([]);
  expect(childResults).toEqual([expect.stringMatching(/denied by Guardian's Tool Policy/)]);
  expect(reviewedCalls.some((text) => text.includes("Minimal Subagents Child Agent"))).toBe(false);
});
