import { describe, expect, it } from "vite-plus/test";
import {
  completeSubagentsCommandArguments,
  parseSubagentsCommandArguments,
} from "../src/minimal-subagents-command.js";

describe("/subagents command grammar", () => {
  it.each([
    ["", { action: "status" }],
    ["status", { action: "status" }],
    ["enable", { action: "enable", scope: "session" }],
    ["disable --project", { action: "disable", scope: "project" }],
    ["reset --global", { action: "reset", scope: "global" }],
  ] as const)("parses %j", (input, expected) => {
    expect(parseSubagentsCommandArguments(input)).toEqual({ ok: true, command: expected });
  });

  it.each(["enable --global --project", "reset later", "unknown"])(
    "rejects %j without guessing",
    (input) => {
      expect(parseSubagentsCommandArguments(input)).toEqual({
        ok: false,
        message: "Usage: /subagents [status | enable|disable|reset [--global|--project]]",
      });
    },
  );

  it("completes only valid full command tails", () => {
    expect(completeSubagentsCommandArguments("d").map((item) => item.value)).toEqual([
      "disable",
      "disable --global",
      "disable --project",
    ]);
    expect(completeSubagentsCommandArguments("status ")).toEqual([]);
  });
});
