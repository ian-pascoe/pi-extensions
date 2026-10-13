import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  AGENT_LINEAGE_ENTRY_TYPE,
  agentLineageRecord,
  readAgentLineage,
} from "../src/agent-lineage.js";

function childSession() {
  const manager = SessionManager.inMemory();
  const lineage = {
    sessionId: manager.getSessionId(),
    rootSessionId: "root-session",
    agentId: "explorer",
    parentAgentId: null,
  };
  return { manager, lineage };
}

describe("Agent Lineage Record", () => {
  it("round-trips a child's lineage through its own session", () => {
    const { manager, lineage } = childSession();
    manager.appendCustomEntry(AGENT_LINEAGE_ENTRY_TYPE, agentLineageRecord(lineage));
    expect(readAgentLineage(manager.getSessionId(), manager.getBranch())).toEqual(lineage);
  });

  it("names a nested child's parent agent", () => {
    const { manager, lineage } = childSession();
    const nested = { ...lineage, agentId: "explorer.reader", parentAgentId: "explorer" };
    manager.appendCustomEntry(AGENT_LINEAGE_ENTRY_TYPE, agentLineageRecord(nested));
    expect(readAgentLineage(manager.getSessionId(), manager.getBranch())).toEqual(nested);
  });

  it("a session without a record has no lineage", () => {
    const { manager } = childSession();
    manager.appendCustomEntry("unrelated", { sessionId: manager.getSessionId() });
    expect(readAgentLineage(manager.getSessionId(), manager.getBranch())).toBeUndefined();
  });

  it("ignores a record copied from another session, as a fork clone inherits it", () => {
    const { manager, lineage } = childSession();
    manager.appendCustomEntry(
      AGENT_LINEAGE_ENTRY_TYPE,
      agentLineageRecord({ ...lineage, sessionId: "source-child-session" }),
    );
    expect(readAgentLineage(manager.getSessionId(), manager.getBranch())).toBeUndefined();
  });

  it("the latest valid record for this session wins", () => {
    const { manager, lineage } = childSession();
    manager.appendCustomEntry(AGENT_LINEAGE_ENTRY_TYPE, agentLineageRecord(lineage));
    const adopted = { ...lineage, rootSessionId: "fork-destination-root" };
    manager.appendCustomEntry(AGENT_LINEAGE_ENTRY_TYPE, agentLineageRecord(adopted));
    manager.appendCustomEntry(AGENT_LINEAGE_ENTRY_TYPE, { version: 2, ...adopted, agentId: "x" });
    manager.appendCustomEntry(AGENT_LINEAGE_ENTRY_TYPE, { version: 1, agentId: "malformed" });
    expect(readAgentLineage(manager.getSessionId(), manager.getBranch())).toEqual(adopted);
  });

  it("refuses to build a malformed record", () => {
    const { lineage } = childSession();
    expect(() => agentLineageRecord({ ...lineage, agentId: "" })).toThrow(/Agent Lineage/);
  });
});
