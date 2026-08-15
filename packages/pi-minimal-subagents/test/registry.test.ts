import type { JsonValue } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COORDINATOR_TOOL_NAMES } from "../src/minimal-subagents-capabilities.js";
import {
  createRegistryEvent,
  parseRegistryEvent,
  REGISTRY_ENTRY_TYPE,
  replayRegistryEntries,
  type RegistryReplayDiagnostic,
} from "../src/minimal-subagents-registry.js";
import type { PersistedAgent, PersistedDelivery } from "../src/minimal-subagents-types.js";

function persistedAgent(agentId = "child"): PersistedAgent {
  return {
    agent_id: agentId,
    friendly_id: agentId.split(".").at(-1) ?? agentId,
    parent_id: "root",
    created_at: "2026-01-01T00:00:00.000Z",
    spawn_entry_id: "entry-1",
    session_file: `/sessions/${agentId}.jsonl`,
    session_id: `session-${agentId}`,
    session_leaf_id: `leaf-${agentId}`,
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

const completedResult = (agentId: string, turnId: string) => ({
  agent_id: agentId,
  turn_id: turnId,
  status: "completed" as const,
  output: "done",
});

const customEntry = <TData>(data: TData) => ({
  type: "custom",
  customType: REGISTRY_ENTRY_TYPE,
  data,
});

describe("minimal subagents registry", () => {
  it("replays agent, turn, delivery, and tombstone events for the owning root only", () => {
    const agent = persistedAgent();
    const delivery: PersistedDelivery = {
      source_agent_id: "child",
      source_turn_id: "child:turn-1",
      destination_agent_id: "root",
      path: "message",
      settled: false,
      sequence: 1,
      result: completedResult("child", "child:turn-1"),
    };
    const events = [
      createRegistryEvent("other-root", "agent-created", { agent: persistedAgent("ignored") }),
      createRegistryEvent("root-1", "agent-created", { agent }),
      createRegistryEvent("root-1", "turn-started", {
        agent_id: "child",
        turn_id: "child:turn-1",
        started_at: "2026-01-01T00:00:01.000Z",
      }),
      createRegistryEvent("root-1", "turn-settled", {
        result: completedResult("child", "child:turn-1"),
      }),
      createRegistryEvent("root-1", "delivery-pending", { delivery }),
      createRegistryEvent("root-1", "delivery-settled", {
        source_agent_id: "child",
        source_turn_id: "child:turn-1",
      }),
      createRegistryEvent("root-1", "agent-deleted", { agent_ids: ["child"] }),
    ].map(customEntry);

    expect(replayRegistryEntries(events, "root-1")).toEqual({
      agents: [],
      tombstones: ["child"],
      deliveries: [],
      next_delivery_sequence: 2,
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

  it("skips malformed events and falls back from a malformed latest checkpoint", () => {
    const entries = [
      customEntry(
        createRegistryEvent("root", "checkpoint", {
          snapshot: { agents: [persistedAgent("kept")], tombstones: [], deliveries: [] },
        }),
      ),
      customEntry({
        version: 1,
        root_session_id: "root",
        timestamp: "2026-01-01T00:00:00.000Z",
        event: "agent-created",
      }),
      customEntry({
        version: 1,
        root_session_id: "root",
        timestamp: "2026-01-01T00:00:01.000Z",
        event: "checkpoint",
        snapshot: { broken: true },
      }),
      customEntry(createRegistryEvent("root", "agent-created", { agent: persistedAgent("new") })),
    ];

    let invalidRecordCount = 0;
    let replayed!: ReturnType<typeof replayRegistryEntries>;
    expect(() => {
      replayed = replayRegistryEntries(entries, "root", (diagnostics) => {
        invalidRecordCount = diagnostics.length;
      });
    }).not.toThrow();
    expect(replayed.agents.map((agent) => agent.agent_id)).toEqual(["kept", "new"]);
    expect(invalidRecordCount).toBe(2);
  });

  it("writes Registry V2 while migrating owned V1 events into the V2 replay model", () => {
    const written = createRegistryEvent(
      "root",
      "agent-message-recorded",
      {
        agent_id: "child",
        message: { source_agent_id: "root", turn_id: "root:turn", content: "hello" },
        recorded_at: "2026-01-01T00:00:02.000Z",
      },
      "2026-01-01T00:00:03.000Z",
    );
    expect(written).toMatchObject({ version: 2, recorded_at: "2026-01-01T00:00:02.000Z" });

    const migrated = parseRegistryEvent(
      {
        version: 1,
        root_session_id: "root",
        timestamp: "2026-01-01T00:00:04.000Z",
        event: "agent-message-recorded",
        agent_id: "child",
        message: { source_agent_id: "root", turn_id: "root:turn", content: "legacy" },
      },
      "root",
    );
    expect(migrated).toMatchObject({
      version: 2,
      event: "agent-message-recorded",
      recorded_at: "2026-01-01T00:00:04.000Z",
    });
  });

  it("migrates a complete V1 checkpoint with legacy unsequenced terminal retention", () => {
    const agent = persistedAgent();
    agent.latest_result = completedResult("child", "child:legacy");
    agent.availability = "unavailable";
    agent.clone_error = "legacy clone failed";
    agent.missing_dependencies = ["legacy clone failed"];
    agent.session_file = undefined;
    agent.session_id = undefined;
    agent.session_leaf_id = "legacy-orphan-leaf";
    const legacyCheckpoint = {
      version: 1,
      root_session_id: "root",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "checkpoint",
      snapshot: {
        agents: [agent],
        tombstones: [],
        deliveries: [
          {
            source_agent_id: "child",
            source_turn_id: "child:legacy",
            destination_agent_id: "root",
            path: "wait",
            settled: false,
          },
          {
            source_agent_id: "child",
            source_turn_id: "child:settled-legacy",
            destination_agent_id: "root",
            path: "message",
            settled: true,
          },
        ],
      },
    };

    expect(replayRegistryEntries([customEntry(legacyCheckpoint)], "root")).toMatchObject({
      agents: [{ agent_id: "child", session_leaf_id: undefined }],
      deliveries: [
        {
          source_agent_id: "child",
          source_turn_id: "child:legacy",
          sequence: 1,
        },
      ],
      next_delivery_sequence: 2,
    });
  });

  it("parses every persisted optional and constrained field instead of accepting malformed wire data", () => {
    const agent = persistedAgent();
    const wireEvents: JsonValue[] = JSON.parse(
      JSON.stringify([
        {
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "checkpoint",
          snapshot: {
            agents: [
              {
                ...agent,
                launch_contract: { ...agent.launch_contract, thinking_level: "turbo" },
              },
            ],
            tombstones: [],
            deliveries: [],
          },
        },
        {
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "checkpoint",
          snapshot: { agents: [{ ...agent, task: 42 }], tombstones: [], deliveries: [] },
        },
        {
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "checkpoint",
          snapshot: {
            agents: [{ ...agent, launch_contract: { ...agent.launch_contract, tools: 42 } }],
            tombstones: [],
            deliveries: [],
          },
        },
        {
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "checkpoint",
          snapshot: {
            agents: [{ ...agent, active_turn_id: "child:orphan" }],
            tombstones: [],
            deliveries: [],
          },
        },
        {
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "checkpoint",
          snapshot: {
            agents: [{ ...agent, session_leaf_id: undefined }],
            tombstones: [],
            deliveries: [],
          },
        },
        {
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "checkpoint",
          snapshot: {
            agents: [
              {
                ...agent,
                latest_result: {
                  agent_id: "other",
                  turn_id: "other:turn",
                  status: "completed",
                  output: "wrong",
                  usage: { input: Number.NaN },
                },
              },
            ],
            tombstones: [],
            deliveries: [],
          },
        },
      ]),
    );

    for (const wireEvent of wireEvents) {
      expect(parseRegistryEvent(wireEvent, "root")).toBeUndefined();
    }
  });

  it("enforces persisted ordinary-tool ceilings and excludes every coordinator tool name", () => {
    const baseEvent = createRegistryEvent("root", "checkpoint", {
      snapshot: { agents: [persistedAgent()], tombstones: [], deliveries: [] },
    });
    const poisoners: Array<(agent: PersistedAgent) => void> = [
      (agent) => {
        agent.launch_contract.ordinary_tools = ["read", "write"];
        agent.capability_ceiling = ["read"];
      },
      (agent) => {
        agent.launch_contract.ordinary_tools = ["read"];
        agent.capability_ceiling = ["read", "bash"];
      },
      ...COORDINATOR_TOOL_NAMES.flatMap((coordinatorToolName) => [
        (agent: PersistedAgent) => {
          agent.launch_contract.ordinary_tools = [coordinatorToolName];
          agent.capability_ceiling = [coordinatorToolName];
        },
        (agent: PersistedAgent) => {
          agent.capability_ceiling = ["read", coordinatorToolName];
        },
        (agent: PersistedAgent) => {
          agent.launch_contract.tools = [coordinatorToolName];
        },
      ]),
    ];

    for (const poison of poisoners) {
      const event = structuredClone(baseEvent);
      poison(event.snapshot.agents[0]!);
      expect(parseRegistryEvent(event, "root")).toBeUndefined();
    }
  });

  it("requires selected leaves for V2 sessions while allowing sessionless unavailable placeholders", () => {
    const available = persistedAgent();
    available.session_leaf_id = undefined;
    expect(
      parseRegistryEvent(
        createRegistryEvent("root", "checkpoint", {
          snapshot: { agents: [available], tombstones: [], deliveries: [] },
        }),
        "root",
      ),
    ).toBeUndefined();

    const placeholder = persistedAgent();
    placeholder.availability = "unavailable";
    placeholder.unavailable_reason = "fork clone failed";
    placeholder.clone_error = "fork clone failed";
    placeholder.session_file = undefined;
    placeholder.session_id = undefined;
    placeholder.session_leaf_id = undefined;
    expect(
      parseRegistryEvent(
        createRegistryEvent("root", "checkpoint", {
          snapshot: { agents: [placeholder], tombstones: [], deliveries: [] },
        }),
        "root",
      ),
    ).toBeDefined();

    const unavailableSession = persistedAgent();
    unavailableSession.availability = "unavailable";
    unavailableSession.session_leaf_id = undefined;
    expect(
      parseRegistryEvent(
        createRegistryEvent("root", "checkpoint", {
          snapshot: { agents: [unavailableSession], tombstones: [], deliveries: [] },
        }),
        "root",
      ),
    ).toBeUndefined();
  });

  it("rejects incomplete persisted fields and reports semantic diagnostic codes", () => {
    const validAgent = persistedAgent();
    const invalidThinkingCheckpoint = {
      version: 2,
      root_session_id: "root",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "checkpoint",
      snapshot: {
        agents: [
          {
            ...validAgent,
            launch_contract: {
              ...validAgent.launch_contract,
              thinking_level: "turbo",
            },
          },
        ],
        tombstones: [],
        deliveries: [],
        coordination_deliveries: [],
        wait_claimed_turns: [],
        next_delivery_sequence: 1,
      },
    };
    const wrongDelivery: PersistedDelivery = {
      source_agent_id: "child",
      source_turn_id: "child:turn-1",
      destination_agent_id: "unrelated",
      path: "wait",
      settled: false,
      sequence: 1,
      result: {
        agent_id: "different",
        turn_id: "child:turn-1",
        status: "completed",
        output: "wrong identity",
      },
    };
    const entries = [
      customEntry(invalidThinkingCheckpoint),
      customEntry({
        version: 2,
        root_session_id: "root",
        timestamp: "2026-01-01T00:00:01.000Z",
        event: "delivery-pending",
        delivery: wrongDelivery,
      }),
    ];
    let diagnostics: Array<{ code: string; message: string }> = [];

    const replayed = replayRegistryEntries(entries, "root", (reported) => {
      diagnostics = reported;
    });

    expect(replayed.agents).toEqual([]);
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "invalid-checkpoint",
      "invalid-delivery-identity",
    ]);
    expect(diagnostics[1]?.message).toContain("result agent_id");
  });

  it("rejects duplicate, unsafe, and non-monotonic delivery sequences", () => {
    const agent = persistedAgent();
    const terminal = (turnId: string, sequence: number): PersistedDelivery => ({
      source_agent_id: "child",
      source_turn_id: turnId,
      destination_agent_id: "root",
      path: "wait",
      settled: false,
      sequence,
      result: completedResult("child", turnId),
    });
    const snapshot = {
      agents: [agent],
      tombstones: [],
      deliveries: [terminal("child:one", 2), terminal("child:two", 2)],
      coordination_deliveries: [],
      wait_claimed_turns: [],
      next_delivery_sequence: Number.MAX_SAFE_INTEGER + 1,
    };
    let diagnosticCodes: string[] = [];

    replayRegistryEntries(
      [
        customEntry({
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:00.000Z",
          event: "checkpoint",
          snapshot,
        }),
      ],
      "root",
      (diagnostics) => {
        diagnosticCodes = diagnostics.map(({ code }) => code);
      },
    );

    expect(diagnosticCodes).toEqual(["invalid-delivery-sequence"]);
  });

  it("accepts gaps after malformed deliveries while requiring unique increasing new sequences and stable updates", () => {
    const terminal = (
      turnId: string,
      sequence: number,
      destinationAgentId = "root",
      path: "wait" | "message" = "wait",
    ): PersistedDelivery => ({
      source_agent_id: "child",
      source_turn_id: turnId,
      destination_agent_id: destinationAgentId,
      path,
      settled: false,
      sequence,
      result: completedResult("child", turnId),
    });
    const coordination = (
      messageId: string,
      sequence: number,
      path: "wait" | "message" = "message",
    ) => ({
      delivery_id: `message:${messageId}`,
      sequence,
      destination_agent_id: "root",
      path,
      settled: false,
      message: {
        customType: "minimal-subagents.message" as const,
        content: messageId,
        details: {
          source_agent_id: "child",
          destination_agent_id: "root",
          source_turn_id: "child:message",
          message_id: messageId,
          delivery_id: `message:${messageId}`,
        },
      },
    });
    const entries = [
      customEntry(createRegistryEvent("root", "agent-created", { agent: persistedAgent() })),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:malformed", 1, "wrong-parent"),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:kept", 3),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:kept", 3, "root", "message"),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:duplicate", 3),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:changed-update", 4),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:changed-update", 5, "root", "message"),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:later-gap", 7),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "coordination-delivery-pending", {
          delivery: coordination("cross-kind-duplicate", 7),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "coordination-delivery-pending", {
          delivery: coordination("kept-message", 9),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "coordination-delivery-pending", {
          delivery: coordination("kept-message", 9, "wait"),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "coordination-delivery-pending", {
          delivery: coordination("kept-message", 10),
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-pending", {
          delivery: terminal("child:skipped-tail", 11, "wrong-parent"),
        }),
      ),
    ];
    let diagnostics: Array<{ code: string }> = [];

    const replayed = replayRegistryEntries(entries, "root", (reported) => {
      diagnostics = reported;
    });

    expect(replayed.deliveries).toMatchObject([
      { source_turn_id: "child:kept", sequence: 3, path: "message" },
      { source_turn_id: "child:changed-update", sequence: 4, path: "wait" },
      { source_turn_id: "child:later-gap", sequence: 7, path: "wait" },
    ]);
    expect(replayed.coordination_deliveries).toMatchObject([
      { delivery_id: "message:kept-message", sequence: 9, path: "wait" },
    ]);
    expect(replayed.next_delivery_sequence).toBe(12);
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "invalid-delivery-adjacency",
      "invalid-delivery-sequence",
      "invalid-delivery-sequence",
      "invalid-delivery-sequence",
      "invalid-delivery-sequence",
      "invalid-delivery-adjacency",
    ]);
  });

  it("replays terminal retention without releasing a turn that still owns a Coordination Message", () => {
    const agent = persistedAgent();
    const sourceTurnId = "child:retained-message";
    const coordination = {
      delivery_id: "message:keep-claim",
      sequence: 2,
      destination_agent_id: "root",
      path: "wait" as const,
      settled: false,
      message: {
        customType: "minimal-subagents.message" as const,
        content: "still pending",
        details: {
          source_agent_id: "child",
          destination_agent_id: "root",
          source_turn_id: sourceTurnId,
          message_id: "keep-claim",
          delivery_id: "message:keep-claim",
        },
      },
    };
    const checkpoint = createRegistryEvent("root", "checkpoint", {
      snapshot: {
        agents: [agent],
        tombstones: [],
        deliveries: [
          {
            source_agent_id: "child",
            source_turn_id: sourceTurnId,
            destination_agent_id: "root",
            path: "wait",
            settled: false,
            sequence: 1,
            result: completedResult("child", sourceTurnId),
          },
        ],
        coordination_deliveries: [coordination],
        wait_claimed_turns: [`child\u0000${sourceTurnId}`],
        next_delivery_sequence: 3,
      },
    });
    const prune = createRegistryEvent("root", "delivery-pruned", {
      source_agent_id: "child",
      source_turn_id: sourceTurnId,
      reason: "retention-limit",
    });

    const replayed = replayRegistryEntries([customEntry(checkpoint), customEntry(prune)], "root");
    expect(replayed.deliveries).toEqual([]);
    expect(replayed.coordination_deliveries).toHaveLength(1);
    expect(replayed.wait_claimed_turns).toEqual([`child\u0000${sourceTurnId}`]);
  });

  it("enforces direct-parent terminal destinations and adjacent Coordination Message endpoints", () => {
    const parent = persistedAgent("parent");
    const child = { ...persistedAgent("parent.child"), parent_id: "parent" };
    const unrelated = persistedAgent("unrelated");
    const invalidCoordination = {
      delivery_id: "message:bad",
      sequence: 1,
      destination_agent_id: "unrelated",
      path: "message" as const,
      settled: false,
      message: {
        customType: "minimal-subagents.message" as const,
        content: "not adjacent",
        details: {
          source_agent_id: "parent.child",
          destination_agent_id: "unrelated",
          source_turn_id: "parent.child:turn",
          message_id: "bad",
          delivery_id: "message:bad",
        },
      },
    };
    let diagnosticCodes: string[] = [];

    replayRegistryEntries(
      [
        customEntry(createRegistryEvent("root", "agent-created", { agent: parent })),
        customEntry(createRegistryEvent("root", "agent-created", { agent: child })),
        customEntry(createRegistryEvent("root", "agent-created", { agent: unrelated })),
        customEntry({
          version: 2,
          root_session_id: "root",
          timestamp: "2026-01-01T00:00:01.000Z",
          event: "coordination-delivery-pending",
          delivery: invalidCoordination,
        }),
      ],
      "root",
      (diagnostics) => {
        diagnosticCodes = diagnostics.map(({ code }) => code);
      },
    );

    expect(diagnosticCodes).toContain("invalid-delivery-adjacency");
  });

  it("prunes deleted message endpoints so the emitted checkpoint remains replayable", () => {
    const parent = persistedAgent("team");
    const child = { ...persistedAgent("team.child"), parent_id: "team" };
    const peer = { ...persistedAgent("team.peer"), parent_id: "team" };
    parent.recent_messages = [
      { source_agent_id: "root", turn_id: "root:kept", content: "keep" },
      { source_agent_id: "team.child", turn_id: "team.child:old", content: "remove" },
    ];
    peer.recent_messages = [
      { source_agent_id: "team.child", turn_id: "team.child:old", content: "remove sibling" },
    ];
    const checkpoint = createRegistryEvent("root", "checkpoint", {
      snapshot: { agents: [parent, child, peer], tombstones: [], deliveries: [] },
    });
    const deletion = createRegistryEvent("root", "agent-deleted", {
      agent_ids: ["team.child"],
    });

    const replayed = replayRegistryEntries(
      [customEntry(checkpoint), customEntry(deletion)],
      "root",
    );
    expect(replayed.agents).toMatchObject([
      { agent_id: "team", recent_messages: [{ content: "keep" }] },
      { agent_id: "team.peer", recent_messages: [] },
    ]);

    let diagnostics: RegistryReplayDiagnostic[] = [];
    const roundTripped = replayRegistryEntries(
      [customEntry(createRegistryEvent("root", "checkpoint", { snapshot: replayed }))],
      "root",
      (reported) => {
        diagnostics = reported;
      },
    );
    expect(diagnostics).toEqual([]);
    expect(roundTripped).toEqual(replayed);
  });

  it("requires canonical live complete subtrees for deletion", () => {
    expect(
      parseRegistryEvent(createRegistryEvent("root", "agent-deleted", { agent_ids: [] }), "root"),
    ).toBeUndefined();
    expect(
      parseRegistryEvent(
        createRegistryEvent("root", "agent-deleted", { agent_ids: ["root"] }),
        "root",
      ),
    ).toBeUndefined();
    expect(
      parseRegistryEvent(
        createRegistryEvent("root", "agent-deleted", { agent_ids: ["bad.id!"] }),
        "root",
      ),
    ).toBeUndefined();

    const parent = persistedAgent("team");
    const child = { ...persistedAgent("team.child"), parent_id: "team" };
    let diagnosticCodes: string[] = [];
    const replayed = replayRegistryEntries(
      [
        customEntry(createRegistryEvent("root", "agent-created", { agent: parent })),
        customEntry(createRegistryEvent("root", "agent-created", { agent: child })),
        customEntry(createRegistryEvent("root", "agent-deleted", { agent_ids: ["unknown"] })),
        customEntry(createRegistryEvent("root", "agent-deleted", { agent_ids: ["team"] })),
        customEntry(
          createRegistryEvent("root", "agent-deleted", {
            agent_ids: ["team.child", "team"],
          }),
        ),
      ],
      "root",
      (diagnostics) => {
        diagnosticCodes = diagnostics.map(({ code }) => code);
      },
    );

    expect(diagnosticCodes).toEqual(["invalid-event-reference", "invalid-agent-hierarchy"]);
    expect(replayed.agents).toEqual([]);
    expect(replayed.tombstones).toEqual(["team.child", "team"]);
  });

  it("claims only observable live turns and releases only existing claims", () => {
    const agent = persistedAgent();
    const entries = [
      customEntry(createRegistryEvent("root", "agent-created", { agent })),
      customEntry(
        createRegistryEvent("root", "turn-started", {
          agent_id: "child",
          turn_id: "child:active",
          started_at: "2026-01-01T00:00:01.000Z",
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-turn-claimed", {
          source_agent_id: "child",
          source_turn_id: "child:active",
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-turn-claimed", {
          source_agent_id: "child",
          source_turn_id: "child:active",
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-turn-released", {
          source_agent_id: "child",
          source_turn_id: "child:active",
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-turn-released", {
          source_agent_id: "child",
          source_turn_id: "child:active",
        }),
      ),
      customEntry(
        createRegistryEvent("root", "delivery-turn-claimed", {
          source_agent_id: "child",
          source_turn_id: "child:orphan",
        }),
      ),
    ];
    let diagnostics: Array<{ code: string }> = [];

    const replayed = replayRegistryEntries(entries, "root", (reported) => {
      diagnostics = reported;
    });

    expect(replayed.wait_claimed_turns).toBeUndefined();
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "invalid-event-reference",
      "invalid-event-reference",
      "invalid-event-reference",
    ]);

    const orphanClaim = createRegistryEvent("root", "checkpoint", {
      snapshot: {
        agents: [agent],
        tombstones: [],
        deliveries: [],
        coordination_deliveries: [],
        wait_claimed_turns: ["child\u0000child:orphan"],
        next_delivery_sequence: 1,
      },
    });
    expect(parseRegistryEvent(orphanClaim, "root")).toBeUndefined();
  });

  it("never throws while parsing arbitrary JSON values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const serializedValue: JsonValue = JSON.parse(JSON.stringify(value));
        expect(() => parseRegistryEvent(serializedValue, "root")).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });

  it("replays settlement and message activity projections", () => {
    const entries = [
      customEntry(createRegistryEvent("root", "agent-created", { agent: persistedAgent() })),
      customEntry(
        createRegistryEvent("root", "turn-started", {
          agent_id: "child",
          turn_id: "child:turn-1",
          started_at: "2026-01-01T00:00:01.000Z",
        }),
      ),
      customEntry(
        createRegistryEvent(
          "root",
          "turn-settled",
          {
            result: completedResult("child", "child:turn-1"),
          },
          "2026-01-01T00:00:02.000Z",
        ),
      ),
      customEntry(
        createRegistryEvent(
          "root",
          "agent-message-recorded",
          {
            agent_id: "child",
            message: { source_agent_id: "root", turn_id: "root:turn", content: "follow up" },
            recorded_at: "2026-01-01T00:00:03.000Z",
          },
          "2026-01-01T00:00:04.000Z",
        ),
      ),
    ];

    expect(replayRegistryEntries(entries, "root").agents[0]).toMatchObject({
      latest_activity_at: "2026-01-01T00:00:03.000Z",
      recent_messages: [{ content: "follow up" }],
    });
  });
});
