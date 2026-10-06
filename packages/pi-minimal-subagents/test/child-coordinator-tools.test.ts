import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools, type Message, type Model } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { MinimalSubagentsCoordinator } from "../src/minimal-subagents-coordinator.js";
import { PiAgentSessionFactory } from "../src/minimal-subagents-sessions.js";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import { createCoordinatorToolDefinitions } from "../src/minimal-subagents-tools.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

const TEST_MODEL: Model<"openai-completions"> = {
  id: "model",
  name: "Child coordinator tools test model",
  api: "openai-completions",
  provider: "provider",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

it("sends children that cannot spawn only agent_message while fanout children keep all six coordinator tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-child-coordinator-"));
  temporaryDirectories.push(directory);
  const requestsPath = join(directory, "requests.jsonl");
  const providerPath = join(directory, "offline-provider.ts");
  writeFileSync(requestsPath, "");
  writeFileSync(
    providerPath,
    `import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  pi.registerProvider("provider", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "offline-test-key",
    models: [${JSON.stringify(TEST_MODEL)}],
    streamSimple(model, context) {
      appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(context) + "\\n");
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: ${JSON.stringify(ZERO_USAGE)},
        content: [{ type: "text", text: "done" }], stopReason: "stop",
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  });
}
`,
  );
  writeFileSync(
    join(directory, "settings.json"),
    JSON.stringify({
      extensions: [providerPath],
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const schemas = createCoordinatorToolSchemas(["provider/model"]);
  const createCoordinator = () => {
    const coordinator: MinimalSubagentsCoordinator = new MinimalSubagentsCoordinator({
      sessions: new PiAgentSessionFactory({
        cwd: directory,
        agentDir: directory,
        sessionDir: directory,
        rootSessionId: "root",
        extensionEntrypoint: join(directory, "minimal-subagents.ts"),
        models: [TEST_MODEL],
        eligibleModelIds: ["provider/model"],
        modelScopeRestricted: false,
        availableToolNames: ["read"],
        projectTrusted: true,
        // Mirrors production: only agents that may still spawn get the fanout tools.
        getCoordinatorTools: (callerId) =>
          createCoordinatorToolDefinitions({
            coordinator,
            callerId,
            allowFanoutTools: coordinator.canAgentSpawn(callerId),
            schemas,
            captureCaller: () => {
              throw new Error("Children must not spawn in this test");
            },
          }),
      }),
      registry: { rootSessionId: "root", append: () => undefined },
      root: {
        queueCoordinatorMessage: async () => undefined,
        isIdle: () => true,
        hasDeliveryEvidence: () => false,
      },
      automaticDeliveryGraceMs: 0,
    });
    return coordinator;
  };
  let coordinator = createCoordinator();
  const spawn = (agentId: string, delegation: "none" | "fanout") =>
    coordinator.spawn(
      "root",
      { agent_id: agentId, task: "Say done", tools: "read", delegation, project_context: "omit" },
      {
        messages: [],
        model: "provider/model",
        thinkingLevel: "medium",
        ordinaryTools: ["read"],
        capabilityCeiling: ["read"],
        spawnEntryId: "entry",
      },
    );
  const requestTools = () =>
    // SAFETY: the offline provider above writes one JSON-serialized Context per request.
    (
      readFileSync(requestsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as { messages: Message[] }[]
    ).map((request) => getCurrentTools(request.messages));
  try {
    await spawn("leaf", "none");
    await coordinator.wait("root", "leaf", 10_000);
    await spawn("lead", "fanout");
    await coordinator.wait("root", "lead", 10_000);
    const [leaf, lead] = requestTools();
    expect(leaf?.map((tool) => tool.name)).toEqual(["read", "agent_message"]);
    expect(lead?.map((tool) => tool.name)).toEqual([
      "read",
      "subagent",
      "agent_message",
      "subagent_wait",
      "subagent_status",
      "subagent_cancel",
      "subagent_delete",
    ]);
    // The shared agent_message definition is byte-equal in both modes.
    expect(JSON.stringify(leaf?.find((tool) => tool.name === "agent_message"))).toBe(
      JSON.stringify(lead?.find((tool) => tool.name === "agent_message")),
    );

    // Restoration derives the grant from the persisted contract, so a reopened child matches.
    const snapshot = coordinator.snapshot();
    await coordinator.shutdown();
    coordinator = createCoordinator();
    await coordinator.restore(snapshot);
    await coordinator.sendAgentMessage(
      "root",
      { agent_id: "leaf", message: "Again" },
      "root:restored",
    );
    await coordinator.waitForSettledOperations();
    const restored = requestTools().at(-1);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(leaf));
  } finally {
    await coordinator.shutdown();
  }
}, 30_000);
