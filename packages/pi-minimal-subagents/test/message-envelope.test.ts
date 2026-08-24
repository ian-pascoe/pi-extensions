import { describe, expect, it } from "vitest";
import {
  addCoordinatorMessageEnvelope,
  stripCoordinatorMessageEnvelope,
} from "../src/minimal-subagents-message-envelope.js";

describe("minimal subagents message envelope", () => {
  it("keeps source identity model-visible while removing the duplicate TUI prefix", () => {
    const message = addCoordinatorMessageEnvelope({
      customType: "minimal-subagents.result",
      content: "reviewed the sessions",
      details: {
        source_agent_id: "explore-minimal-subagents",
        destination_agent_id: "root",
        source_turn_id: "explore-minimal-subagents:turn-42",
        message_id: "result:42",
        status: "completed",
      },
    });

    expect(message.content).toContain(
      "[Subagent result | agent=explore-minimal-subagents | turn=explore-minimal-subagents:turn-42 | status=completed]",
    );
    expect(stripCoordinatorMessageEnvelope(message.content)).toBe("reviewed the sessions");
  });
});
