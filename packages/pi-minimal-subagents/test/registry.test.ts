import { describe, expect, it } from "vitest";
import {
  createRegistryEvent,
  REGISTRY_ENTRY_TYPE,
  replayRegistryEntries,
} from "../src/minimal-subagents-registry.js";
import type { PersistedAgent, PersistedDelivery } from "../src/minimal-subagents-types.js";

function persistedAgent(agentId = "child"): PersistedAgent {
  return {
    agent_id: agentId,
    friendly_id: agentId,
    parent_id: "root",
    created_at: "2026-01-01T00:00:00.000Z",
    spawn_entry_id: "entry-1",
    launch_contract: {
      session_context: "inherit",
      project_context: "inherit",
      model: "provider/model",
      thinking_level: "medium",
      tools: "read",
      ordinary_tools: ["read"],
    },
    capability_ceiling: ["read"],
    availability: "available",
    missing_dependencies: [],
    recent_messages: [],
  };
}

const customEntry = (data: unknown) => ({
  type: "custom",
  customType: REGISTRY_ENTRY_TYPE,
  data,
});

describe("minimal subagents registry", () => {
  it("replays agent, turn, delivery, and tombstone events for the owning root only", () => {
    const agent = persistedAgent();
    const delivery: PersistedDelivery = {
      source_agent_id: "child",
      source_turn_id: "turn-1",
      destination_agent_id: "root",
      path: "message",
      settled: false,
    };
    const events = [
      createRegistryEvent("other-root", "agent-created", { agent: persistedAgent("ignored") }),
      createRegistryEvent("root-1", "agent-created", { agent }),
      createRegistryEvent("root-1", "turn-started", {
        agent_id: "child",
        turn_id: "turn-1",
        started_at: "2026-01-01T00:00:01.000Z",
      }),
      createRegistryEvent("root-1", "turn-settled", {
        result: { agent_id: "child", turn_id: "turn-1", status: "completed", output: "done" },
      }),
      createRegistryEvent("root-1", "delivery-pending", { delivery }),
      createRegistryEvent("root-1", "delivery-settled", {
        source_agent_id: "child",
        source_turn_id: "turn-1",
      }),
      createRegistryEvent("root-1", "agent-deleted", { agent_ids: ["child"] }),
    ].map(customEntry);

    expect(replayRegistryEntries(events, "root-1")).toEqual({
      agents: [],
      tombstones: ["child"],
      deliveries: [{ ...delivery, settled: true, error: undefined }],
    });
  });

  it("starts at the latest checkpoint and returns clones isolated from checkpoint input", () => {
    const checkpoint = {
      agents: [persistedAgent("kept")],
      tombstones: ["old"],
      deliveries: [],
    };
    const entries = [
      customEntry(createRegistryEvent("root", "agent-created", { agent: persistedAgent("stale") })),
      customEntry(createRegistryEvent("root", "checkpoint", { snapshot: checkpoint })),
      customEntry(createRegistryEvent("root", "agent-created", { agent: persistedAgent("new") })),
    ];
    const result = replayRegistryEntries(entries, "root");
    expect(result.agents.map((agent) => agent.agent_id)).toEqual(["kept", "new"]);
    result.agents[0]!.friendly_id = "mutated";
    expect(checkpoint.agents[0]!.friendly_id).toBe("kept");
  });
});
