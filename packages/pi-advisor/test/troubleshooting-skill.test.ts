import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { TROUBLESHOOTING_HINT, TROUBLESHOOTING_SKILL_PATH } from "../src/troubleshooting-skill.js";

it("points at the shipped troubleshooting Skill", () => {
  expect(existsSync(TROUBLESHOOTING_SKILL_PATH)).toBe(true);
  expect(TROUBLESHOOTING_HINT).toContain(TROUBLESHOOTING_SKILL_PATH);
});
