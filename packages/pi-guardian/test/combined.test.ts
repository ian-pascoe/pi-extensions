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

/** One Guardian request, by the role of the session that sent it. */
interface CombinedReview {
  role: "main" | "child";
  /** Every text block of the request's user message. */
  blocks: string[];
}

/**
 * A real root session running Minimal Subagents and Guardian, whose agent delegates deploying x
 * to a Child Agent and waits; the Child Agent then deploys x. Every review allows its call, the
 * root's with `rootAssessment`.
 */
async function delegateDeploy(
  setup: readonly string[],
  rootAssessment: Record<string, string> = { risk_level: "low", user_authorization: "high" },
  /** Then send the Child Agent "Also deploy y." with `agent_message` and wait again. */
  followUp = false,
) {
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
      guardian: { enabled: true, model: "guardian-combined/reviewer" },
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const reviews: CombinedReview[] = [];
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
        reviews.push({
          role,
          blocks: blocks.map((part) => (part.type === "text" ? part.text : "")),
        });
        message.content = [
          {
            type: "text",
            text: JSON.stringify({
              ...(role === "main"
                ? rootAssessment
                : { risk_level: "low", user_authorization: "high" }),
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
        else if (mainCalls === 2 || (followUp && mainCalls === 4))
          call("subagent_wait", { agent_id: "worker", timeout_ms: 10_000 });
        else if (followUp && mainCalls === 3)
          call("agent_message", { agent_id: "worker", message: "Also deploy y." });
      } else {
        const results = context.messages.flatMap((entry) =>
          entry.role === "toolResult" && entry.toolName === "deploy" ? [entry] : [],
        );
        const asked = JSON.stringify(context.messages).includes("Also deploy y.");
        const last = context.messages.at(-1);
        if (results.length === 0) call("deploy", { target: "x" });
        else if (asked && results.length === 1 && last?.role !== "toolResult")
          call("deploy", { target: "y" });
        else
          childResults.push(
            (results.at(-1)?.content ?? [])
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
          );
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
  for (const command of setup) await runtime.session.prompt(command);
  await runtime.session.prompt("Delegate deploying x and wait for the result.");
  const wait = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "subagent_wait",
  );
  expect(wait).toMatchObject({ isError: false });
  return { reviews, childResults, executed: globalThis.guardianCombinedTest.executed };
}

/** The labels of a review's evidence blocks, without the Reviewed Call. */
function labels(review: CombinedReview | undefined): string[] {
  return (review?.blocks ?? []).slice(0, -1).map((block) => block.split("\n", 1)[0] ?? "");
}

it("makes a real Minimal Subagents Child Agent follow its root's Guardian settings", async () => {
  // A root session override the child's own settings do not have.
  const { reviews, childResults, executed } = await delegateDeploy(["/guardian tool deploy deny"]);
  // The child's deploy was denied by the root's Tool Policy without a Guardian Review.
  expect(executed).toEqual([]);
  expect(childResults).toEqual([expect.stringMatching(/denied by Guardian's Tool Policy/)]);
  expect(reviews.some((review) => review.role === "child")).toBe(false);
});

it("weighs a task the root's Guardian approved as Trusted Evidence in the Child Agent", async () => {
  const { reviews, executed } = await delegateDeploy([]);
  expect(executed).toEqual(["child:deploy:x"]);
  // The root's Guardian reviewed the delegating `subagent` call.
  const root = reviews.find((review) => review.role === "main");
  expect(root?.blocks.at(-1)).toContain("Tool: subagent");
  const child = reviews.find((review) => review.role === "child");
  expect(labels(child)).toEqual([
    "Evidence (TRUSTED, origin: rootUser):",
    "Evidence (TRUSTED, origin: approvedDelegation):",
  ]);
  const delegation = JSON.parse(JSON.parse(child?.blocks[1]?.split("\n")[1] ?? "{}").content);
  expect(delegation.approvedDelegation).toMatchObject({
    writtenBy: 'the delegating agent "root", not the user',
    approval: expect.stringContaining("(risk low, user authorization high)"),
    text: "Deploy x.",
  });
});

it("weighs a Coordination Message the root's Guardian approved as Trusted Evidence", async () => {
  const { reviews, executed } = await delegateDeploy([], undefined, true);
  expect(executed).toEqual(["child:deploy:x", "child:deploy:y"]);
  expect(reviews.filter((review) => review.role === "main").map((r) => r.blocks.at(-1))).toEqual([
    expect.stringContaining("Tool: subagent"),
    expect.stringContaining("Tool: agent_message"),
  ]);
  const second = reviews.filter((review) => review.role === "child")[1];
  const trusted = (second?.blocks ?? []).filter((block) =>
    block.startsWith("Evidence (TRUSTED, origin: approvedDelegation):"),
  );
  expect(
    trusted.map((block) => JSON.parse(JSON.parse(block.split("\n")[1] ?? "{}").content)),
  ).toEqual([
    { approvedDelegation: expect.objectContaining({ text: "Deploy x." }) },
    {
      approvedDelegation: expect.objectContaining({
        approval: expect.stringContaining("delegating agent_message call"),
        text: "Also deploy y.",
      }),
    },
  ]);
});

it("keeps a task untrusted when the root's Guardian allowed it without user authorization", async () => {
  const { reviews, executed } = await delegateDeploy([], {
    risk_level: "medium",
    user_authorization: "unknown",
  });
  expect(executed).toEqual(["child:deploy:x"]);
  expect(labels(reviews.find((review) => review.role === "child"))).toEqual([
    "Evidence (TRUSTED, origin: rootUser):",
    "Evidence (UNTRUSTED, origin: user):",
  ]);
});

it("keeps a task untrusted when an allow Tool Policy let the delegation run unreviewed", async () => {
  const { reviews, executed } = await delegateDeploy(["/guardian tool subagent allow"]);
  expect(executed).toEqual(["child:deploy:x"]);
  expect(reviews.some((review) => review.role === "main")).toBe(false);
  expect(labels(reviews.find((review) => review.role === "child"))).toEqual([
    "Evidence (TRUSTED, origin: rootUser):",
    "Evidence (UNTRUSTED, origin: user):",
  ]);
});
