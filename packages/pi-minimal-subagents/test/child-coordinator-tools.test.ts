import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_MAX_SUBAGENT_DEPTH } from "../src/minimal-subagents-capabilities.js";
import { MinimalSubagentsCoordinator } from "../src/minimal-subagents-coordinator.js";
import { PiAgentSessionFactory } from "../src/minimal-subagents-sessions.js";
import { createCoordinatorToolSchemas } from "../src/minimal-subagents-tool-schemas.js";
import { createCoordinatorToolDefinitions } from "../src/minimal-subagents-tools.js";
import { OFFLINE_TEST_MODEL, writeOfflineProvider } from "./fixtures/offline-provider.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

const ALL_SIX = [
  "read",
  "subagent",
  "agent_message",
  "subagent_wait",
  "subagent_status",
  "subagent_cancel",
  "subagent_delete",
];

/** Real child sessions against an offline provider, mirroring production coordinator-tool grants. */
function createFixture(maxSubagentDepth = DEFAULT_MAX_SUBAGENT_DEPTH) {
  const directory = mkdtempSync(join(tmpdir(), "minimal-subagents-child-coordinator-"));
  temporaryDirectories.push(directory);
  const { readRequests } = writeOfflineProvider(directory);
  const schemas = createCoordinatorToolSchemas(["provider/model"]);
  const createCoordinator = () => {
    const coordinator: MinimalSubagentsCoordinator = new MinimalSubagentsCoordinator({
      sessions: new PiAgentSessionFactory({
        cwd: directory,
        agentDir: directory,
        sessionDir: directory,
        rootSessionId: "root",
        extensionEntrypoint: join(directory, "minimal-subagents.ts"),
        models: [OFFLINE_TEST_MODEL],
        eligibleModelIds: ["provider/model"],
        modelScopeRestricted: false,
        availableToolNames: ["read"],
        projectTrusted: true,
        maxSubagentDepth,
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
      maxSubagentDepth,
    });
    return coordinator;
  };
  /** Spawn one root child and wait for its first turn. */
  const runChild = async (
    coordinator: MinimalSubagentsCoordinator,
    agentId: string,
    delegation: "none" | "fanout",
  ) => {
    await coordinator.spawn(
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
    await coordinator.wait("root", agentId, 10_000);
  };
  /** Ordered tool definitions and system prompt of one recorded request. */
  const requestAt = (index: number) => {
    const request = readRequests().at(index);
    if (!request) throw new Error(`No model request at ${index}`);
    return {
      tools: getCurrentTools(request.messages),
      systemPrompt: getCurrentSystemPrompt(request.messages),
    };
  };
  /** Reopen children from a snapshot in a fresh coordinator and send one more message. */
  const restoreAndMessage = async (
    coordinator: MinimalSubagentsCoordinator,
    agentId: string,
  ): Promise<MinimalSubagentsCoordinator> => {
    const snapshot = coordinator.snapshot();
    await coordinator.shutdown();
    const restored = createCoordinator();
    await restored.restore(snapshot);
    const requestsBefore = readRequests().length;
    const sent = await restored.sendAgentMessage(
      "root",
      { agent_id: agentId, message: "Again" },
      "root:restored",
    );
    // A failed restore would leave the original request as the latest, passing vacuously.
    expect(sent.disposition).toBe("started-turn");
    await restored.waitForSettledOperations();
    expect(readRequests()).toHaveLength(requestsBefore + 1);
    return restored;
  };
  return { directory, createCoordinator, runChild, requestAt, restoreAndMessage };
}

test("sends children that cannot spawn only agent_message while fanout children keep all six coordinator tools", async () => {
  const { createCoordinator, runChild, requestAt, restoreAndMessage } = createFixture();
  let coordinator = createCoordinator();
  try {
    await runChild(coordinator, "leaf", "none");
    await runChild(coordinator, "lead", "fanout");
    const leaf = requestAt(0);
    const lead = requestAt(1);
    expect(leaf.tools.map((tool) => tool.name)).toEqual(["read", "agent_message"]);
    expect(lead.tools.map((tool) => tool.name)).toEqual(ALL_SIX);
    // The shared agent_message definition is byte-equal in both modes.
    expect(JSON.stringify(leaf.tools.find((tool) => tool.name === "agent_message"))).toBe(
      JSON.stringify(lead.tools.find((tool) => tool.name === "agent_message")),
    );
    expect(leaf.systemPrompt).toContain("Coordinator tools support only agent_message");
    expect(lead.systemPrompt).toContain("Coordinator tools support subagent, agent_message");

    // Restoration derives the grant from the persisted contract, so a reopened child matches.
    coordinator = await restoreAndMessage(coordinator, "leaf");
    const restored = requestAt(-1);
    expect(JSON.stringify(restored.tools)).toBe(JSON.stringify(leaf.tools));
    expect(restored.systemPrompt).toBe(leaf.systemPrompt);
  } finally {
    await coordinator.shutdown();
  }
}, 30_000);

test("treats a fanout child at the depth cap like a child that cannot spawn", async () => {
  const { createCoordinator, runChild, requestAt } = createFixture(1);
  const coordinator = createCoordinator();
  try {
    await runChild(coordinator, "capped", "fanout");
    const capped = requestAt(0);
    expect(capped.tools.map((tool) => tool.name)).toEqual(["read", "agent_message"]);
    expect(capped.systemPrompt).toContain("Coordinator tools support only agent_message");
  } finally {
    await coordinator.shutdown();
  }
}, 30_000);

test("restores a child whose history declared the legacy three-tool set with only agent_message", async () => {
  const { createCoordinator, runChild, requestAt, restoreAndMessage } = createFixture();
  const coordinator = createCoordinator();
  let restored: MinimalSubagentsCoordinator | undefined;
  try {
    await runChild(coordinator, "legacy", "none");
    const original = requestAt(0);
    const sessionFile = coordinator.snapshot().agents[0]?.session_file;
    if (!sessionFile) throw new Error("Expected a persisted child session file");
    // Rewrite the child's declared tools as the previous release recorded them.
    const template = original.tools.find((tool) => tool.name === "agent_message");
    if (!template) throw new Error("Expected the agent_message definition");
    const legacyTools = ["agent_message", "subagent_wait", "subagent_status"].map((name) => ({
      ...template,
      name,
    }));
    let rewrote = false;
    const lines = readFileSync(sessionFile, "utf8")
      .split("\n")
      .map((line) => {
        if (!line.includes('"toolsAdded"')) return line;
        const entry = JSON.parse(line);
        if (entry.message?.role !== "system") return line;
        rewrote = true;
        entry.message.toolsAdded = [
          ...entry.message.toolsAdded.filter(
            (tool: { name: string }) => tool.name !== "agent_message",
          ),
          ...legacyTools,
        ];
        return JSON.stringify(entry);
      });
    expect(rewrote).toBe(true);
    writeFileSync(sessionFile, lines.join("\n"));

    restored = await restoreAndMessage(coordinator, "legacy");
    const after = requestAt(-1);
    expect(after.tools.map((tool) => tool.name)).toEqual(["read", "agent_message"]);
  } finally {
    await (restored ?? coordinator).shutdown();
  }
}, 30_000);
