import { describe, expect, it } from "vitest";
import {
  addCoordinationDelivery,
  addTerminalDelivery,
  claimDeliveryLedgerTurn,
  createDeliveryLedger,
  deliveryLedgerSnapshot,
  deliveryTurnKey,
  pruneDeliveryLedgerAgents,
  selectObservableDeliveryTurn,
  settleCoordinationDelivery,
  settleTerminalDelivery,
} from "../src/minimal-subagents-delivery-ledger.js";
import type { CoordinatorMessage, TurnResult } from "../src/minimal-subagents-types.js";

function completedResult(agentId: string, turnId: string): TurnResult {
  return {
    agent_id: agentId,
    turn_id: turnId,
    status: "completed",
    output: turnId,
  };
}

function coordinationMessage(
  sourceAgentId: string,
  sourceTurnId: string,
  messageId: string,
  destinationAgentId = "root",
): CoordinatorMessage {
  return {
    customType: "minimal-subagents.message",
    content: messageId,
    details: {
      source_agent_id: sourceAgentId,
      destination_agent_id: destinationAgentId,
      source_turn_id: sourceTurnId,
      message_id: messageId,
      delivery_id: `message:${messageId}`,
    },
  };
}

describe("minimal subagents delivery ledger", () => {
  it("allocates one monotonic sequence across terminal and coordination items", () => {
    let ledger = createDeliveryLedger();
    const first = addCoordinationDelivery(ledger, {
      destinationAgentId: "root",
      message: coordinationMessage("child", "child:turn-1", "one"),
    });
    ledger = first.ledger;
    const second = addTerminalDelivery(ledger, {
      destinationAgentId: "root",
      path: "message",
      result: completedResult("child", "child:turn-1"),
    });

    expect(first.delivery.sequence).toBe(1);
    expect(second.delivery.sequence).toBe(2);
    expect(deliveryLedgerSnapshot(second.ledger).next_delivery_sequence).toBe(3);
  });

  it("returns immutable transitions without mutating prior ledger values or caller messages", () => {
    const original = createDeliveryLedger();
    const message = coordinationMessage("child", "child:turn", "immutable");
    const added = addCoordinationDelivery(original, {
      destinationAgentId: "root",
      message,
    });
    message.content = "caller mutation";
    const settled = settleCoordinationDelivery(added.ledger, "message:immutable");

    expect(deliveryLedgerSnapshot(original).coordination_deliveries).toEqual([]);
    expect(deliveryLedgerSnapshot(added.ledger).coordination_deliveries[0]?.message.content).toBe(
      "immutable",
    );
    expect(deliveryLedgerSnapshot(settled.ledger).coordination_deliveries).toEqual([]);
    expect(deliveryLedgerSnapshot(added.ledger).coordination_deliveries).toHaveLength(1);
  });

  it("skips claimed turns and selects the oldest unclaimed observable turn", () => {
    let ledger = createDeliveryLedger();
    for (const turnId of ["child:claimed", "child:older", "child:newer"]) {
      ledger = addTerminalDelivery(ledger, {
        destinationAgentId: "root",
        path: "message",
        result: completedResult("child", turnId),
      }).ledger;
    }
    ledger = claimDeliveryLedgerTurn(ledger, "child", "child:claimed").ledger;

    expect(
      selectObservableDeliveryTurn(ledger, {
        sourceAgentId: "child",
        destinationAgentId: "root",
        waitHandedDeliveryIds: new Set(),
        activeTurnId: "child:active",
      }),
    ).toBe("child:older");
  });

  it("skips a claimed turn even when a Coordination Message for it is still pending", () => {
    let ledger = addCoordinationDelivery(createDeliveryLedger(), {
      destinationAgentId: "root",
      message: coordinationMessage("child", "child:claimed", "leftover"),
    }).ledger;
    ledger = claimDeliveryLedgerTurn(ledger, "child", "child:claimed").ledger;
    const options = {
      sourceAgentId: "child",
      destinationAgentId: "root",
      waitHandedDeliveryIds: new Set<string>(),
    };

    // Only an explicit turn_id reaches the claimed turn's leftover message.
    expect(selectObservableDeliveryTurn(ledger, { ...options, activeTurnId: "child:active" })).toBe(
      "child:active",
    );
    ledger = addTerminalDelivery(ledger, {
      destinationAgentId: "root",
      path: "message",
      result: completedResult("child", "child:unclaimed"),
    }).ledger;
    expect(selectObservableDeliveryTurn(ledger, options)).toBe("child:unclaimed");
  });

  it("skips a turn whose result was already handed to the destination automatically", () => {
    let ledger = createDeliveryLedger();
    for (const turnId of ["child:handed", "child:pending"]) {
      ledger = addTerminalDelivery(ledger, {
        destinationAgentId: "root",
        path: "message",
        result: completedResult("child", turnId),
      }).ledger;
    }

    expect(
      selectObservableDeliveryTurn(ledger, {
        sourceAgentId: "child",
        destinationAgentId: "root",
        waitHandedDeliveryIds: new Set(),
        handedTurnKeys: new Set([deliveryTurnKey("child", "child:handed")]),
        activeTurnId: "child:active",
      }),
    ).toBe("child:pending");
  });

  it("falls back to the active, then latest, turn when every retained turn is claimed", () => {
    let ledger = addTerminalDelivery(createDeliveryLedger(), {
      destinationAgentId: "root",
      path: "wait",
      result: completedResult("child", "child:claimed"),
    }).ledger;
    ledger = claimDeliveryLedgerTurn(ledger, "child", "child:claimed").ledger;
    const options = {
      sourceAgentId: "child",
      destinationAgentId: "root",
      waitHandedDeliveryIds: new Set<string>(),
    };

    expect(
      selectObservableDeliveryTurn(ledger, {
        ...options,
        activeTurnId: "child:active",
        latestResultTurnId: "child:claimed",
      }),
    ).toBe("child:active");
    expect(
      selectObservableDeliveryTurn(ledger, { ...options, latestResultTurnId: "child:latest" }),
    ).toBe("child:latest");
  });

  it("retains only the newest 20 wait-only terminal items per source without pruning messages", () => {
    let ledger = createDeliveryLedger();
    const coordination = addCoordinationDelivery(ledger, {
      destinationAgentId: "root",
      message: coordinationMessage("child", "child:turn-0", "keep-message"),
    });
    ledger = claimDeliveryLedgerTurn(coordination.ledger, "child", "child:still-active").ledger;
    for (let index = 1; index <= 21; index++) {
      const turnId = `child:turn-${index}`;
      ledger = claimDeliveryLedgerTurn(ledger, "child", turnId).ledger;
      ledger = addTerminalDelivery(ledger, {
        destinationAgentId: "root",
        path: "wait",
        result: completedResult("child", turnId),
      }).ledger;
    }

    const snapshot = deliveryLedgerSnapshot(ledger);
    expect(snapshot.deliveries).toHaveLength(20);
    expect(snapshot.deliveries.map((delivery) => delivery.source_turn_id)).not.toContain(
      "child:turn-1",
    );
    expect(snapshot.coordination_deliveries).toHaveLength(1);
    expect(snapshot.coordination_deliveries?.[0]?.delivery_id).toBe("message:keep-message");
    expect(snapshot.wait_claimed_turns).not.toContain("child\u0000child:turn-1");
    expect(snapshot.wait_claimed_turns).toContain("child\u0000child:still-active");
  });

  it("settles keyed items and prunes source or destination subtrees without collateral loss", () => {
    let ledger = createDeliveryLedger();
    const terminal = addTerminalDelivery(ledger, {
      destinationAgentId: "root",
      path: "wait",
      result: completedResult("parent.child", "parent.child:turn"),
    });
    ledger = terminal.ledger;
    const message = addCoordinationDelivery(ledger, {
      destinationAgentId: "sibling",
      message: coordinationMessage("parent.child", "parent.child:turn", "nested", "sibling"),
    });
    ledger = claimDeliveryLedgerTurn(message.ledger, "parent.child", "parent.child:turn").ledger;

    ledger = settleTerminalDelivery(ledger, "parent.child", "parent.child:turn").ledger;
    expect(deliveryLedgerSnapshot(ledger).coordination_deliveries).toHaveLength(1);
    ledger = settleCoordinationDelivery(ledger, "message:nested").ledger;
    expect(deliveryLedgerSnapshot(ledger).wait_claimed_turns).toEqual([
      "parent.child\u0000parent.child:turn",
    ]);

    const other = addTerminalDelivery(ledger, {
      destinationAgentId: "root",
      path: "message",
      result: completedResult("other", "other:turn"),
    });
    ledger = pruneDeliveryLedgerAgents(other.ledger, ["parent"]).ledger;
    expect(deliveryLedgerSnapshot(ledger).deliveries.map((item) => item.source_agent_id)).toEqual([
      "other",
    ]);
    expect(deliveryLedgerSnapshot(ledger).wait_claimed_turns).toEqual([]);
  });
});
