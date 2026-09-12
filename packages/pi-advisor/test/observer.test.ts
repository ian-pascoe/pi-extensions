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
  createAgentSessionServices,
  createAgentSessionFromServices,
  AgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import "./fixtures/observer-extension.js";
import { createSdkHarness } from "../../pi-context-management/test/sdk-harness.js";
import { AdvisorObserver } from "../src/advisor-observer.js";
import { readAdvisorSettings } from "../src/advisor-settings.js";

async function activeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "advisor-observer-"));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./fixtures/observer-extension.ts", import.meta.url)),
      ],
    },
  });
  const model = modelRuntime.getModel("observer-fixture", "model");
  if (!model) throw new Error("Missing fixture model");
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("No replacement");
  });
  await runtime.session.bindExtensions({ mode: "print" });
  afterEach(async () => {
    await runtime.session.abort();
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return runtime.session;
}

it.each(["none", "blocker"] as const)(
  "reviews %s without changing the observed request prefix or restarting headless completion",
  async (severity) => {
    const main: Context[] = [];
    const reviews: Context[] = [];
    globalThis.advisorObserverTest = {
      stream(model, context) {
        const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
        (privateRole ? reviews : main).push(
          structuredClone({
            ...context,
            tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          }),
        );
        const stream = createAssistantMessageEventStream();
        const message = {
          ...fauxAssistantMessage("Done"),
          model: model.id,
          provider: model.provider,
          api: model.api,
        };
        if (privateRole) {
          message.content = [
            {
              type: "toolCall",
              id: "report-1",
              name: "advisor_report",
              arguments:
                severity === "none"
                  ? { severity }
                  : { severity, message: "Completion lacks a verification run." },
            },
          ];
          message.stopReason = "toolUse";
        }
        queueMicrotask(() =>
          stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
        );
        return stream;
      },
    };
    const session = await activeFixture();
    const observer = new AdvisorObserver(
      session,
      { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: "off" },
      "headless-root",
    );
    globalThis.advisorObserverTest.settled = () => observer.settled();
    afterEach(() => observer.dispose());
    await session.prompt("Review this task, without changing it.");
    expect(observer.status.lastError).toBeNull();
    expect(observer.status).toMatchObject({
      state: "armed",
      backlog: 0,
      effectiveModel: "observer-fixture/model",
      effectiveThinkingLevel: "medium",
    });
    expect(reviews).toHaveLength(1);
    expect(main).toHaveLength(1);
    expect(main[0]?.messages).toHaveLength(1);
    expect(main[0]?.tools).not.toContainEqual(expect.objectContaining({ name: "advisor_report" }));
    expect(session.messages).toHaveLength(severity === "none" ? 2 : 3);
    if (severity === "blocker")
      expect(session.messages.at(-1)).toMatchObject({
        role: "custom",
        customType: "pi-advisor",
        display: true,
      });
  },
);

it("pauses on the independent review deadline without cancelling the observed agent", async () => {
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (context.tools?.some((tool) => tool.name === "advisor_report")) {
        options?.signal?.addEventListener(
          "abort",
          () => {
            stream.push({
              type: "error",
              reason: "aborted",
              error: { ...message, stopReason: "aborted" },
            });
          },
          { once: true },
        );
      } else queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    {
      ...readAdvisorSettings(session).settings,
      enabled: true,
      catchUpThreshold: 1,
      reviewTimeoutMs: 20,
    },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(() => observer.dispose());
  await session.prompt("Finish normally");
  expect(observer.status.state).toBe("paused");
  expect(observer.status.lastError).toMatch(/deadline/i);
  expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
});

it("enforces investigative calls independently of the catch-up setting", async () => {
  let calls = 0;
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      if (privateRole) {
        calls++;
        message.content = [
          {
            type: "toolCall",
            id: `read-${calls}`,
            name: "read",
            arguments: { path: "/no-advisor-test-file" },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    {
      ...readAdvisorSettings(session).settings,
      enabled: true,
      catchUpThreshold: "off",
      maxToolCalls: 1,
    },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(() => observer.dispose());
  await session.prompt("Finish normally");
  expect(observer.status.lastError).toMatch(/tool-call limit/);
  expect(calls).toBe(2);
  expect(session.messages).toHaveLength(2);
});

it("keeps configurable child correction and final reviews inside the owner await", async () => {
  let mainCalls = 0;
  let reviewCalls = 0;
  const parentFindings: string[] = [];
  const reviewPrompts: string[] = [];
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviewCalls++;
        reviewPrompts.push(JSON.stringify(context.messages.at(-1)));
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviewCalls}`,
            name: "advisor_report",
            arguments: { severity: "blocker", message: `Verify failure ${reviewCalls}.` },
          },
        ];
        message.stopReason = "toolUse";
      } else mainCalls++;
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    {
      ...readAdvisorSettings(session).settings,
      enabled: true,
      catchUpThreshold: "off",
      maxCorrectiveTurns: 2,
    },
    "owned-child",
    {
      onIntervention: (finding) => {
        parentFindings.push(finding.message);
      },
    },
  );
  afterEach(() => observer.dispose());
  observer.beforeTask();
  await session.prompt("Perform original child task");
  expect(mainCalls).toBe(1);
  await observer.finishOwnedTurn();
  expect(mainCalls).toBe(3);
  expect(reviewCalls).toBe(3);
  expect(parentFindings).toEqual(["Verify failure 1.", "Verify failure 2.", "Verify failure 3."]);
  expect(observer.status.backlog).toBe(0);
  expect(reviewPrompts[1]).toContain("Incremental update");
  expect(reviewPrompts[1]).not.toContain("Perform original child task");
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-advisor",
    ),
  ).toHaveLength(3);
});

it.each([
  {
    name: "format dedupe preserves distinct identifiers",
    reports: ["Check `foo_bar`.", "**Check foo_bar.**", "Check foobar."],
    severity: "blocker",
    count: 2,
  },
  {
    name: "concerns wait three completed turns and are reevaluated",
    reports: ["Fix first.", "Fix second.", "", "Fix second."],
    severity: "concern",
    count: 2,
  },
])("$name", async ({ reports, severity, count }) => {
  let index = 0;
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        const finding = reports[index++];
        message.content = [
          {
            type: "toolCall",
            id: `report-${index}`,
            name: "advisor_report",
            arguments: finding ? { severity, message: finding } : { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: "off" },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(() => observer.dispose());
  for (let turn = 0; turn < reports.length; turn++) await session.prompt(`Task step ${turn}`);
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-advisor",
    ),
  ).toHaveLength(count);
});

it("disabling an in-flight review discards its late finding", async () => {
  const started = Promise.withResolvers<void>();
  let release = () => {};
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        message.content = [
          {
            type: "toolCall",
            id: "late",
            name: "advisor_report",
            arguments: { severity: "blocker", message: "Stale advice" },
          },
        ];
        message.stopReason = "toolUse";
        release = () => stream.push({ type: "done", reason: "toolUse", message });
        started.resolve();
      } else queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  };
  const session = await activeFixture();
  const config = {
    ...readAdvisorSettings(session).settings,
    enabled: true,
    catchUpThreshold: "off" as const,
  };
  const observer = new AdvisorObserver(session, config, "owned-child");
  afterEach(() => observer.dispose());
  await session.prompt("Continue");
  await started.promise;
  observer.configure({ ...config, enabled: false });
  release();
  await observer.finishOwnedTurn();
  await observer.dispose();
  expect(session.messages).toHaveLength(2);
  expect(observer.status.state).toBe("disabled");
});

it.each(["aborted", "error"] as const)(
  "preserves blockers after an %s ending without restarting the child",
  async (ending) => {
    let mainCalls = 0;
    globalThis.advisorObserverTest = {
      stream(model, context) {
        const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
        const stream = createAssistantMessageEventStream();
        const message = {
          ...fauxAssistantMessage("Done"),
          model: model.id,
          provider: model.provider,
          api: model.api,
        };
        if (privateRole) {
          message.content = [
            {
              type: "toolCall",
              id: "report",
              name: "advisor_report",
              arguments: { severity: "blocker", message: "Run verification." },
            },
          ];
          message.stopReason = "toolUse";
          queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
        } else {
          mainCalls++;
          queueMicrotask(() =>
            stream.push({
              type: "error",
              reason: ending,
              error: { ...message, stopReason: ending },
            }),
          );
        }
        return stream;
      },
    };
    const session = await activeFixture();
    const observer = new AdvisorObserver(
      session,
      { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: "off" },
      "owned-child",
    );
    afterEach(() => observer.dispose());
    observer.beforeTask();
    await session.prompt("Work");
    await observer.finishOwnedTurn();
    expect(mainCalls).toBe(1);
    expect(session.messages.at(-1)).toMatchObject({ role: "custom", customType: "pi-advisor" });
  },
);

it("stops unfinished headless review work at the separate 30-second drain ceiling", async () => {
  const started = Promise.withResolvers<void>();
  globalThis.advisorObserverTest = {
    stream(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (context.tools?.some((tool) => tool.name === "advisor_report")) {
        options?.signal?.addEventListener(
          "abort",
          () =>
            stream.push({
              type: "error",
              reason: "aborted",
              error: { ...message, stopReason: "aborted" },
            }),
          { once: true },
        );
        started.resolve();
      } else queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: "off" },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(async () => {
    vi.useRealTimers();
    await observer.dispose();
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const prompt = session.prompt("Finish");
  await started.promise;
  await vi.advanceTimersByTimeAsync(30000);
  await prompt;
  expect(observer.status.backlog).toBe(0);
  expect(session.messages).toHaveLength(2);
});

it("coalesces backlog and releases threshold seven below seven, not only at zero", async () => {
  let mainCalls = 0;
  let reviews = 0;
  let first = () => {};
  let second = () => {};
  const eighth = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "advisor_report",
            arguments: { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
        const complete = () => stream.push({ type: "done", reason: "toolUse", message });
        if (reviews === 1) first = complete;
        else if (reviews === 2) {
          second = complete;
          secondStarted.resolve();
        } else queueMicrotask(complete);
      } else {
        mainCalls++;
        if (mainCalls < 8) {
          message.content = [
            {
              type: "toolCall",
              id: `main-${mainCalls}`,
              name: "read",
              arguments: { path: "/no-advisor-test-file" },
            },
          ];
          message.stopReason = "toolUse";
        } else eighth.resolve();
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          }),
        );
      }
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 7 },
    "owned-child",
  );
  afterEach(() => observer.dispose());
  const prompt = session.prompt("Run eight observed turns");
  await vi.waitFor(() => expect(observer.status.backlog).toBe(7));
  expect(mainCalls).toBe(7);
  expect(reviews).toBe(1);
  first();
  await eighth.promise;
  await secondStarted.promise;
  expect(mainCalls).toBe(8);
  expect(observer.status.backlog).toBeGreaterThan(0);
  second();
  await prompt;
  await observer.finishOwnedTurn();
  expect(observer.status.backlog).toBe(0);
  expect(reviews).toBe(3);
});

it("preserves exact ordered model tools, system prompt and unaffected history for a silent review", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  afterEach(() => vi.restoreAllMocks());
  const requests: Context[] = [];
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      if (!privateRole)
        requests.push(
          structuredClone({
            ...context,
            tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          }),
        );
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
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
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  await session.prompt("Same input");
  const baseline = structuredClone(session.messages);
  session.sessionManager.resetLeaf();
  session.agent.state.messages = [];
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1 },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(() => observer.dispose());
  await session.prompt("Same input");
  expect(requests).toHaveLength(2);
  expect(requests[1]?.tools).toEqual(requests[0]?.tools);
  expect(requests[1]?.systemPrompt).toEqual(requests[0]?.systemPrompt);
  expect(requests[1]?.messages).toEqual(requests[0]?.messages);
  expect(session.messages).toEqual(baseline);
});

it("keeps observed reasoning and native image attachments without base64 text expansion", async () => {
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
  let evidence: Context | undefined;
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        evidence = context;
        message.content = [
          {
            type: "toolCall",
            id: "report",
            name: "advisor_report",
            arguments: { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      } else
        message.content = [
          { type: "thinking", thinking: "Available observed reasoning" },
          { type: "text", text: "Done" },
        ];
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1 },
    "headless-root",
  );
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(() => observer.dispose());
  await session.prompt("Inspect image", {
    images: [{ type: "image", mimeType: "image/png", data: image }],
  });
  const user = evidence?.messages.find((message) => message.role === "user");
  expect(user?.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "image", data: image })]),
  );
  const text = JSON.stringify(
    Array.isArray(user?.content)
      ? user.content.filter((block) => block.type === "text")
      : user?.content,
  );
  expect(text).toContain("Available observed reasoning");
  expect(text).not.toContain(image);
});

it("preserves a captured model request when review configuration changes mid-turn", async () => {
  const started = Promise.withResolvers<void>();
  let release = () => {};
  let reviews = 0;
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: "report",
            name: "advisor_report",
            arguments: { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
        queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
      } else {
        release = () => stream.push({ type: "done", reason: "stop", message });
        started.resolve();
      }
      return stream;
    },
  };
  const session = await activeFixture();
  const config = { ...readAdvisorSettings(session).settings, enabled: true, catchUpThreshold: 1 };
  const observer = new AdvisorObserver(session, config, "headless-root");
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(() => observer.dispose());
  const prompt = session.prompt("Work");
  await started.promise;
  observer.configure({ ...config, prompt: "Changed reviewer priorities" });
  release();
  await prompt;
  expect(reviews).toBe(1);
  expect(observer.status.lastError).toBeNull();
});

it("restores the concern cooldown from the selected native branch after configuration changes", async () => {
  let reviews = 0;
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "advisor_report",
            arguments: {
              severity: "concern",
              message: reviews === 1 ? "First concern" : "Second concern",
            },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const config = {
    ...readAdvisorSettings(session).settings,
    enabled: true,
    catchUpThreshold: "off" as const,
  };
  const observer = new AdvisorObserver(session, config, "headless-root");
  globalThis.advisorObserverTest.settled = () => observer.settled();
  afterEach(() => observer.dispose());
  const findings = () =>
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-advisor",
    );
  await session.prompt("First");
  observer.configure({ ...config, prompt: "New priorities" });
  await session.prompt("Second");
  expect(findings()).toHaveLength(1);
  await session.prompt("Third");
  expect(findings()).toHaveLength(1);
  await session.prompt("Fourth");
  expect(findings()).toHaveLength(2);
});

it("does not finish a review on its report before native extension settlement", async () => {
  const atSettlement = Promise.withResolvers<void>();
  const continueSettlement = Promise.withResolvers<void>();
  globalThis.advisorObserverTest = {
    privateSettled: async () => {
      atSettlement.resolve();
      await continueSettlement.promise;
    },
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        message.content = [
          {
            type: "toolCall",
            id: "report",
            name: "advisor_report",
            arguments: { severity: "blocker", message: "Verify this finding" },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
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
  afterEach(() => observer.dispose());
  await session.prompt("Finish task");
  await atSettlement.promise;
  expect(observer.status.backlog).toBe(1);
  expect(session.messages).toHaveLength(2);
  continueSettlement.resolve();
  await observer.finishOwnedTurn();
  expect(observer.status.backlog).toBe(0);
  expect(session.messages.at(-1)).toMatchObject({ customType: "pi-advisor" });
});

it("bounds late interactive corrections across native before_agent_start hooks", async () => {
  let mainCalls = 0;
  let reviews = 0;
  globalThis.advisorObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "advisor_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "advisor_report",
            arguments:
              reviews < 5
                ? { severity: "blocker", message: `Blocker ${reviews}` }
                : { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      } else mainCalls++;
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = new AdvisorObserver(
    session,
    {
      ...readAdvisorSettings(session).settings,
      enabled: true,
      catchUpThreshold: "off",
      maxCorrectiveTurns: 2,
    },
    "interactive",
  );
  afterEach(() => observer.dispose());
  globalThis.advisorObserverTest.beforeTask = () => observer.beforeTask();
  await session.prompt("Work");
  await vi.waitFor(() =>
    expect(
      session.messages.filter(
        (message) => message.role === "custom" && message.customType === "pi-advisor",
      ),
    ).toHaveLength(3),
  );
  expect(mainCalls).toBe(3);
  expect(observer.status.backlog).toBe(0);
});

it("disabled observation leaves the ordered native tools, prompt and conversation unchanged", async () => {
  const { session } = await createSdkHarness([]);
  const stream = session.agent.streamFunction;
  const tools = structuredClone(session.getAllTools());
  const prompt = session.systemPrompt;
  const messages = structuredClone(session.messages);
  const observer = new AdvisorObserver(
    session,
    readAdvisorSettings(session).settings,
    "headless-root",
  );
  afterEach(() => observer.dispose());
  await observer.settled();
  expect(observer.status).toMatchObject({
    state: "disabled",
    backlog: 0,
    cost: null,
    effectiveModel: "anthropic/claude-sonnet-4-5",
    effectiveThinkingLevel: "medium",
  });
  observer.configure({
    ...readAdvisorSettings(session).settings,
    model: "configured/model",
    thinkingLevel: "low",
  });
  expect(observer.status).toMatchObject({
    effectiveModel: "configured/model",
    effectiveThinkingLevel: "low",
  });
  expect(session.getAllTools()).toEqual(tools);
  expect(session.systemPrompt).toBe(prompt);
  expect(session.messages).toEqual(messages);
  const disposal = observer.dispose();
  expect(observer.dispose()).toBe(disposal);
  await disposal;
  expect(session.agent.streamFunction).toBe(stream);
});
