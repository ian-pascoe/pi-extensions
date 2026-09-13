import { afterEach, expect, it } from "vitest";
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
} from "@earendil-works/pi-coding-agent";
import { reply, toolCall } from "../../pi-context-management/test/sdk-harness.js";
import { AdvisorObserver } from "../src/advisor-observer.js";
import { readAdvisorSettings } from "../src/advisor-settings.js";
import "./fixtures/observer-extension.js";
import "./fixtures/review-regression-extension.js";

function response(
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

async function fixture({ enabled = true, interactive = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "advisor-review-regression-"));
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
        fileURLToPath(new URL("./fixtures/observer-extension.ts", import.meta.url)),
        fileURLToPath(new URL("./fixtures/review-regression-extension.ts", import.meta.url)),
        fileURLToPath(new URL("../src/index.ts", import.meta.url)),
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
      ? { mode: "rpc", uiContext: { ...session.extensionRunner!.getUIContext() } }
      : { mode: "print" },
  );
  return { session, cleanupGates };
}

it("inherits live observed thinking changes for subsequent Reviews", async () => {
  const levels: Array<string | undefined> = [];
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      if (privateRole) levels.push(options?.reasoning);
      return response(
        model,
        privateRole ? toolCall("advisor_report", { severity: "none" }) : reply("Done"),
        options,
      );
    },
  };
  const { session } = await fixture();
  await session.prompt("First request");
  session.setThinkingLevel("high");
  await session.prompt("Second request");
  expect(levels).toEqual(["low", "high"]);
});

it("invalidates unconsumed Advisor steering on disable without removing unrelated user steering", async () => {
  const secondRequest = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let mainCalls = 0;
  const seenUserSteering: string[] = [];
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "advisor_report"))
        return response(
          model,
          toolCall("advisor_report", { severity: "blocker", message: "Stale queued finding" }),
          options,
        );
      mainCalls++;
      if (JSON.stringify(context.messages).includes("Unrelated user instruction"))
        seenUserSteering.push("received");
      if (mainCalls === 1)
        return response(
          model,
          toolCall("read", { path: "/missing-advisor-fixture-file" }),
          options,
        );
      if (mainCalls === 2) {
        secondRequest.resolve();
        return response(model, reply("Done"), options, releaseSecond.promise);
      }
      return response(model, reply("Done"), options);
    },
  };
  const { session, cleanupGates } = await fixture();
  cleanupGates.push(releaseSecond.resolve);
  const pending = session.prompt("Observed task");
  await secondRequest.promise;
  await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-advisor",
    ),
  ).toEqual([]);
  await session.steer("Unrelated user instruction");
  await session.prompt("/advisor off");
  releaseSecond.resolve();
  await pending;
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-advisor",
    ),
  ).toEqual([]);
  expect(seenUserSteering).not.toEqual([]);
  expect(mainCalls).toBe(3);
});

it("rejects abandoned-branch findings before later session_tree handlers receive the event", async () => {
  const reviewStarted = Promise.withResolvers<void>();
  const releaseReview = Promise.withResolvers<void>();
  const treeEntered = Promise.withResolvers<void>();
  const releaseTree = Promise.withResolvers<void>();
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      if (!context.tools?.some((tool) => tool.name === "advisor_report"))
        return response(model, reply("Done"), options);
      reviewStarted.resolve();
      return response(
        model,
        toolCall("advisor_report", { severity: "blocker", message: "Abandoned-branch finding" }),
        options,
        releaseReview.promise,
      );
    },
  };
  const { session, cleanupGates } = await fixture({ enabled: false });
  cleanupGates.push(releaseReview.resolve, releaseTree.resolve);
  globalThis.advisorReviewRegression.tree = async () => {
    treeEntered.resolve();
    await releaseTree.promise;
  };
  await session.prompt("Kept task");
  const target = session.sessionManager.getLeafId();
  if (!target) throw new Error("Missing native target leaf");
  await session.prompt("/advisor on");
  const pending = session.prompt("Abandoned task");
  await reviewStarted.promise;
  await expect.poll(() => session.isStreaming).toBe(false);
  const navigating = session.navigateTree(target, { summarize: false });
  await treeEntered.promise;
  releaseReview.resolve();
  await pending;
  const findings = session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "pi-advisor");
  releaseTree.resolve();
  await navigating;
  expect(findings).toEqual([]);
});

