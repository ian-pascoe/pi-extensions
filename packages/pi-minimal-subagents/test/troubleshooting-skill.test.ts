import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TROUBLESHOOTING_HINT,
  TROUBLESHOOTING_SKILL_PATH,
  withTroubleshootingHint,
} from "../src/troubleshooting-skill.js";

describe("troubleshooting Skill hint", () => {
  it("points at the packaged, user-invoked Skill on disk", () => {
    expect(existsSync(TROUBLESHOOTING_SKILL_PATH)).toBe(true);
    expect(readFileSync(TROUBLESHOOTING_SKILL_PATH, "utf8")).toContain(
      "name: pi-minimal-subagents",
    );
    expect(TROUBLESHOOTING_HINT).toContain(TROUBLESHOOTING_SKILL_PATH);
  });

  it("appends the hint as its own paragraph", () => {
    expect(withTroubleshootingHint("boom")).toBe(`boom\n\n${TROUBLESHOOTING_HINT}`);
  });
});
