import { describe, expect, it } from "vitest";
import {
  completeSubagentsCommandArguments,
  parseSubagentsCommandArguments,
} from "../src/minimal-subagents-command.js";

describe("/subagents command grammar", () => {
  it.each([
    ["", { action: "status" }],
    ["status", { action: "status" }],
    ["enable", { action: "enable", scope: "session" }],
    ["disable", { action: "disable", scope: "session" }],
    ["reset", { action: "reset", scope: "session" }],
    ["enable --global", { action: "enable", scope: "global" }],
    ["disable --project", { action: "disable", scope: "project" }],
    ["reset --global", { action: "reset", scope: "global" }],
  ] as const)("parses %j", (input, expected) => {
    expect(parseSubagentsCommandArguments(input)).toEqual({ ok: true, command: expected });
  });

  it.each([
    "status --global",
    "enable --global --project",
    "disable --global --global",
    "reset later",
    "unknown",
    "--global",
  ])("rejects %j without guessing", (input) => {
    expect(parseSubagentsCommandArguments(input)).toEqual({
      ok: false,
      message: "Usage: /subagents [status | enable|disable|reset [--global|--project]]",
    });
  });

  it("completes only valid full command tails", () => {
    expect(completeSubagentsCommandArguments("d")).toEqual([
      { value: "disable", label: "disable", description: "Disable for this branch" },
      {
        value: "disable --global",
        label: "disable --global",
        description: "Disable by default globally",
      },
      {
        value: "disable --project",
        label: "disable --project",
        description: "Disable by default for this project",
      },
    ]);
    expect(completeSubagentsCommandArguments("status ")).toEqual([]);
  });
});
