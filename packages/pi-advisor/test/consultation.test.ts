import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  contentText,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import "./fixtures/observer-extension.js";

it("returns enabled main-agent consultation as an ordinary tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-consultation-"));
  const privatePrompts: string[] = [];
  const privateToolNames: string[][] = [];
  const questions = ["What risk should I check first?"];
  let failConsultation = false;
  let failConsultationTool = false;
  let consultationRequests = 0;
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report") ?? false;
      const prompt = contentText(
        context.messages.findLast((message) => message.role === "user")?.content ?? "",
      );
      const message = {
        ...fauxAssistantMessage("Main task complete"),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      if (privateRole) {
        privatePrompts.push(prompt);
        privateToolNames.push((context.tools ?? []).map((tool) => tool.name));
        if (prompt.includes("Consultation request")) {
          consultationRequests++;
          const failedRead = context.messages.some(
            (entry) => entry.role === "toolResult" && entry.toolName === "read" && entry.isError,
          );
          if (failConsultationTool && !failedRead) {
            message.content = [
              {
                type: "toolCall",
                id: "failed-read",
                name: "read",
                arguments: { path: join(directory, "missing-advisor-file") },
              },
            ];
            message.stopReason = "toolUse";
          } else if (failConsultation) {
            message.stopReason = "error";
            message.errorMessage = "Offline consultation failure";
          } else message.content = [{ type: "text", text: "Check the cancellation path first." }];
        } else {
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
      } else {
        const question = questions.shift();
        if (question) {
          message.content = [
            {
              type: "toolCall",
              id: `ask-${question}`,
              name: "advisor_ask",
              arguments: { message: question },
            },
          ];
          message.stopReason = "toolUse";
        }
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (message.stopReason === "error")
          stream.push({ type: "error", reason: "error", error: message });
        else
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
      });
      return stream;
    },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const settingsDocument = {
    advisor: { enabled: true, catchUpThreshold: "off" },
    compaction: { enabled: false },
    retry: { enabled: false },
  };
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(settingsDocument),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./fixtures/observer-extension.ts", import.meta.url)),
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
  await runtime.session.bindExtensions({ mode: "print" });
  afterEach(async () => {
    await runtime.session.abort();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  await runtime.session.prompt("Ask for a second opinion before finishing.");

  expect(
    runtime.session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "advisor_ask",
    ),
  ).toMatchObject({
    isError: false,
    content: [{ type: "text", text: "Check the cancellation path first." }],
  });
  expect(privateToolNames.every((names) => !names.includes("advisor_ask"))).toBe(true);
  expect(
    runtime.session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-advisor",
    ),
  ).toEqual([]);
  expect(privatePrompts[0]).toContain("Consultation request");
  expect(privatePrompts[0]).toContain("What risk should I check first?");
  expect(privatePrompts.at(-1)).toContain("Review this observed-agent evidence");
  expect(
    privatePrompts.some(
      (prompt) =>
        prompt.includes("Review this observed-agent evidence") &&
        prompt.includes("advisor_ask") &&
        prompt.includes("Check the cancellation path first."),
    ),
  ).toBe(true);

  failConsultationTool = true;
  questions.push("Can you recover from a failed investigation?");
  await runtime.session.prompt("Ask after an investigative tool fails.");
  const failedToolConsultation = runtime.session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "advisor_ask",
  );
  expect(failedToolConsultation).toMatchObject({ isError: true });
  expect(JSON.stringify(failedToolConsultation)).toContain("missing-advisor-file");
  await runtime.session.prompt("/advisor status");
  expect(
    runtime.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
  ).toMatchObject({
    data: { state: "paused", error: expect.stringContaining("missing-advisor-file") },
  });

  failConsultationTool = false;
  await runtime.session.prompt("/advisor on");
  failConsultation = true;
  questions.push("Can you verify another risk?");
  await runtime.session.prompt("Ask again after the first consultation.");
  expect(runtime.session.getActiveToolNames()).toContain("advisor_ask");
  expect(
    runtime.session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "advisor_ask",
    ),
  ).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "Offline consultation failure" }],
  });

  const requestsBeforePausedCall = consultationRequests;
  questions.push("Can you answer while paused?");
  await runtime.session.prompt("Try the paused Advisor.");
  const pausedResult = runtime.session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "advisor_ask",
  );
  expect(pausedResult).toMatchObject({ isError: true });
  expect(JSON.stringify(pausedResult)).toContain("Advisor is paused: Offline consultation failure");
  expect(JSON.stringify(pausedResult)).toContain("/advisor status");
  expect(JSON.stringify(pausedResult)).toContain("/advisor on");
  expect(consultationRequests).toBe(requestsBeforePausedCall);
});
