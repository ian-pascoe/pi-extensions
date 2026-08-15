import { describe, expect, it } from "vitest";
import {
  addCoordinatorMessageEnvelope,
  stripCoordinatorMessageEnvelope,
} from "../src/minimal-subagents-message-envelope.js";
import {
  renderMinimalSubagentsMessage,
  renderMinimalSubagentsResult,
  type MinimalSubagentsRenderTheme,
} from "../src/minimal-subagents-rendering.js";

const plainTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
} satisfies MinimalSubagentsRenderTheme;

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

  it("strips the envelope from collapsed and expanded TUI message bodies", () => {
    const message = addCoordinatorMessageEnvelope({
      customType: "minimal-subagents.message",
      content: "please provide the paths",
      details: {
        source_agent_id: "explore",
        destination_agent_id: "root",
        source_turn_id: "explore:turn-7",
        message_id: "message-7",
      },
    });
    const options = { outputPad: 0, expanded: false };
    const collapsed = renderMinimalSubagentsMessage(message, options, plainTheme)
      .render(200)
      .join("\n");
    const expanded = renderMinimalSubagentsResult(
      message,
      { ...options, expanded: true },
      plainTheme,
    )
      .render(200)
      .join("\n");

    expect(collapsed).not.toContain("[Subagent message");
    expect(collapsed).toContain("turn explore:turn-7");
    expect(collapsed).toContain("please provide the paths");
    expect(expanded).not.toContain("[Subagent message");
    expect(expanded).toContain("Source turn: explore:turn-7");
  });
});
