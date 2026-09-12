import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAdvisorSession, disposeAdvisorSession } from "../src/advisor-session.js";
import { readAdvisorSettings } from "../src/advisor-settings.js";
import { reply, toolCall, overflow } from "../../pi-context-management/test/sdk-harness.js";
import "./fixtures/coexistence-extension.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "advisor-coexistence-"));
  const responses: Array<AssistantMessage | Promise<AssistantMessage>> = [];
  const requests: Context[] = [];
  globalThis.advisorCoexistenceStream = (model, context) => {
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
    const response = responses.shift();
    if (!response)
      throw new Error("Unexpected model request, including accidental native summarization");
    const stream = createAssistantMessageEventStream();
    void Promise.resolve(response).then((next) => {
      const message = { ...next, provider: model.provider, model: model.id, api: model.api };
      const reason = message.stopReason;
      if (reason === "pending") throw new Error("Script requires a complete response");
      if (reason === "error" || reason === "aborted")
        stream.push({ type: "error", reason, error: message });
      else stream.push({ type: "done", reason, message });
    });
    return stream;
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
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 512 },
      retry: { enabled: false },
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./fixtures/coexistence-extension.ts", import.meta.url)),
        fileURLToPath(new URL("../../pi-context-management/src/index.ts", import.meta.url)),
      ],
    },
  });
  const model = modelRuntime.getModel("advisor-coexistence", "model");
  if (!model) throw new Error("Offline model missing");
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(directory, join(directory, "sessions")),
  });
  const observed = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("No replacement");
  });
  await observed.session.bindExtensions({ mode: "print" });
  const config = readAdvisorSettings(observed.session).settings;
  const advisor = await createAdvisorSession(observed.session, {
    config: {
      ...config,
      allowedTools: [
        ...config.allowedTools,
        "context_notes",
        "context_history",
        "context_rollover",
      ],
    },
    adviceTool: defineTool({
      name: "advisor_report",
      label: "Report",
      description: "Finish the Review",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "Done" }], details: {}, terminate: true };
      },
    }),
  });
  afterEach(async () => {
    await disposeAdvisorSession(advisor);
    await observed.session.abort();
    await observed.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { observed: observed.session, advisor, requests, responses };
}

it("keeps private Notes and History across durable Rollover and rejects observed references", async () => {
  const f = await fixture();
  f.responses.push(
    toolCall("context_notes", { action: "write", name: "Observed", content: "OBSERVED-SECRET" }),
    reply("Observed answer"),
  );
  await f.observed.prompt("Observed private task");
  const original = structuredClone(f.observed.sessionManager.getBranch());
  const observedEntry = original.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (!observedEntry) throw new Error("Missing observed user entry");
  f.responses.push(
    toolCall(
      "context_history",
      { action: "read", ref: `context:${f.observed.sessionId}:${observedEntry.id}` },
      "foreign",
    ),
    toolCall("context_notes", { action: "list" }, "notes-before"),
    toolCall(
      "context_notes",
      { action: "write", name: "Private", content: "ADVISOR-ONLY" },
      "write-private",
    ),
    toolCall(
      "context_rollover",
      { handoff: "Continue the private review using the Private Note." },
      "roll",
    ),
    toolCall("context_notes", { action: "read", name: "Private" }, "read-private"),
    toolCall(
      "context_history",
      { action: "search", query: "PRIVATE-REVIEW-EVIDENCE" },
      "own-history",
    ),
    toolCall("advisor_report", {}, "report"),
  );
  await f.advisor.session.prompt("PRIVATE-REVIEW-EVIDENCE " + "history ".repeat(3000));
  const branch = f.advisor.session.sessionManager.getBranch();
  const results = branch.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
  );
  expect(results.find((result) => result.toolCallId === "foreign")).toMatchObject({
    isError: true,
  });
  expect(JSON.stringify(results.find((result) => result.toolCallId === "foreign"))).toMatch(
    /source session|not found/i,
  );
  expect(
    JSON.stringify(results.find((result) => result.toolCallId === "notes-before")),
  ).not.toContain("Observed");
  expect(JSON.stringify(results.find((result) => result.toolCallId === "read-private"))).toContain(
    "ADVISOR-ONLY",
  );
  expect(JSON.stringify(results.find((result) => result.toolCallId === "own-history"))).toContain(
    "PRIVATE-REVIEW-EVIDENCE",
  );
  expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(1);
  const file = f.advisor.session.sessionFile;
  if (!file) throw new Error("Private journal missing");
  expect(SessionManager.open(file).buildSessionContext().messages).toEqual(
    f.advisor.session.messages,
  );
  expect(f.observed.sessionManager.getBranch()).toEqual(original);
  expect(f.responses).toEqual([]);
});

it.each(["threshold", "overflow"] as const)(
  "settles private native %s recovery before returning and shuts inherited hooks down",
  async (reason) => {
    const f = await fixture();
    const final = Promise.withResolvers<AssistantMessage>();
    // Release a held external response before native shutdown even if an assertion fails.
    afterEach(() => {
      final.resolve(reply("Released"));
    });
    if (reason === "threshold")
      f.responses.push(
        reply("Early answer is not completion", 200000),
        toolCall("context_notes", { action: "write", name: "Progress", content: "Prepared state" }),
        toolCall("context_rollover", { handoff: "Finish the review after the checkpoint." }),
        final.promise,
      );
    else {
      f.responses.push(reply("Ready"));
      await f.advisor.session.prompt("Initial private history " + "history ".repeat(3000));
      f.responses.push(overflow(), final.promise);
    }
    let settled = false;
    const pending = f.advisor.session
      .prompt("Continue private review " + "history ".repeat(3000))
      .then(() => {
        settled = true;
      });
    const expected = reason === "threshold" ? 4 : 3;
    await expect.poll(() => f.requests.length).toBe(expected);
    expect(settled).toBe(false);
    expect(
      f.advisor.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    if (reason === "threshold")
      expect(JSON.stringify(f.requests[1])).toContain("Prepare a Context Rollover");
    else expect(JSON.stringify(f.requests.at(-1))).not.toContain("PROVIDER-FAILED-RESPONSE");
    final.resolve(fauxAssistantMessage("Review genuinely complete"));
    await pending;
    expect(f.advisor.session.messages).toEqual(
      f.advisor.session.sessionManager.buildSessionContext().messages,
    );
    const file = f.advisor.session.sessionFile;
    if (!file) throw new Error("Private journal missing");
    expect(SessionManager.open(file).buildSessionContext().messages).toEqual(
      f.advisor.session.messages,
    );
    await disposeAdvisorSession(f.advisor);
    expect(f.advisor.session.sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({
        type: "custom",
        customType: "advisor-coexistence-shutdown",
        data: { stopped: true },
      }),
    );
    expect(f.observed.messages).toEqual([]);
    expect(f.responses).toEqual([]);
  },
);