it("never starts an automatic Corrective Turn inside native manual compaction", async () => {
  const reviewStarted = Promise.withResolvers<void>();
  const releaseReview = Promise.withResolvers<void>();
  const compactionEntered = Promise.withResolvers<void>();
  const releaseCompaction = Promise.withResolvers<void>();
  const compactionStates: boolean[] = [];
  const { session, cleanupGates } = await fixture({ interactive: true });
  cleanupGates.push(releaseReview.resolve, releaseCompaction.resolve);
  let reviews = 0;
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "advisor_report")) {
        reviews++;
        reviewStarted.resolve();
        return response(
          model,
          toolCall(
            "advisor_report",
            reviews === 1
              ? { severity: "blocker", message: "Late corrective finding" }
              : { severity: "none" },
          ),
          options,
          releaseReview.promise,
        );
      }
      compactionStates.push(session.isCompacting);
      return response(model, reply("Done"), options);
    },
  };
  globalThis.advisorReviewRegression.compact = async () => {
    compactionEntered.resolve();
    await releaseCompaction.promise;
  };
  await session.prompt("Completed task " + "history ".repeat(3000));
  await reviewStarted.promise;
  const compacting = session.compact();
  await compactionEntered.promise;
  expect(session.isCompacting).toBe(true);
  releaseReview.resolve();
  // Await delivery or invalidation of the held Review, not a fixed sleep.
  await expect
    .poll(async () => {
      await session.prompt("/advisor status");
      const status = session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");
      return status?.type === "custom" ? JSON.stringify(status.data) : "";
    })
    .not.toContain('"state":"reviewing"');
  releaseCompaction.resolve();
  await compacting;
  expect(compactionStates).not.toContain(true);
});

it("starts a pending interactive correction only after the observed native run settles", async () => {
  const ended = Promise.withResolvers<void>();
  const releaseEnd = Promise.withResolvers<void>();
  let mainCalls = 0;
  let reviews = 0;
  const { session, cleanupGates } = await fixture({ interactive: true });
  cleanupGates.push(releaseEnd.resolve);
  globalThis.advisorReviewRegression.agentEnd = async () => {
    ended.resolve();
    await releaseEnd.promise;
  };
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "advisor_report")) {
        reviews++;
        return response(
          model,
          toolCall(
            "advisor_report",
            reviews === 1
              ? { severity: "blocker", message: "Correct after settlement" }
              : { severity: "none" },
          ),
          options,
        );
      }
      mainCalls++;
      return response(model, reply("Done"), options);
    },
  };
  const pending = session.prompt("Complete a task");
  await ended.promise;
  await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  expect(session.isIdle).toBe(false);
  expect(mainCalls).toBe(1);
  releaseEnd.resolve();
  await pending;
  await expect.poll(() => mainCalls).toBe(2);
});

it("retracts queued owned-child findings after a model-only change while preserving unrelated steering", async () => {
  const secondRequest = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let mainCalls = 0;
  let reviews = 0;
  let userSteeringObserved = false;
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "advisor_report")) {
        reviews++;
        return response(
          model,
          toolCall(
            "advisor_report",
            reviews === 1
              ? { severity: "blocker", message: "Finding from the child's previous model" }
              : { severity: "none" },
          ),
          options,
        );
      }
      mainCalls++;
      if (JSON.stringify(context.messages).includes("Keep this unrelated user steer"))
        userSteeringObserved = true;
      if (mainCalls === 1)
        return response(
          model,
          toolCall("read", { path: "/missing-advisor-fixture-file" }),
          options,
        );
      if (mainCalls === 2) {
        secondRequest.resolve();
        return response(model, reply("Done"), options, releaseSecond.promise);
      }
      return response(model, reply("Done"), options);
    },
  };
  // The root extension is disabled: the explicit observer has the child owner's lifecycle.
  const { session, cleanupGates } = await fixture({ enabled: false });
  cleanupGates.push(releaseSecond.resolve);
  session.setThinkingLevel("medium");
  const observer = new AdvisorObserver(
    session,
    {
      ...readAdvisorSettings(session).settings,
      enabled: true,
      catchUpThreshold: "off",
      maxCorrectiveTurns: 0,
    },
    "owned-child",
  );
  afterEach(async () => {
    releaseSecond.resolve();
    await observer.dispose();
  });
  observer.beforeTask();
  const pending = session.prompt("Owned child task");
  await secondRequest.promise;
  await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  await expect.poll(() => observer.status.state).toBe("armed");
  await session.steer("Keep this unrelated user steer");
  const alternate = session.modelRuntime.getModel("observer-fixture", "alternate");
  if (!alternate) throw new Error("Missing alternate fixture model");
  const previousThinking = session.thinkingLevel;
  await session.setModel(alternate);
  expect(session.thinkingLevel).toBe(previousThinking);
  releaseSecond.resolve();
  await pending;
  await observer.finishOwnedTurn();
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-advisor",
    ),
  ).toEqual([]);
  expect(userSteeringObserved).toBe(true);
  expect(mainCalls).toBe(3);
});
